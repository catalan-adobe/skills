// End to end without the internet: a fixture site, the real proxy and browser, the cache
// worker run in-process, the checks, and the dashboard rendered by aem up and playwright-cli.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dashboard, stopDashboard } from '../lib/dashboard.mjs';
import { readInventory } from '../lib/inventory.mjs';
import { readJobs } from '../lib/jobs.mjs';
import { freePort } from '../lib/ports.mjs';
import { init, resolveProject } from '../lib/project.mjs';
import { parseEval } from '../lib/warm.mjs';
import { evalResult, main, workerMain } from '../lib/warm-cli.mjs';
import { runCheck } from '../lib/checks.mjs';
import { approve, importList, status } from '../status.mjs';
import {
  execFileP, need, onPath, pageCacheScript, pw, startSite,
} from './helpers.mjs';

const git = (cwd, ...args) => execFileP('git', args, { cwd });
const S = 'cpv2-test-e2e';

test('fixture site → import → approve → cache → check → dashboard', async (t) => {
  const proxyScript = await need(t, 'page-cache (sibling skill)', pageCacheScript);
  const cli = await need(t, 'playwright-cli', () => onPath('playwright-cli'));
  await need(t, 'aem (@adobe/aem-cli)', () => onPath('aem'));
  const site = await startSite();
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpv2-e2e-'));
  await git(root, 'init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'index.txt'), 'x');
  await writeFile(path.join(root, '.hlxignore'), '.*\n');
  await git(root, 'add', '.');
  await git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  await git(root, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  const project = resolveProject(root);
  await init({ origin: `${site.origin}/` }, project);
  await writeFile(project.setupFile, JSON.stringify({
    skills: {
      'page-cache': { path: path.join(path.dirname(path.dirname(proxyScript)), 'SKILL.md') },
    },
    playwrightCli: { path: cli },
  }));
  await mkdir(project.step('probe'), { recursive: true });
  await writeFile(path.join(project.step('probe'), 'playwright-config.json'),
    JSON.stringify({ browser: { browserName: 'chromium', launchOptions: {} } }));
  await mkdir(project.step('prep'), { recursive: true });
  await writeFile(path.join(project.step('prep'), 'page-prep.json'), JSON.stringify({
    overlays: [{ selector: '#cmp', action: 'hide' }],
  }));

  const paths = ['/', '/a.html', '/b.html', '/old.html', '/missing.html', '/doc.pdf', '/jump.html'];
  const list = path.join(root, 'urls.txt');
  await writeFile(list, `${paths.map((p) => `${site.origin}${p}`).join('\n')}\n`);
  await importList(project, list);
  assert.equal((await readInventory(project.step('urls'))).length, paths.length);
  await approve('cache', ['all'], project);
  await status(project);

  const { defaultIo } = await import('../lib/warm-cli.mjs');
  const queued = await main(['--pace', '1200'], project, {
    ...defaultIo, spawn: () => ({ pid: process.pid, unref() {} }),
  });
  assert.deepEqual([queued.added, queued.job.total], [true, paths.length]);
  const served = await dashboard(project, freePort);
  try {
    const readDash = async () => {
      const { stdout } = await pw(cli, S, 'eval', `JSON.stringify({
        cache: [...document.querySelectorAll('#steps tbody tr')]
          .find((r) => r.textContent.includes('cache')).textContent.replace(/\\s+/g, ' ').trim(),
        cards: [...document.querySelectorAll('.card')]
          .map((c) => c.textContent.replace(/\\s+/g, ' ').trim()),
        live: document.querySelector('#live').textContent,
        redirects: document.querySelectorAll('#redirects tbody tr').length,
        notToMigrate: document.querySelectorAll('#not-to-migrate tbody tr').length,
      })`);
      return parseEval(evalResult(stdout));
    };
    await pw(cli, S, 'open', served.url);
    const working = workerMain(project, defaultIo);
    const samples = [];
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => { setTimeout(r, 2500); });
      samples.push(await readDash());
    }
    const summary = await working;
    assert.deepEqual(summary.map((s) => s.state), ['done']);
    const mid = samples.filter((s) => /running/.test(s.cache));
    assert.ok(mid.length >= 1, `the dashboard showed the job running: ${JSON.stringify(samples)}`);
    assert.ok(mid.some((s) => /\d\/7 \(all\)/.test(s.cache)), 'with its progress');
    assert.ok(mid.some((s) => /live · updated/.test(s.live)), 'and said it was live');
    const growth = samples.map((s) => Number((s.cards[1] ?? '').split(' ')[0]));
    assert.ok(growth.some((n, i) => i && n > growth[i - 1]),
      `the cached count grew during the job: ${growth}`);
    const job = (await readJobs(project)).at(-1);
    assert.deepEqual([job.state, job.done, job.failed], ['done', paths.length, 0]);

    const by = Object.fromEntries((await readInventory(project.step('urls'))).map((r) => [
      r.url.replace(site.origin, ''), r,
    ]));
    assert.equal(by['/'].kind, 'page');
    assert.equal(by['/a.html'].kind, 'page');
    assert.equal(by['/old.html'].kind, 'redirect');
    assert.deepEqual([by['/old.html'].redirect.status, by['/old.html'].redirect.targetInList],
      [301, true]);
    assert.equal(by['/old.html'].redirect.target, `${site.origin}/a.html`);
    assert.equal(by['/missing.html'].kind, 'error');
    assert.equal(by['/missing.html'].http.status, 404);
    assert.deepEqual([by['/doc.pdf'].kind, by['/doc.pdf'].migrate], ['binary', 'asset']);
    assert.equal(by['/jump.html'].kind, 'redirect', 'a client-side redirect, seen by the browser');
    assert.equal(by['/jump.html'].finalUrl, `${site.origin}/b.html`);
    assert.ok(Object.values(by).every((r) => r.cache?.at && r.http), 'every URL documented');

    const check = await runCheck('cache', project);
    assert.deepEqual(check, { step: 'cache', pass: true, reasons: [] });
    const md = await readFile(path.join(project.step('cache'), 'cache.md'), 'utf8');
    assert.match(md, /Visited so far: 7 URLs/);
    assert.match(md, /doc\.pdf \| cached \| binary/);
    const st = await status(project);
    assert.equal(st.steps.find((s) => s.id === 'cache').state, 'done');

    await pw(cli, S, 'goto', served.url);
    await new Promise((r) => { setTimeout(r, 1500); });
    const seen = await readDash();
    assert.match(seen.cache, /^cache\s*done/);
    assert.equal(seen.live, '', 'not live once the queue is empty');
    assert.deepEqual(seen.cards.slice(0, 2), ['7URLs', '7 / 7cached']);
    assert.ok(seen.cards.includes('3page') && seen.cards.includes('2redirect'), seen.cards);
    assert.deepEqual([seen.redirects, seen.notToMigrate], [2, 4]);
  } finally {
    await pw(cli, S, 'close').catch(() => {});
    await stopDashboard(project);
    await site.close();
  }
});
