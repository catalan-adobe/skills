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
    'notes', 'pages', 'runs', 'selections', 'state', 'store', 'views', 'website']);
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
  assert.match(after, /\naccess {4}ready\n/);
  const stateJson = JSON.parse(await readFile(path.join(cwd, 'migration', 'state.json'), 'utf8'));
  assert.equal(stateJson.steps[0].state, 'done');
  assert.deepEqual((await main(['website'], cwd)).counts, (await cli(cwd, 'website')).counts,
    'main is the CLI');
  const noMigration = await cli(await mkdtemp(path.join(os.tmpdir(), 'mpipe-n-')), 'state')
    .catch((e) => e);
  assert.match(noMigration.stderr, /no migration at .*; run: migration init --origin/);
});
