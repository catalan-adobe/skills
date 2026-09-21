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

test('the elements panel renders types, the groups table and composition chips', async (t) => {
  await need(t, 'aem (@adobe/aem-cli)', () => onPath('aem'));
  const cli = await need(t, 'playwright-cli', () => onPath('playwright-cli'));
  const root = await edsRepo();
  const project = resolveProject(root);
  await init({ origin: 'https://site.example/' }, project);
  const page = (n, types, covered) => ({
    url: `https://site.example/blog/${n}.html`, group: 'blog', covered,
    sections: types.map((type) => ({ type, selector: 's', height: 100 })),
  });
  const type = (id, identity, pages, recurring = true) => ({
    id, identity, pages, recurring, support: pages / 3, instances: pages, heightRange: [90, 110],
    variants: [{ instances: pages, pages, children: [] }], sample: { url: 'u', selector: 's' },
    screenshots: recurring ? { instances: [`screenshots/type-${id}-1.png`] } : undefined,
  });
  const elements = {
    generatedAt: '2026-01-02T03:04:05Z', capturedPages: 3,
    types: [type('t-a', 'DIV#.fw.cards', 3), type('t-b', 'DIV#.fw.text', 2),
      type('t-u', 'DIV#.fw.once', 1, false)],
    pages: [page(1, ['t-a', 't-b'], 'full'), page(2, ['t-a'], 'full'), page(3, ['t-u'], 'none')],
    compositions: [{ key: 't-a t-b', pages: 1 }, { key: 't-a', pages: 1 },
      { key: 't-u', pages: 1 }],
    groups: [{ group: 'blog', pages: 3, types: 3, compositions: 3, dominantShare: 0.33,
      recentNewTypes: 3, saturated: false }],
    groupsWithoutPages: ['docs'],
    runs: [{ covered: { full: 2, partial: 0, none: 1 } }],
  };
  await mkdir(path.join(project.dir, 'elements'), { recursive: true });
  await writeFile(path.join(project.dir, 'elements', 'elements.json'), JSON.stringify(elements));
  await writeFile(path.join(project.dir, 'urls', 'urls.json'), JSON.stringify(
    elements.pages.map((p) => ({ url: p.url, kind: 'page', group: 'blog', cache: { at: 'x' } })),
  ));
  const mapping = { types: { 't-a': { kind: 'block', block: 'cards', notes: 'two up' },
    't-b': { kind: 'default-content' } } };
  await mkdir(path.join(project.dir, 'mapping'), { recursive: true });
  await writeFile(path.join(project.dir, 'mapping', 'mapping.json'), JSON.stringify(mapping));
  await writeFile(path.join(project.dir, 'mapping', 'inventory.json'), JSON.stringify({
    blocks: [{ name: 'cards', types: ['t-a'], identities: ['DIV#.fw.cards'], instances: 3,
      pages: 3, variants: 1, medianHeight: 100, sample: { url: 'u' }, notes: ['two up'],
      screenshots: ['screenshots/type-t-a-1.png'] }],
    defaultContent: { types: ['t-b'], instances: 2, pages: 2 }, skipped: [], undecided: [],
    orphaned: [], coverage: { pages: 3, covered: 2, uncovered: [{ url: 'x', types: ['t-u'] }] },
  }));
  await writeFile(project.statusFile, JSON.stringify({
    generatedAt: '2026-01-02T03:04:05Z', cacheServer: { running: false },
    steps: [{ id: 'elements', state: 'done', tier: 'medium', blockedBy: [], writes: [] },
      { id: 'mapping', state: 'done', tier: 'medium', blockedBy: [], writes: [] }],
  }));
  const served = await dashboard(project, freePort);
  const S = 'cpv2-test-dash-elements';
  try {
    await pw(cli, S, 'open', served.url);
    const read = async () => parseEval(evalResult((await pw(cli, S, 'eval', `JSON.stringify({
      heads: [...document.querySelectorAll('#elements .variant h3')]
        .map((h) => h.textContent.trim()),
      groups: document.querySelectorAll('#elements table tbody tr').length,
      without: document.querySelector('#elements .panel').textContent.includes('docs'),
      chips: [...document.querySelectorAll('#urls td .chip.type')].map((c) => c.textContent),
      badges: [...document.querySelectorAll('#urls td .chip[class*=cover-]')]
        .map((c) => c.textContent),
      filter: document.querySelector('#urls [name=covered]').hidden,
      kinds: [...document.querySelectorAll('#elements .variant h3 .chip')]
        .map((c) => c.textContent),
      blocks: [...document.querySelectorAll('#blocks .variant h3')]
        .map((h) => h.textContent.trim()),
      blockCards: [...document.querySelectorAll('#blocks .card .n')].map((n) => n.textContent),
      openRows: document.querySelectorAll('#blocks table tbody tr').length,
    })`)).stdout));
    let got = await read();
    for (let i = 0; i < 40 && !(got.heads.length && got.kinds.length); i += 1) {
      await new Promise((r) => { setTimeout(r, 250); });
      got = await read();
    }
    assert.deepEqual(got.heads,
      ['cards · 3 pages (100 %) block cards', 'text · 2 pages (67 %) default content'],
      'recurring types only, labels without the shared framework class, the kind chip');
    assert.equal(got.groups, 1);
    assert.equal(got.without, true);
    assert.deepEqual(got.chips, ['cards', 'text', 'cards', 'once']);
    assert.deepEqual(got.badges, ['full', 'full', 'none']);
    assert.equal(got.filter, false, 'the coverage filter appears with the inventory');
    assert.deepEqual(got.kinds, ['block cards', 'default content'], 'the mapping on the types');
    assert.deepEqual(got.blocks, ['cards · 3 pages']);
    assert.deepEqual(got.blockCards, ['1', '1', '0', '0', '2 / 3']);
    assert.equal(got.openRows, 1);
  } finally {
    await pw(cli, S, 'close').catch(() => {});
    await stopDashboard(project);
  }
});
