import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  distribution, pick, proposal, relativeSegments, renderUrlsMd, scopeOf, writeSubset, writeSubsets,
} from './urls.mjs';

const execFileP = promisify(execFile);
const cliPath = fileURLToPath(new URL('../status.mjs', import.meta.url));

async function cli(cwd, ...args) {
  const { stdout } = await execFileP('node', [cliPath, ...args], { cwd });
  try { return JSON.parse(stdout); } catch { return stdout; }
}

const fresh = () => mkdtemp(path.join(os.tmpdir(), 'cpv2-urls-'));

const mixed = [
  { url: 'https://x.example/blog/one', level1: 'blog', level2: 'one', lang: 'en-US' },
  { url: 'https://x.example/blog/two', level1: 'blog', level2: 'two', lang: 'en-US' },
  { url: 'https://x.example/docs/api', level1: 'docs', level2: 'api', lang: 'en-US' },
  { url: 'https://x.example/fr/blog', level1: 'fr', level2: 'blog' },
  { url: 'https://x.example/', level1: '', level2: '' },
];

test('distribution counts first segment, second segment and language', () => {
  const dist = distribution(mixed);
  assert.equal(dist.total, 5);
  assert.deepEqual(dist.byFirstSegment, {
    blog: 2, docs: 1, fr: 1, '': 1,
  });
  assert.deepEqual(dist.bySecondSegment, {
    one: 1, two: 1, api: 1, blog: 1, '': 1,
  });
  assert.deepEqual(dist.byLanguage, { 'en-US': 3, fr: 1, unknown: 1 });
});

test('proposal caches all urls at or under the threshold, not over it', () => {
  const dist = distribution(mixed);
  assert.deepEqual(proposal(dist, { cacheAllUpTo: 5 }), { all: true, total: 5 });
  const over = proposal(dist, { cacheAllUpTo: 4 });
  assert.equal(over.all, false);
  assert.equal(over.scope, '/');
  assert.deepEqual(over.groups.map((g) => g.prefix), ['blog', '', 'docs']);
});

test('proposal picks the largest first-segment groups covering 80% with a long tail', () => {
  const urls = [
    ...Array.from({ length: 40 }, (_, i) => ({ url: `https://x/blog/${i}`, level1: 'blog' })),
    ...Array.from({ length: 30 }, (_, i) => ({ url: `https://x/docs/${i}`, level1: 'docs' })),
    ...Array.from({ length: 10 }, (_, i) => ({ url: `https://x/news/${i}`, level1: 'news' })),
    ...Array.from({ length: 20 }, (_, i) => ({ url: `https://x/tail${i}/p`, level1: `tail${i}` })),
  ];
  const dist = distribution(urls);
  assert.equal(dist.total, 100);
  const prop = proposal(dist, { cacheAllUpTo: 10 });
  assert.equal(prop.all, false);
  assert.equal(prop.scope, '/');
  assert.deepEqual(prop.groups.map((g) => g.prefix), ['blog', 'docs', 'news']);
  const covered = prop.groups.reduce((sum, g) => sum + g.count, 0);
  assert.ok(covered / dist.total >= 0.8);
  assert.equal(prop.groups[0].share, 0.4);
});

test('renderUrlsMd tables the counts and states the proposal in one sentence', () => {
  const dist = distribution(mixed);
  const all = renderUrlsMd(dist, { all: true, total: 5 });
  assert.match(all, /Total URLs: 5/);
  assert.match(all, /\| blog \| 2 \|/);
  assert.match(all, /\| en-US \| 3 \|/);
  const sentences = all.split('\n').filter((l) => l.includes('cache every URL'));
  assert.equal(sentences.length, 1);
  assert.match(sentences[0], /^All 5 URLs are at or under the caching threshold, so cache/);

  const grouped = renderUrlsMd(dist, {
    all: false, scope: '/', groups: [{ prefix: 'blog', count: 2, share: 0.4 }],
  });
  const groupedSentence = grouped.split('\n').find((l) => l.includes('exceed the caching'));
  assert.equal(groupedSentence.match(/\./g).length, 1);
  assert.match(groupedSentence, /"blog" \(2\)/);
});

test('writeSubsets writes one file per group, matched by the proposal segment', async () => {
  const dir = await fresh();
  const prop = { all: false, scope: '/', groups: [{ prefix: 'blog', count: 2, share: 0.4 }] };
  const files = await writeSubsets(mixed, prop, dir);
  assert.deepEqual(files, [path.join(dir, 'subsets', 'blog.txt')]);
  const text = await readFile(files[0], 'utf8');
  assert.equal(text, 'https://x.example/blog/one\nhttps://x.example/blog/two\n');
});

test('writeSubsets writes nothing when the proposal caches everything', async () => {
  const dir = await fresh();
  const files = await writeSubsets(mixed, { all: true, total: 5 }, dir);
  assert.deepEqual(files, []);
});

test('writeSubsets names the root group file when the prefix is empty', async () => {
  const dir = await fresh();
  const prop = { all: false, scope: '/', groups: [{ prefix: '', count: 1, share: 0.2 }] };
  const files = await writeSubsets(mixed, prop, dir);
  assert.deepEqual(files, [path.join(dir, 'subsets', 'root.txt')]);
});

test('writeSubsets clears subset files left over from a previous proposal', async () => {
  const dir = await fresh();
  const first = {
    all: false,
    scope: '/',
    groups: [{ prefix: 'blog', count: 2, share: 0.4 }, { prefix: 'docs', count: 1, share: 0.2 }],
  };
  await writeSubsets(mixed, first, dir);
  const second = { all: false, scope: '/', groups: [{ prefix: 'blog', count: 2, share: 0.4 }] };
  const files = await writeSubsets(mixed, second, dir);
  assert.deepEqual(files, [path.join(dir, 'subsets', 'blog.txt')]);
  await assert.rejects(readFile(path.join(dir, 'subsets', 'docs.txt'), 'utf8'));
});

test('writeSubsets clears subset files when the new proposal caches everything', async () => {
  const dir = await fresh();
  const first = { all: false, scope: '/', groups: [{ prefix: 'blog', count: 2, share: 0.4 }] };
  await writeSubsets(mixed, first, dir);
  await writeSubsets(mixed, { all: true, total: 5 }, dir);
  await assert.rejects(readFile(path.join(dir, 'subsets', 'blog.txt'), 'utf8'));
});

test('writeSubsets skips entries without a usable url instead of writing "undefined"', async () => {
  const dir = await fresh();
  const withGap = [
    { url: 'https://x.example/blog/one', level1: 'blog' },
    { level1: 'blog' },
    { url: '', level1: 'blog' },
  ];
  const prop = { all: false, scope: '/', groups: [{ prefix: 'blog', count: 3, share: 1 }] };
  const files = await writeSubsets(withGap, prop, dir);
  const text = await readFile(files[0], 'utf8');
  assert.equal(text, 'https://x.example/blog/one\n');
});

const summary = 'reads urls.json, writes urls.md and subsets, prints the proposal';
test(`status.mjs urls ${summary}`, async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://x.example/');
  const urlsDir = path.join(cwd, 'migration', 'urls');
  await mkdir(urlsDir, { recursive: true });
  await writeFile(path.join(urlsDir, 'urls.json'), JSON.stringify(mixed));
  const result = await cli(cwd, 'urls');
  assert.equal(result.all, true);
  assert.equal(result.total, 5);
  const md = await readFile(path.join(urlsDir, 'urls.md'), 'utf8');
  assert.match(md, /cache every URL/);
});

test('status.mjs urls writes real per-prefix subset files when over the threshold', async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://x.example/');
  const projectFile = path.join(cwd, 'migration', 'project.json');
  const project = JSON.parse(await readFile(projectFile, 'utf8'));
  project.cacheAllUpTo = 4;
  await writeFile(projectFile, JSON.stringify(project));
  const urlsDir = path.join(cwd, 'migration', 'urls');
  await mkdir(urlsDir, { recursive: true });
  await writeFile(path.join(urlsDir, 'urls.json'), JSON.stringify(mixed));
  const result = await cli(cwd, 'urls');
  assert.equal(result.all, false);
  assert.deepEqual(result.groups.map((g) => g.prefix), ['blog', '', 'docs']);
  const blog = await readFile(path.join(urlsDir, 'subsets', 'blog.txt'), 'utf8');
  assert.equal(blog, 'https://x.example/blog/one\nhttps://x.example/blog/two\n');
  const root = await readFile(path.join(urlsDir, 'subsets', 'root.txt'), 'utf8');
  assert.equal(root, 'https://x.example/\n');
});

test('status.mjs urls names the missing input file', async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://x.example/');
  const err = await cli(cwd, 'urls').catch((e) => e);
  assert.match(err.stderr, /missing migration\/urls\/urls\.json/);
});

test('status.mjs urls does not call a directory-in-place-of-file "missing"', async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://x.example/');
  const urlsDir = path.join(cwd, 'migration', 'urls');
  await mkdir(path.join(urlsDir, 'urls.json'), { recursive: true });
  const err = await cli(cwd, 'urls').catch((e) => e);
  assert.doesNotMatch(err.stderr, /run the scan step first/);
});

test('status.mjs urls rejects urls.json that is not an array', async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://x.example/');
  const urlsDir = path.join(cwd, 'migration', 'urls');
  await mkdir(urlsDir, { recursive: true });
  await writeFile(path.join(urlsDir, 'urls.json'), JSON.stringify({ a: 1 }));
  const err = await cli(cwd, 'urls').catch((e) => e);
  assert.match(err.stderr, /must be a JSON array of URLExtended entries/);
});

test('status.mjs urls rejects urls.json that is not valid JSON', async () => {
  const cwd = await fresh();
  await cli(cwd, 'init', '--origin', 'https://x.example/');
  const urlsDir = path.join(cwd, 'migration', 'urls');
  await mkdir(urlsDir, { recursive: true });
  await writeFile(path.join(urlsDir, 'urls.json'), '{ not json');
  const err = await cli(cwd, 'urls').catch((e) => e);
  assert.match(err.stderr, /is not valid JSON/);
});

const scoped = [
  { url: 'https://x.example/en/section.html' },
  { url: 'https://x.example/en/section/diseases/asthma.html' },
  { url: 'https://x.example/en/section/diseases/gout.html' },
  { url: 'https://x.example/en/section/clinics/list.html' },
  { url: 'https://x.example/en/section/clinics/list/one.html' },
];

test('a scoped site counts segments below the prefix every URL shares', () => {
  assert.deepEqual(scopeOf(scoped), ['en', 'section']);
  assert.deepEqual(relativeSegments('https://x.example/en/section/clinics/list/one.html',
    ['en', 'section']), ['clinics', 'list', 'one']);
  assert.deepEqual(relativeSegments('https://x.example/en/section.html', ['en', 'section']), []);
  const dist = distribution(scoped);
  assert.equal(dist.scope, '/en/section');
  assert.deepEqual(dist.byFirstSegment, { diseases: 2, clinics: 2, '': 1 });
  assert.deepEqual(dist.bySecondSegment, { asthma: 1, gout: 1, list: 2, '': 1 });
  assert.equal(scopeOf(mixed).length, 0, 'no shared prefix, segments are absolute');
  assert.deepEqual(distribution(mixed).byFirstSegment, {
    blog: 2, docs: 1, fr: 1, '': 1,
  });
  const md = renderUrlsMd(dist, proposal(dist, { cacheAllUpTo: 500 }));
  assert.match(md, /share the prefix `\/en\/section`/);
});

test('subsets over a scoped site are cut by the relative first segment', async () => {
  const dir = await fresh();
  const dist = distribution(scoped);
  const prop = proposal(dist, { cacheAllUpTo: 2 });
  assert.deepEqual(prop.groups.map((g) => g.prefix), ['clinics', 'diseases']);
  const files = await writeSubsets(scoped, prop, dir);
  const clinics = await readFile(path.join(dir, 'subsets', 'clinics.txt'), 'utf8');
  assert.equal(clinics.trim().split('\n').length, 2);
  assert.equal(files.length, 2);
});

test('pick returns one reachable URL per largest group, skipping excluded groups', async () => {
  const urls = [
    { url: 'https://x.example/en/section.html' },
    { url: 'https://x.example/en/section/diseases.html' },
    { url: 'https://x.example/en/section/diseases/gone.html' },
    { url: 'https://x.example/en/section/diseases/asthma.html' },
    { url: 'https://x.example/en/section/diseases/gout.html' },
    { url: 'https://x.example/en/section/clinics/one.html' },
    { url: 'https://x.example/en/section/clinics/two.html' },
    { url: 'https://x.example/en/section/about/team.html' },
  ];
  const probed = [];
  const reachable = async (url) => { probed.push(url); return !url.includes('gone'); };
  const picked = await pick(urls, {
    count: 2, exclude: ['https://x.example/en/section.html'], reachable,
  });
  assert.deepEqual(picked, [
    { url: 'https://x.example/en/section/diseases/asthma.html', group: 'diseases', count: 4 },
    { url: 'https://x.example/en/section/clinics/one.html', group: 'clinics', count: 2 },
  ]);
  assert.ok(probed.includes('https://x.example/en/section/diseases/gone.html'), 'skipped 404');
  const few = await pick(urls, { count: 5, exclude: [], reachable });
  assert.deepEqual(few.map((p) => p.group), ['diseases', 'clinics', 'about', '']);
  assert.equal(few.length, 4, 'no more picks than groups');
});

test('urls.md opens with the proposal and caps every table at 25 rows', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    url: `https://x.example/g${String(i).padStart(2, '0')}/page`,
  }));
  const dist = distribution(many);
  const md = renderUrlsMd(dist, proposal(dist, { cacheAllUpTo: 10 }));
  const lines = md.split('\n');
  assert.equal(lines[0], '# URL distribution');
  assert.match(lines[2], /^40 URLs exceed the caching threshold/, 'proposal is the first line');
  const firstTable = md.slice(md.indexOf('## By first path segment'), md.indexOf('## By second'));
  assert.equal((firstTable.match(/^\| g\d\d \|/gm) ?? []).length, 25);
  assert.match(firstTable, /\| … and 15 more \| 15 \|/);
  const small = renderUrlsMd(distribution(mixed), { all: true, total: 5 });
  assert.ok(!small.includes('more |'), 'no truncation row under the cap');
});

test('pick with fill rounds over the groups until count, HTML pages only, no duplicates',
  async () => {
    const urls = [
      { url: 'https://x.example/' },
      { url: 'https://x.example/a/1.html' }, { url: 'https://x.example/a/2.html' },
      { url: 'https://x.example/a/3.html' }, { url: 'https://x.example/a/doc.pdf' },
      { url: 'https://x.example/b/1.html' }, { url: 'https://x.example/b/tool.php' },
      { url: 'https://x.example/c/1.html' },
    ];
    const reachable = async () => true;
    const five = await pick(urls, { count: 5, fill: true, reachable });
    assert.deepEqual(five.map((p) => p.url), [
      'https://x.example/a/1.html', 'https://x.example/b/1.html', 'https://x.example/c/1.html',
      'https://x.example/', 'https://x.example/a/2.html',
    ]);
    const everything = await pick(urls, { count: 50, fill: true, reachable });
    assert.equal(everything.length, 6, 'pdf and php are never picked, no duplicates');
    const dir = await fresh();
    const written = await writeSubset(dir, 'sample', five.map((p) => p.url));
    const text = await readFile(written, 'utf8');
    assert.equal(text.trim().split('\n').length, 5);
    assert.match(written, /subsets\/sample\.txt$/);
  });

const classified = [
  { url: 'https://x.example/a/1.html', kind: 'page', cache: { at: 't' } },
  { url: 'https://x.example/a/2.html' },
  { url: 'https://x.example/a/old.html', kind: 'redirect', migrate: 'target',
    redirect: { status: 301, target: 'https://x.example/a/1.html', targetInList: true } },
  { url: 'https://x.example/b/gone.html', kind: 'error', migrate: 'no', http: { status: 404 } },
  { url: 'https://x.example/b/doc.pdf', kind: 'binary', migrate: 'asset' },
  { url: 'https://x.example/b/3.html', kind: 'page', cache: { at: 't' } },
];

test('urls.md reports kinds, the redirect table and what is not to be migrated', () => {
  const dist = distribution(classified);
  assert.deepEqual(dist.byKind, {
    page: 2, unclassified: 1, redirect: 1, error: 1, binary: 1,
  });
  assert.equal(dist.cached, 2);
  const md = renderUrlsMd(dist, proposal(dist, { cacheAllUpTo: 500 }));
  assert.match(md, /## By kind/);
  assert.match(md, /\| page \| 2 \|/);
  assert.match(md, /## Redirects\n\n\| from \| status \| to \| target in list \|/);
  assert.match(md, /\| https:\/\/x\.example\/a\/old\.html \| 301 \| https:\/\/x\.example\/a\/1/);
  assert.match(md, /a\/1\.html \| yes \|/);
  assert.match(md, /## Not to migrate\n\n.*old\.html.*redirect.*\n.*gone\.html.*error 404/s);
  assert.match(md, /2 of 6 URLs cached/);
});

test('proposal and pick leave known non-pages out', async () => {
  const dist = distribution(classified);
  const prop = proposal(dist, { cacheAllUpTo: 2 });
  assert.equal(prop.total, 3, 'pages and unclassified URLs are candidates, the rest are not');
  const picks = await pick(classified, { count: 5, fill: true, reachable: async () => true });
  assert.deepEqual(picks.map((p) => p.url).sort(), [
    'https://x.example/a/1.html', 'https://x.example/a/2.html', 'https://x.example/b/3.html',
  ]);
});

// Added after a mutation run: each of these pins a behaviour a surviving mutant had changed.

test('a first segment counts as a language only when it is exactly two letters', () => {
  const dist = distribution([
    { url: 'https://x.example/fr/a' }, { url: 'https://x.example/blogs/a' },
    { url: 'https://x.example/f/a' }, { url: 'https://x.example/en-us/a' },
    { url: 'https://x.example/zz/b', lang: 'de' },
  ]);
  assert.deepEqual(dist.byLanguage, { fr: 1, unknown: 3, de: 1 });
});

test('the proposal sentence states the coverage percentage of the chosen groups', () => {
  const urls = [];
  for (let i = 0; i < 400; i += 1) urls.push({ url: `https://x.example/a/${i}` });
  for (let i = 0; i < 100; i += 1) urls.push({ url: `https://x.example/b/${i}` });
  for (let i = 0; i < 20; i += 1) urls.push({ url: `https://x.example/c${i}/x` });
  const dist = distribution(urls);
  const md = renderUrlsMd(dist, proposal(dist, { cacheAllUpTo: 500 }));
  assert.match(md, /520 URLs exceed the caching threshold, so cache the 2 largest groups /);
  assert.match(md, /covering 96% of URLs: "a" \(400\), "b" \(100\)\./);
});

test('not-to-migrate gives the status or type as reason; unclassified URLs stay out', () => {
  const dist = distribution([
    { url: 'https://x.example/a', kind: 'error', http: { status: 410 } },
    { url: 'https://x.example/b.pdf', kind: 'binary', http: { contentType: 'application/pdf' } },
    { url: 'https://x.example/c' },
    { url: 'https://x.example/d', kind: 'page' },
  ]);
  const md = renderUrlsMd(dist, proposal(dist));
  assert.match(md, /- https:\/\/x\.example\/a — error 410\n/);
  assert.match(md, /- https:\/\/x\.example\/b\.pdf — binary application\/pdf\n/);
  const section = md.slice(md.indexOf('## Not to migrate'));
  assert.doesNotMatch(section, /x\.example\/c\b/);
  assert.doesNotMatch(section, /x\.example\/d\b/);
  assert.equal(dist.notToMigrate.length, 2);
});

test('long redirect and not-to-migrate lists stop at 25 rows and count the rest', () => {
  const urls = [];
  for (let i = 0; i < 27; i += 1) {
    urls.push({
      url: `https://x.example/r${i}`, kind: 'redirect',
      redirect: { status: 301, target: `https://x.example/t${i}`, targetInList: false },
    });
  }
  const dist = distribution(urls);
  const md = renderUrlsMd(dist, proposal(dist));
  assert.match(md, /\| … and 2 more \| \| \| \|/);
  assert.match(md, /- … and 2 more\n/);
  assert.equal((md.match(/\| https:\/\/x\.example\/r\d+ \| 301 \|/g) ?? []).length, 25);
  const exact = distribution(urls.slice(0, 25));
  assert.doesNotMatch(renderUrlsMd(exact, proposal(exact)), /and \d+ more/);
});

test('subset files hold only entries with a non-empty url string', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cpv2-urls-'));
  const urls = [];
  for (let i = 0; i < 600; i += 1) urls.push({ url: `https://x.example/a/${i}` });
  urls.push({ url: '' }, { url: 42 }, null, { url: 'https://x.example/a/last' });
  const dist = distribution(urls.filter(Boolean));
  const prop = proposal(dist, { cacheAllUpTo: 500 });
  await writeSubsets(urls, prop, dir);
  const text = await readFile(path.join(dir, 'subsets', 'a.txt'), 'utf8');
  assert.equal(text.split('\n').filter(Boolean).length, 601);
  assert.ok(text.endsWith('/a/last\n'));
});

test('pick returns exactly the requested count and rejects bad subset names', async () => {
  const urls = [];
  for (let i = 0; i < 9; i += 1) urls.push({ url: `https://x.example/g${i % 3}/p${i}.html` });
  const onePass = await pick(urls, { count: 4, reachable: async () => true });
  assert.equal(onePass.length, 3, 'without fill: one URL per group, one pass');
  const picks = await pick(urls, { count: 4, fill: true, reachable: async () => true });
  assert.equal(picks.length, 4);
  assert.equal(new Set(picks.map((p) => p.url)).size, 4);
  assert.deepEqual(picks.map((p) => p.group).sort(), ['g0', 'g0', 'g1', 'g2']);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cpv2-urls-'));
  const list = picks.map((p) => p.url);
  await assert.rejects(writeSubset(dir, 'bad name', list), /must be \[A-Za-z0-9_-\]/);
  await assert.rejects(writeSubset(dir, 'a/b', list), /must be/);
  await writeSubset(dir, 'ok_name-1', list);
});
