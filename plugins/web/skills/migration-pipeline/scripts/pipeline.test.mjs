import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CHECKS } from './lib/checks.mjs';
import { data, layerDir } from './lib/data.mjs';
import { collect, discover, proposal } from './lib/discover.mjs';
import { main, parse } from './pipeline.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('./pipeline.mjs', import.meta.url));
const O = 'https://a.example/';
const fresh = async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mpipe-'));
  const { migration } = await data(cwd);
  await migration.init(cwd, { origin: O, plan: { pages: 50 } });
  return cwd;
};
const cli = async (cwd, ...args) => {
  const { stdout } = await run('node', [CLI, ...args], { cwd });
  try { return JSON.parse(stdout); } catch { return stdout; }
};

test('the layer is found beside this skill; every module loads', async () => {
  assert.match(await layerDir(), /migration-data\/scripts\/lib$/);
  const d = await data(await mkdtemp(path.join(os.tmpdir(), 'mpipe-x-')));
  assert.deepEqual(Object.keys(d).sort(), ['composition', 'elements', 'inventory', 'migration',
    'notes', 'pages', 'runs', 'selections', 'state', 'store', 'trees', 'views', 'website']);
});

test('collect: sitemaps and crawls through the crawler, a list from a file', async () => {
  const cwd = await fresh();
  const calls = [];
  const crawl = async (start, options) => {
    calls.push([start, options.strategy, options.inclusionPatterns]);
    await options.urlStreamFn([
      { url: `${O}a`, status: 'valid', origin: 'sitemap.xml' },
      { url: `${O}b`, status: 'redirect', origin: 'sitemap.xml' },
    ]);
    return { sitemaps: ['sitemap.xml'], errors: [] };
  };
  const got = await collect(cwd, { crawl });
  assert.deepEqual(got, { urls: [{ url: `${O}a`, source: 'sitemap.xml' }], from: 'sitemap',
    source: 'sitemap.xml', errors: [] }, 'only valid entries, with their sitemap');
  assert.deepEqual(calls[0], ['https://a.example', 'sitemaps', []]);
  await collect(cwd, { crawl, strategy: 'http' });
  assert.equal(calls[1][1], 'http');
  await assert.rejects(collect(cwd, { crawl: async () => ({}) }), /no valid URLs with strategy/);
  await assert.rejects(collect(cwd, { strategy: 'magic' }), /strategy must be one of/);
  await assert.rejects(collect(cwd, { strategy: 'list' }), /--list <file> is needed/);
  const list = path.join(cwd, 'urls.txt');
  await writeFile(list, `# mine\n${O}x\n\n${O}y\n`);
  assert.deepEqual(await collect(cwd, { strategy: 'list', list }),
    { urls: [{ url: `${O}x` }, { url: `${O}y` }], from: 'list', source: 'urls.txt', errors: [] });
});

test('discover writes the table, the website, a note with the proposal, and a run', async () => {
  const cwd = await fresh();
  const list = path.join(cwd, 'urls.txt');
  await writeFile(list, [O, `${O}blogs/a`, `${O}blogs/b`, `${O}docs/c`, 'https://other.example/z']
    .join('\n'));
  const out = await discover(cwd, { strategy: 'list', list });
  assert.deepEqual([out.urls, out.inScope, out.groups], [5, 4, 3]);
  assert.match(out.proposal, /^4 URLs in scope, under the threshold of 500: cache all\./);
  const { pages, website, runs, notes, state } = await data(cwd);
  const table = await pages.read(cwd);
  assert.equal(table.pages.filter((p) => p.verdict.status === 'undecided').length, 4,
    'a plan of 50 pages, no selection yet: in-scope pages are undecided');
  assert.equal(table.pages.find((p) => p.url === 'https://other.example/z').verdict.status, 'out');
  assert.equal((await website.readWebsite(cwd)).counts.inScope, 4);
  const [r] = await runs.list(cwd, { step: 'discover' });
  assert.equal(r.state, 'done');
  assert.match(r.summary, /^5 URLs from list \(urls\.txt\); 4 in scope in 3 groups; 0 errors\./);
  const [n] = await notes.list(cwd, { step: 'discover' });
  assert.equal(n.author, 'runner');
  assert.match(await notes.body(cwd, n.id), /cache all/);
  assert.deepEqual(await CHECKS.discover(cwd), { pass: true });
  const s = await state.compute(cwd, CHECKS);
  assert.equal(s.steps.find((x) => x.id === 'discover').state, 'done');
  assert.equal(s.steps.find((x) => x.id === 'cache').state, 'blocked', 'access first');
});

test('the proposal names the largest groups over the threshold; a failed crawl is a failed run',
  async () => {
    const groups = [{ name: 'blogs', urls: 600 }, { name: 'docs', urls: 300 },
      { name: '', urls: 100 }];
    const words = proposal({ counts: { inScope: 1000 }, groups }, 500);
    assert.match(words, /^1000 URLs in scope exceed the threshold of 500: cache the 2 largest/);
    assert.match(words, /covering 90 % — blogs \(600\), docs \(300\) — or a sample/);
    const cwd = await fresh();
    await assert.rejects(discover(cwd, { crawl: async () => ({}) }), /no valid URLs/);
    const { runs } = await data(cwd);
    const [r] = await runs.list(cwd, { step: 'discover' });
    assert.deepEqual([r.state, r.error], ['failed', 'no valid URLs with strategy sitemaps']);
  });

test('the CLI: parse, state before discover, discover from a list, state after', async () => {
  assert.deepEqual(parse(['discover', '--strategy', 'http']),
    { name: 'discover', flags: { '--strategy': 'http' }, positional: [] });
  assert.throws(() => parse(['nope']), /usage:\n {2}pipeline setup/);
  assert.throws(() => parse(['state', '--json']), /state: unknown flag --json/);
  const cwd = await fresh();
  const before = await cli(cwd, 'state', '--text');
  assert.match(before, /\ndiscover {2}ready {12}no page in scope yet\n/);
  const list = path.join(cwd, 'urls.txt');
  await writeFile(list, `${O}a\n${O}b\n`);
  const out = await cli(cwd, 'discover', '--strategy', 'list', '--list', list);
  assert.equal(out.urls, 2);
  const after = await cli(cwd, 'state', '--text');
  assert.match(after, /\ndiscover {2}done\n/);
  assert.match(after, /\naccess {4}ready {12}no website\/access\.json yet\n/);
  const stateJson = JSON.parse(await readFile(path.join(cwd, 'migration', 'state.json'), 'utf8'));
  assert.equal(stateJson.steps[0].state, 'done');
  assert.deepEqual((await main(['website'], cwd)).counts, (await cli(cwd, 'website')).counts,
    'main is the CLI');
  const noMigration = await cli(await mkdtemp(path.join(os.tmpdir(), 'mpipe-n-')), 'state')
    .catch((e) => e);
  assert.match(noMigration.stderr, /no migration at .*; run: migration init --origin/);
});

test('access folds the probe and prep findings into access.json; verified pages become ids',
  async () => {
    const { browserOf, overlaysOf, writeAccess, check } = await import('./lib/access.mjs');
    const { mkdir } = await import('node:fs/promises');
    assert.deepEqual(browserOf({ cliConfig: { browser: { browserName: 'chromium' } },
      stealthInitScript: null, notes: 'fine' }),
    { engine: 'chromium', config: { browser: { browserName: 'chromium' } }, notes: 'fine' });
    assert.deepEqual(browserOf({}), { engine: 'chromium' });
    assert.deepEqual(overlaysOf({ overlays: [
      { selector: '#cmp', type: 'cookie-consent', hide: ['#cmp { display:none }'],
        dismiss: [{ action: 'click', selector: '#accept' }, { action: 'remove', selector: 'x' }] },
      { selector: '#chat', hide: [] },
    ] }), [
      { selector: '#cmp', action: 'hide', css: ['#cmp { display:none }'], note: 'cookie-consent' },
      { selector: '#accept', action: 'click', note: 'dismisses #cmp' },
    ]);
    const cwd = await fresh();
    await writeFile(path.join(cwd, 'urls.txt'), `${O}\n${O}a\n`);
    await discover(cwd, { strategy: 'list', list: path.join(cwd, 'urls.txt') });
    assert.deepEqual(await check(cwd), { pass: false, note: 'no website/access.json yet' });
    await assert.rejects(writeAccess(cwd), /run the browser-probe sibling first/);
    const dir = path.join(cwd, 'migration', '.work', 'access');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'browser-recipe.json'),
      JSON.stringify({ cliConfig: { browser: { browserName: 'chromium' } }, notes: 'none' }));
    await assert.rejects(writeAccess(cwd), /run the page-prep sibling first/);
    await writeFile(path.join(dir, 'page-prep.json'), JSON.stringify({
      checked: [O, `${O}a/`], overlays: [{ selector: '#cmp', hide: ['#cmp{display:none}'] }],
      scroll_fix: 'html{overflow:auto}', residual: ['#chat'],
    }));
    const out = await writeAccess(cwd);
    assert.equal(out.access.verifiedOn.length, 2);
    assert.match(out.summary, /^chromium; 1 overlay rule\(s\); verified on 2 page\(s\); 1 resid/);
    assert.deepEqual(await check(cwd),
      { pass: false, note: 'recipe verified on 2 page(s); needs 3' });
    await writeFile(path.join(dir, 'page-prep.json'), JSON.stringify({
      checked: [O, `${O}a`, `${O}new`], overlays: [], residual: [],
    }));
    await writeAccess(cwd);
    assert.deepEqual(await check(cwd), { pass: true });
    const { pages } = await data(cwd);
    const added = await pages.get(cwd, `${O}new`);
    assert.equal(added.discovered.from, 'link', 'a checked page the table did not know is added');
    const text = await cli(cwd, 'state', '--text');
    assert.match(text, /\naccess {4}done\n/);
    assert.match(text, /\ncache {5}waiting-operator/);
  });

test('pick: one per largest group in turn, inside pages first, strata interleaved, audits',
  async () => {
    const { choose, stratum, interleave } = await import('./lib/pick.mjs');
    assert.equal(stratum(`${O}blog/a.html`, O), '2|html|');
    assert.equal(stratum(`${O}blog/2024/a.html?p=1`, O), '3|html|q');
    assert.equal(stratum(`${O}blog`, O), '1||');
    assert.deepEqual(interleave([[1, 2, 3], ['a']]), [1, 'a', 2, 3]);
    const rec = (url, group, extra = {}) => ({
      id: `pag-${url.length.toString(16).padStart(12, '0')}`, url, group, cache: null,
      verdict: { status: 'in', reasons: [] }, ...extra });
    const pages = [
      rec(`${O}blog`, 'blog'), rec(`${O}blog/one.html`, 'blog'), rec(`${O}blog/two.html`, 'blog'),
      rec(`${O}blog/2024/deep.html`, 'blog'), rec(`${O}blog/x.pdf`, 'blog'),
      rec(`${O}docs/a.html`, 'docs'), rec(`${O}docs/b.html`, 'docs', { cache: { at: 'x' } }),
      rec(`${O}legal/t.html`, 'legal', { verdict: { status: 'out', reasons: [] } }),
      rec(`${O}zh/p.html`, 'zh'), rec('https://other.example/q', null),
    ];
    const got = choose(pages, O, { count: 10 });
    assert.deepEqual(got.map((p) => p.page.url.replace(O, '')), [
      'blog/one.html', 'docs/a.html', 'zh/p.html', 'blog/2024/deep.html', 'blog/two.html', 'blog',
    ], 'largest group first, one shape at a time, landing last; pdf, cached, out, off-scope never');
    const skipped = choose(pages, O, { count: 2, exclude: ['blog'], audit: 2 });
    assert.deepEqual(skipped.map((p) => [p.group, Boolean(p.audit)]),
      [['docs', false], ['zh', false], ['blog', true], ['blog', true]], 'audits from the excluded');
    const cwd = await fresh();
    await writeFile(path.join(cwd, 'urls.txt'),
      [`${O}blog/one`, `${O}blog/two`, `${O}docs/a`].join('\n'));
    await discover(cwd, { strategy: 'list', list: path.join(cwd, 'urls.txt') });
    const out = await cli(cwd, 'pick', '--count', '2', '--write', 'sample-2');
    assert.deepEqual([out.selection, out.pages, out.picks.map((p) => p.group)],
      ['sample-2', 2, ['blog', 'docs']]);
    const { selections } = await data(cwd);
    assert.deepEqual((await selections.read(cwd, 'sample-2')).criteria,
      { count: 2, exclude: [], audit: 0 });
    const plain = await cli(cwd, 'pick', '--count', '1');
    assert.equal(plain.picks.length, 1);
    assert.equal(plain.selection, undefined);
  });
