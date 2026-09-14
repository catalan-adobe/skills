#!/usr/bin/env node
// The cache step as one process: proxy + browser + offline verification + cache.md.
// Usage: node warm.mjs [--pace <ms>]   (from the project root, after status.mjs approve cache)
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { resolveProject } from './lib/project.mjs';
import { warm } from './lib/warm.mjs';
import { freePort } from './status.mjs';

const execFileP = promisify(execFile);
const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function setupPaths(project) {
  const setup = JSON.parse(await readFile(project.setupFile, 'utf8').catch(() => {
    throw new Error(`No ${project.setupFile}; run status.mjs setup --install first`);
  }));
  const skill = setup.skills?.['page-cache']?.path;
  const cli = setup.playwrightCli?.path;
  if (!skill || !cli) throw new Error('setup.json lacks the page-cache skill or playwright-cli');
  return { proxyScript: path.join(path.dirname(skill), 'scripts', 'page-cache.js'), cli };
}

/** Starts the page-cache proxy as a child of this process and waits until it answers. */
function proxyStarter(script, cacheDir) {
  return async ({ offline }) => {
    const port = await freePort(3001);
    const args = [
      script, '--port', String(port), '--cache', cacheDir, ...(offline ? ['--offline'] : []),
    ];
    const child = spawn('node', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    for (let i = 0; i < 50; i += 1) {
      if (child.exitCode !== null) throw new Error(`proxy exited: ${stderr.trim()}`);
      const ok = await fetch(`http://127.0.0.1:${port}/__status`).then((r) => r.ok, () => false);
      if (ok) break;
      await sleep(100);
    }
    return {
      port,
      stop: () => new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000).unref();
      }),
    };
  };
}

/** playwright-cli as the browser: one persistent session, one process per command. */
function playwright(cli) {
  const run = (...args) => execFileP(cli, args, { maxBuffer: 16 * 1024 * 1024 });
  return {
    open: (url, { config, persistent }) => run('open', '--config', config,
      ...(persistent ? ['--persistent'] : []), url),
    goto: (url) => run('goto', url),
    eval: (expression) => run('eval', expression),
    close: () => run('close'),
  };
}

async function main(argv) {
  const project = resolveProject();
  const { proxyScript, cli } = await setupPaths(project);
  const cacheDir = path.join(project.step('cache'), '.page-cache');
  const result = await warm(project, {
    startProxy: proxyStarter(proxyScript, cacheDir),
    browser: playwright(cli),
    pace: Number(flag(argv, '--pace') ?? 1500),
  });
  if (!result.pass) process.exitCode = 1;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((out) => console.log(JSON.stringify(out, null, 2)))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
