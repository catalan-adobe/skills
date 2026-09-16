// The DOM half of the bundle, on real renders: each file under fixtures/ distils a case met
// on a real site into a small page; the pages are served on loopback and captured through
// playwright-cli with the bundle injected. Skips when playwright-cli is not on PATH.
// Run: npm run test:fixtures
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, 'page-tree-bundle.js');
const fixtures = path.join(here, '..', 'fixtures');
const SESSION = `pt-fixtures-${process.pid}`;

async function onPath(cmd) {
  return execFileP('which', [cmd]).then(({ stdout }) => stdout.trim(), () => null);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css' };
async function serve() {
  const server = createServer(async (req, res) => {
    const file = path.join(fixtures, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    try {
      const body = await readFile(file);
      const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** playwright-cli, run from a scratch cwd (it writes logs and snapshots into its cwd). */
function browser(cli, cwd) {
  const run = (...args) => execFileP(cli, [`-s=${SESSION}`, ...args], { cwd, maxBuffer: 1 << 24 });
  return {
    open: (url, config) => run('open', '--config', config, url),
    goto: (url) => run('goto', url),
    capture: async () => {
      const { stdout } = await run('eval',
        'JSON.stringify(window.__visualTree.captureVisualTree(900))');
      const result = /### Result\s*\n([\s\S]*?)\n### Ran/.exec(stdout)?.[1] ?? stdout;
      let value = JSON.parse(result.trim());
      if (typeof value === 'string') value = JSON.parse(value);
      return value;
    },
    close: () => run('close').catch(() => {}),
  };
}

const find = (node, pred) => {
  if (pred(node)) return node;
  for (const c of node.children ?? []) { const hit = find(c, pred); if (hit) return hit; }
  return null;
};
const bySelector = (tree, selector) => find(tree, (n) => n.selector === selector);
const rootSelectors = (tree) => tree.children.map((n) => n.selector);

test('page-tree fixtures', async (t) => {
  const cli = await onPath('playwright-cli');
  if (!cli) { t.skip('playwright-cli not on PATH'); return; }
  const site = await serve();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'pt-fixtures-'));
  const config = path.join(cwd, 'config.json');
  await writeFile(config, JSON.stringify({
    browser: { browserName: 'chromium', initScript: [bundle] },
    network: { allowedOrigins: [site.origin] },
  }));
  const b = browser(cli, cwd);
  const page = async (name) => {
    await b.goto(`${site.origin}/${name}.html`);
    return b.capture();
  };
  await b.open(`${site.origin}/sticky-nav.html`, config);
  try {
    await t.test('transparent header over a hero: the nav is a node with its own box', async () => {
      const { data, nodeMap } = await page('transparent-header-over-hero');
      const nav = bySelector(data, '#topNav');
      assert.ok(nav, `nav in the tree: ${rootSelectors(data).join(', ')}`);
      assert.deepEqual([nav.bounds.y, nav.bounds.height, nav.bounds.width], [53, 80, 1280]);
      assert.deepEqual(nav.collapsed.map((c) => c.selector).at(-1), '#topNav');
      assert.match(nav.collapsed[0].selector, /sticky-wrap/, 'the chain starts at the wrapper');
      const hero = find(data, (n) => n.bounds.height === 700);
      assert.ok(hero, 'the hero is there too');
      assert.ok(Object.values(nodeMap).some((n) => n.selector === '#topNav'));
    });

    await t.test('sticky nav with a wrapper that has area keeps the wrapper identity', async () => {
      const { data } = await page('sticky-nav');
      const band = find(data, (n) => n.bounds.y === 53 && n.bounds.height === 80);
      assert.ok(band);
      assert.match(band.selector, /sticky-wrap/);
      assert.deepEqual(band.collapsed.map((c) => c.selector).at(-1), '#topNav');
      assert.equal(band.className, 'sticky-wrap', 'every class, not the first, is recorded');
    });

    await t.test('an open dropdown overflowing its trigger is promoted and occludes', async () => {
      const { data, nodeMap } = await page('dropdown-escapes-trigger');
      const trigger = find(data, (n) => /trigger/.test(n.selector));
      assert.ok(trigger, 'the trigger keeps its own node');
      assert.equal(trigger.bounds.height, 80);
      const menu = data.children.find((n) => n.bounds.height === 400 && n.className === 'menu');
      assert.ok(menu, `the menu is a root child: ${rootSelectors(data).join(', ')}`);
      const menuId = Object.entries(nodeMap).find(([, n]) => n.selector === menu.selector)[0];
      assert.match(menuId, /^rc\d+$/, 'promoted to the root');
      assert.ok(nodeMap[menuId].overlay?.occluding?.length >= 1, 'and marked as occluding');
    });

    await t.test('a 5 px progress bar is its own node next to the nav', async () => {
      const { data } = await page('progress-bar-hairline');
      const wrap = find(data, (n) => /wrap/.test(n.selector) && n.bounds.height === 85);
      assert.ok(wrap);
      assert.deepEqual(wrap.children.map((c) => c.bounds.height), [80, 5]);
    });

    await t.test('fixed elements: the wide banner and the narrow button both survive', async () => {
      const { data, nodeMap } = await page('fixed-cookie-banner');
      const cmp = bySelector(data, '#cmp');
      const chat = bySelector(data, '#chat');
      assert.ok(cmp, 'the consent banner');
      assert.ok(chat, 'the 300 px fixed button passes the width filter because it is fixed');
      assert.equal(cmp.fixed, true);
      const cmpId = Object.entries(nodeMap).find(([, n]) => n.selector === '#cmp')[0];
      assert.match(cmpId, /^rc\d+$/, 'the banner was promoted out of its deep parent');
      assert.ok(nodeMap[cmpId].overlay?.occluding?.length >= 1, 'and occludes the content');
    });

    await t.test('children narrower than the minimum fold into their parent', async () => {
      const { data } = await page('narrow-children-folded');
      const cards = find(data, (n) => /cards/.test(n.selector));
      assert.ok(cards);
      assert.deepEqual(cards.children, [], 'no 400 px card is a node');
      assert.ok(cards.layout, `a row layout is detected: ${JSON.stringify(cards.layout)}`);
      assert.match(cards.text ?? '', /One/);
    });
  } finally {
    await b.close();
    site.close();
  }
});
