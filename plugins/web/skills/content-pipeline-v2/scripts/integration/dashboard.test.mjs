// Contract with the real EDS local server (aem up) through status.mjs dashboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { dashboard, stopDashboard } from '../lib/dashboard.mjs';
import { freePort } from '../lib/ports.mjs';
import { init, resolveProject } from '../lib/project.mjs';
import { evalResult } from '../lib/warm-cli.mjs';
import { parseEval } from '../lib/warm.mjs';
import {
  execFileP, need, onPath, pw,
} from './helpers.mjs';

const git = (cwd, ...args) => execFileP('git', args, { cwd });

async function edsRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpv2-eds-'));
  await git(root, 'init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'index.txt'), 'x');
  await writeFile(path.join(root, '.hlxignore'), '.*\n');
  await git(root, 'add', '.');
  await git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  await git(root, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  return root;
}

test('dashboard: aem up serves tools/migration/ and the ignored migration/ on a free port',
  async (t) => {
    await need(t, 'aem (@adobe/aem-cli)', () => onPath('aem'));
    const root = await edsRepo();
    const project = resolveProject(root);
    await init({ origin: 'https://site.example/' }, project);
    const holder = createServer();
    const held = await freePort(3000);
    await new Promise((r) => holder.listen(held, r));
    try {
      const started = await dashboard(project, freePort);
      assert.notEqual(started.port, held, 'a held port is skipped');
      const page = await fetch(started.url);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Migration dashboard/);
      const ignored = await fetch(`http://localhost:${started.port}/migration/project.json`);
      assert.equal(ignored.status, 200, 'files under .hlxignore are still served locally');
      assert.equal((await ignored.json()).origin, 'https://site.example/');
      const again = await dashboard(project, freePort);
      assert.deepEqual([again.started, again.port], [false, started.port]);
      const stopped = await stopDashboard(project);
      assert.equal(stopped.stopped, true);
      await new Promise((r) => { setTimeout(r, 500); });
      assert.equal(await fetch(started.url).then(() => true, () => false), false, 'port freed');
    } finally {
      holder.close();
      await stopDashboard(project).catch(() => {});
    }
  });

test('dashboard: a folder that is not a git repository fails with the message', async (t) => {
  await need(t, 'aem (@adobe/aem-cli)', () => onPath('aem'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpv2-nogit-'));
  const project = resolveProject(root);
  await mkdir(project.dir, { recursive: true });
  await assert.rejects(dashboard(project, freePort), /aem up did not answer/);
});

test('the dashboard server does not live-reload the page when files change', async (t) => {
  await need(t, 'aem (@adobe/aem-cli)', () => onPath('aem'));
  const cli = await need(t, 'playwright-cli', () => onPath('playwright-cli'));
  const root = await edsRepo();
  const project = resolveProject(root);
  await init({ origin: 'https://site.example/' }, project);
  const served = await dashboard(project, freePort);
  const S = 'cpv2-test-dash-reload';
  try {
    const html = await fetch(served.url).then((r) => r.text());
    assert.ok(!/livereload/i.test(html), 'no live-reload script is injected');
    await pw(cli, S, 'open', served.url);
    await pw(cli, S, 'eval', 'window.__marker = "set"');
    await writeFile(path.join(project.dir, 'touch.json'), '{}');
    await new Promise((r) => { setTimeout(r, 2000); });
    const { stdout } = await pw(cli, S, 'eval', 'String(window.__marker)');
    assert.equal(parseEval(evalResult(stdout)), 'set', 'the page survived a file change');
  } finally {
    await pw(cli, S, 'close').catch(() => {});
    await stopDashboard(project);
  }
});
