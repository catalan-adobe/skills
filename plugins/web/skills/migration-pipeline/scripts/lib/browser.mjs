// The browser and the proxy, as the pipeline drives them: playwright-cli in a session of
// its own, the page-cache proxy as a child process, the paths from setup. Every external
// call goes through an injectable `io` so the loops can be tested without a browser.
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { readSetupJson } from './setup.mjs';

/** A free port from `from` upward, held on no interface. */
export async function freePort(from = 3001) {
  const tryPort = (port) => new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, () => s.close(() => resolve(true)));
  });
  for (let port = from; port < from + 1000; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await tryPort(port)) return port;
  }
  throw new Error(`no free port from ${from}`);
}

export const defaultIo = {
  execFile: promisify(execFile),
  spawn,
  fetch: (...args) => fetch(...args),
  freePort,
  sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }),
  killDelayMs: 3000,
  now: () => new Date(),
  execPath: process.execPath,
};

/** A playwright-cli session name of this project's own, so nothing else is disturbed. */
export const sessionName = (cwd, kind) => (
  `${kind}-${createHash('sha256').update(cwd).digest('hex').slice(0, 8)}`);

/**
 * The page-cache proxy script, the page-tree bundle and the playwright-cli binary, as
 * setup recorded them.
 */
export async function tools(cwd) {
  const setup = await readSetupJson(cwd);
  if (!setup) throw new Error('no migration/.work/setup.json; run pipeline setup --install');
  const script = (name, file) => {
    const skill = setup.skills?.[name]?.path;
    if (!skill) throw new Error(`setup lacks the ${name} skill; run pipeline setup --install`);
    return path.join(path.dirname(skill), 'scripts', file);
  };
  const cli = setup.playwrightCli?.path;
  if (!cli) throw new Error('setup lacks playwright-cli; run pipeline setup --install');
  return {
    proxyScript: script('page-cache', 'page-cache.js'),
    treeBundle: script('page-tree', 'page-tree-bundle.js'),
    cli,
  };
}

/** Where the cache lives: the proxy's own layout under migration/cache/. */
export const cacheDir = (cwd) => path.join(cwd, 'migration', 'cache');

/**
 * Starts the proxy on a free port and waits for `/__status`; a child that exits first
 * is reported with its stderr; `stop` sends SIGTERM, then SIGKILL after a delay. `also`:
 * the other origins whose assets the proxy stores and serves (the migration's
 * `source.assetOrigins`).
 */
export function proxyStarter(script, dir, io = defaultIo, { also = [] } = {}) {
  return async ({ offline }) => {
    const port = await io.freePort(3001);
    const args = [script, '--port', String(port), '--cache', dir,
      ...(offline ? ['--offline'] : []), ...(also.length ? ['--also', also.join(',')] : [])];
    const child = io.spawn(io.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const stop = () => new Promise((resolve) => {
      let finished = false;
      const finish = () => { if (!finished) { finished = true; resolve(); } };
      child.once('exit', finish);
      child.kill('SIGTERM');
      io.sleep(io.killDelayMs ?? 3000).then(() => {
        if (!finished) child.kill('SIGKILL');
        finish();
      });
    });
    let up = false;
    for (let i = 0; i < 50 && !up; i += 1) {
      if (child.exitCode !== null) throw new Error(`proxy exited: ${stderr.trim()}`);
      // eslint-disable-next-line no-await-in-loop
      const status = await io.fetch(`http://127.0.0.1:${port}/__status`)
        .then((r) => (r.ok ? r.json() : null), () => null);
      if (status && status.dir && path.resolve(status.dir) !== path.resolve(dir)) {
        // eslint-disable-next-line no-await-in-loop
        await stop();
        throw new Error(`port ${port} is held by another cache proxy (${status.dir})`);
      }
      up = Boolean(status);
      // eslint-disable-next-line no-await-in-loop
      if (!up) await io.sleep(100);
    }
    if (!up) {
      await stop();
      throw new Error(`proxy did not answer on port ${port} within 5 s`);
    }
    return { port, stop };
  };
}

/** The proxy URL that fetches (or, offline, serves) `url`. */
export function viaProxy(url, origin, port) {
  const u = new URL(url);
  return `http://127.0.0.1:${port}${u.pathname}${u.search}`
    + `${u.search ? '&' : '?'}_origin=${encodeURIComponent(origin)}`;
}

/** The text playwright-cli printed for an eval: between `### Result` and `### Ran`. */
export function evalResult(stdout) {
  const match = /### Result\s*\n([\s\S]*?)\n### Ran/.exec(stdout);
  return (match ? match[1] : stdout).trim();
}

/** The value of an eval: JSON-encoded by the CLI, and once more when ours returned JSON. */
export function parseEval(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/** The line worth reporting from a failed CLI call: the error, not the update banner. */
export function cliError(err, command) {
  const lines = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.split('\n')
    .map((l) => l.trim()).filter((l) => l && !/^(#|[║╔╚═])/.test(l));
  const reason = lines.find((l) => /error|fail|timeout|net::|refused/i.test(l)) ?? lines[0]
    ?? String(err.message).split('\n')[0];
  return new Error(`playwright-cli ${command}: ${reason}`);
}

/**
 * playwright-cli as the browser: one process per command, in a named session, run from
 * the project's `.work/` (the CLI writes its logs into its cwd).
 */
export function playwright(cli, { io = defaultIo, cwd, session }) {
  const run = (...args) => io.execFile(cli, [`-s=${session}`, ...args], {
    maxBuffer: 16 * 1024 * 1024, cwd,
  }).catch((err) => { throw cliError(err, `${args[0]} ${args.at(-1)}`); });
  return {
    open: (url, { config, persistent }) => run('open', '--config', config,
      ...(persistent ? ['--persistent'] : []), url),
    goto: (url) => run('goto', url),
    eval: async (expression) => evalResult((await run('eval', expression)).stdout),
    screenshot: (file, target, { type } = {}) => run('screenshot', ...(target ? [target] : []),
      '--filename', file, ...(type ? ['--type', type] : []), ...(target ? [] : ['--full-page'])),
    close: () => run('close'),
  };
}

/**
 * The playwright-cli config file for a step: the access recipe's config; with `onlyProxy`
 * (offline sessions) the proxy is the only allowed origin, so nothing leaves the machine;
 * with `initScript`, a script injected into every page (the visual-tree bundle).
 */
export async function writeBrowserConfig(cwd, kind, access, port, {
  initScript, onlyProxy = false,
} = {}) {
  const base = access.browser.config ?? { browser: { browserName: access.browser.engine } };
  const config = {
    ...base,
    browser: { ...base.browser, ...(initScript ? { initScript: [initScript] } : {}) },
    ...(onlyProxy ? { network: { allowedOrigins: [`http://127.0.0.1:${port}`] } } : {}),
  };
  const dir = path.join(cwd, 'migration', '.work', kind);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'browser-config.json');
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}
