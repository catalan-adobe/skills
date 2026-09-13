import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir, mkdtemp, readFile, stat, writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaTokenError } from './da.mjs';
import { readRows } from './ledger.mjs';
import { resolvePaths } from './paths.mjs';
import { assertRecord } from './shapes.mjs';
import {
  addFeedback, listFeedback, listRecords, setFeedback, upsertRecords,
} from './state.mjs';
import {
  buildReport, classifyFailure, defaultRunId, feedbackForces, longTailReport, mediaStats,
  runBulk, selectRecords,
} from './bulk.mjs';

const execFileP = promisify(execFile);
const cliPath = fileURLToPath(new URL('./bulk.mjs', import.meta.url));
const ORIGIN = 'https://www.example.com';
const urlFor = (slug) => `${ORIGIN}/case-study/${slug}/`;

function sourcePage(slug) {
  return '<!doctype html><html><head>'
    + `<title>${slug} | Example</title>`
    + `<meta name="description" content="How ${slug} runs on Example">`
    + `</head><body><main><h1>${slug}</h1><p>Case study body.</p></main></body></html>`;
}

const seenParams = [];

/** A five-cell block row: `validate.mjs` rejects it and the runner never repairs it. */
function oversizedBlock(document) {
  const block = document.createElement('div');
  block.setAttribute('class', 'cards');
  const row = document.createElement('div');
  for (let i = 0; i < 5; i += 1) {
    const cell = document.createElement('div');
    cell.textContent = `cell ${i + 1}`;
    row.append(cell);
  }
  block.append(row);
  return block;
}

const HUGE = 'https://www.example.com/uploads/2024/07/huge.jpg';
const DOWNSCALED = 'https://content.da.live/o/s/media/case-study/oversize/huge.jpg';

/** An `<img>` pointing at a 30 MB original: `media.mjs` repairs it, the transformer cannot. */
function oversizeImage(document) {
  const p = document.createElement('p');
  const img = document.createElement('img');
  img.setAttribute('src', HUGE);
  img.setAttribute('alt', 'huge');
  p.append(img);
  return p;
}

const transformer = {
  version: '1.0.0',
  match: (url) => url.includes('/case-study/'),
  generateDocumentPath: ({ url }) => new URL(url).pathname.replace(/\/$/, ''),
  transformDOM: ({ document, url, params }) => {
    seenParams.push(params);
    if (url.includes('/boom/')) throw new Error('cannot map the hero of this page');
    const main = document.querySelector('main');
    const section = document.createElement('div');
    section.append(...main.childNodes);
    if (url.includes('/bad-block/')) section.append(oversizedBlock(document));
    if (url.includes('/oversize/')) section.append(oversizeImage(document));
    main.replaceChildren(section);
    return main;
  },
};

function httpStub({ failing = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      get: async (url) => {
        calls.push(url);
        if (failing.has(url)) return { url, status: 503, body: '' };
        return { url, status: 200, body: sourcePage(new URL(url).pathname.split('/')[2]) };
      },
    },
  };
}

function daStub({ unauthorizedAt = 0, unauthorizedPreview = false } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      putSource: async ({ path: docPath, html }) => {
        calls.push({ method: 'put', path: docPath, bytes: html.length });
        if (calls.length === unauthorizedAt) {
          throw new DaTokenError(`PUT ${docPath} -> 401`);
        }
        return { path: docPath, status: 201 };
      },
      preview: async ({ path: docPath }) => {
        calls.push({ method: 'preview', path: docPath });
        if (unauthorizedPreview) throw new DaTokenError(`POST preview ${docPath} -> 401`);
        return { path: docPath, status: 200, url: `https://preview${docPath}` };
      },
    },
  };
}

/** A minimal, valid `site.config.json` for a project rooted at `dir`. */
function siteConfig() {
  return {
    origin: ORIGIN,
    sitemapIndex: `${ORIGIN}/sitemap.xml`,
    exclusions: {},
    viewports: [1440],
    concurrency: { fetch: 2, browser: 2, da: 2 },
    rateLimit: { requestsPerSecond: 2 },
    thresholds: { newTemplateMin: 2 },
    bundles: { pageTree: 'page-tree-bundle.js' },
    templateSeeds: {},
    da: {
      org: 'o', site: 's', ref: 'main', adminHost: 'https://a', sourceHost: 'https://b',
    },
    templates: {
      'case-study': {
        sourceRoot: 'body > main', sourceUrlPattern: '^/case-study/',
      },
    },
  };
}

/** A passing (or not) dry-run report, so `--run`'s coverage gate lets the test through. */
async function writeDryRunReport(paths, template, coverage, transformerVersion = '1.0.0') {
  const file = path.join(paths.dataDir, 'bulk', `${template}-dryrun.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ coverage, transformerVersion }, null, 2));
}

async function setup(slugs, { dryRunCoverage = 1 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migration-bulk-'));
  const configPath = path.join(dir, 'site.config.json');
  await writeFile(configPath, JSON.stringify(siteConfig()));
  const paths = resolvePaths({
    MIGRATION_PROJECT_DIR: dir,
    MIGRATION_CONFIG: configPath,
    MIGRATION_DATA_DIR: path.join(dir, 'data'),
    MIGRATION_CACHE_DIR: path.join(dir, 'cache'),
  });
  await upsertRecords('urls', slugs.map((slug) => ({
    url: urlFor(slug),
    path: `/case-study/${slug}/`,
    sitemapType: 'case-study',
    template: 'case-study',
    status: 'analyzed',
  })), paths);
  if (dryRunCoverage !== null) await writeDryRunReport(paths, 'case-study', dryRunCoverage);
  return {
    dir,
    paths,
    io: {
      paths,
      transformer,
      contentDir: path.join(dir, 'content'),
      rulesDir: path.join(dir, 'rules'),
      reportsDir: path.join(dir, 'reports'),
      fetchImpl: async () => { throw new Error('the tests never touch the network'); },
    },
  };
}

test('selectRecords drops excluded and published records and honours the limit', () => {
  const records = [
    { url: 'a', status: 'analyzed' }, { url: 'b', status: 'excluded' },
    { url: 'c', status: 'published' }, { url: 'd', status: 'failed' },
  ];
  assert.deepEqual(selectRecords(records).map((r) => r.url), ['a', 'd']);
  assert.deepEqual(selectRecords(records, { limit: 1 }).map((r) => r.url), ['a']);
});

test('the urls shape accepts every status bulk writes', () => {
  for (const status of ['transformed', 'uploaded', 'previewed', 'long-tail', 'failed']) {
    assert.doesNotThrow(() => assertRecord('urls', {
      url: urlFor('a'),
      path: '/case-study/a/',
      sitemapType: 'case-study',
      template: 'case-study',
      status,
    }));
  }
});

test('classifyFailure masks volatile detail and maps stages to statuses', () => {
  assert.equal(classifyFailure('transform', 'cannot map the hero').status, 'long-tail');
  assert.equal(
    classifyFailure('media', 'XML_PARSE_HUGE').status,
    'failed',
    'media is not LLM'
  );
  assert.equal(classifyFailure('validate', 'media: bad img').status, 'long-tail');
  const fetchFail = classifyFailure('fetch', `GET ${urlFor('a')} -> 503`);
  assert.equal(fetchFail.status, 'failed');
  assert.equal(fetchFail.class, 'fetch: GET <url> -> N');
  assert.equal(fetchFail.message, `GET ${urlFor('a')} -> 503`);
  assert.equal(classifyFailure('capture', 'EACCES write').status, 'failed');
  assert.equal(classifyFailure('upload', 'PUT -> 500').status, 'failed');
});

test('mediaStats counts images, absolute sources and svgs', () => {
  const html = '<img src="https://www.example.com/a.png" alt="a">'
    + '<img src="/local.png" alt="b"><img src="https://www.example.com/logo.svg?v=2" alt="c">';
  assert.deepEqual(mediaStats(html), { images: 3, remote: 2, svg: 1 });
});

test('the transformer receives the template source root from the site config', async () => {
  const { io } = await setup(['acme-flight-school']);
  seenParams.length = 0;
  await runBulk({
    template: 'case-study',
    mode: 'dry-run',
    options: { runId: 'bulk-params', concurrency: 1 },
    io: { ...io, http: httpStub().client },
  });
  assert.equal(seenParams[0].sourceRoot, 'body > main');
});

test('a dry run reports coverage, failure classes and samples without writing state', async () => {
  const { dir, paths, io } = await setup([
    'acme-flight-school', 'harbour-clinic', 'boom', 'bad-block',
  ]);
  const report = await runBulk({
    template: 'case-study',
    mode: 'dry-run',
    options: { runId: 'bulk-dry-1', concurrency: 2 },
    io: { ...io, http: httpStub().client },
  });
  assert.equal(report.total, 4);
  assert.equal(report.counts.transformed, 2);
  assert.equal(report.counts['long-tail'], 2);
  assert.equal(report.coverage, 0.5);
  assert.deepEqual(report.longTail, [urlFor('boom'), urlFor('bad-block')]);
  const samples = ['/case-study/acme-flight-school', '/case-study/harbour-clinic'];
  assert.deepEqual(report.samplePaths, samples);
  const classes = report.failures.map((f) => f.class).sort();
  assert.equal(classes.length, 2);
  assert.ok(classes[0].startsWith('transform: cannot map the hero'));
  assert.ok(classes[1].startsWith('validate: blocks: block "cards" row has N cells'));
  assert.equal(report.stopped, null);
  const jsonFile = path.join(paths.dataDir, 'bulk', 'case-study-dryrun.json');
  const json = JSON.parse(await readFile(jsonFile, 'utf8'));
  assert.equal(json.coverage, 0.5);
  const md = await readFile(path.join(dir, 'reports', 'bulk-case-study-dryrun.md'), 'utf8');
  assert.match(md, /^# Bulk dry run \u2014 case-study$/m);
  assert.match(md, /- Transform coverage: 50\.0 %/);
  assert.match(md, /- `\/case-study\/acme-flight-school`/);
  const stored = await listRecords('urls', { where: { template: 'case-study' }, paths });
  assert.deepEqual([...new Set(stored.map((r) => r.status))], ['analyzed']);
  assert.deepEqual(await readRows('units', paths), []);
});

test('a run uploads, previews and checkpoints every URL', async () => {
  const { paths, io } = await setup(['acme-flight-school', 'harbour-clinic']);
  const da = daStub();
  const report = await runBulk({
    template: 'case-study',
    mode: 'run',
    options: { runId: 'bulk-run-1', concurrency: 1 },
    io: { ...io, http: httpStub().client, da: da.client },
  });
  assert.equal(report.counts.previewed, 2);
  assert.deepEqual(da.calls.map((c) => `${c.method} ${c.path}`), [
    'put /case-study/acme-flight-school', 'preview /case-study/acme-flight-school',
    'put /case-study/harbour-clinic', 'preview /case-study/harbour-clinic',
  ]);
  const stored = await listRecords('urls', { where: { template: 'case-study' }, paths });
  assert.deepEqual(stored.map((r) => r.status), ['previewed', 'previewed']);
  assert.equal(stored[0].transformerVersion, '1.0.0');
  assert.match(stored[0].contentHash, /^[0-9a-f]{64}$/);
  assert.equal(stored[0].docPath, '/case-study/acme-flight-school');
  assert.equal(stored[0].error, null);
  const units = await readRows('units', paths);
  assert.deepEqual(units.map((u) => u.verdict), ['previewed', 'previewed']);
  assert.equal(units[0].kind, 'page');
  assert.equal(units[0].runId, 'bulk-run-1');
});

test('a second run skips unchanged URLs unless force is set', async () => {
  const { io } = await setup(['acme-flight-school']);
  const base = { template: 'case-study', mode: 'run' };
  const first = daStub();
  await runBulk({
    ...base,
    options: { runId: 'r1', concurrency: 1 },
    io: { ...io, http: httpStub().client, da: first.client },
  });
  const second = daStub();
  const skipped = await runBulk({
    ...base,
    options: { runId: 'r2', concurrency: 1 },
    io: { ...io, http: httpStub().client, da: second.client },
  });
  assert.equal(skipped.counts.skipped, 1);
  assert.deepEqual(second.calls, []);
  const third = daStub();
  const forced = await runBulk({
    ...base,
    options: { runId: 'r3', concurrency: 1, force: true },
    io: { ...io, http: httpStub().client, da: third.client },
  });
  assert.equal(forced.counts.previewed, 1);
  assert.equal(third.calls.length, 2);
});

test('a 401 checkpoints the URL and throws the operator action', async () => {
  const { paths, io } = await setup(['acme-flight-school', 'harbour-clinic']);
  const da = daStub({ unauthorizedAt: 1 });
  const err = await runBulk({
    template: 'case-study',
    mode: 'run',
    options: { runId: 'bulk-401', concurrency: 1 },
    io: { ...io, http: httpStub().client, da: da.client },
  }).catch((e) => e);
  assert.ok(err instanceof DaTokenError);
  assert.match(err.message, /aem-cli content clone/);
  assert.equal(da.calls.length, 1);
  const stored = await listRecords('urls', { where: { template: 'case-study' }, paths });
  assert.deepEqual(stored.map((r) => r.status), ['transformed', 'analyzed']);
  assert.match(stored[0].error, /-> 401/);
});

test('a 401 during preview checkpoints the URL as uploaded', async () => {
  const { paths, io } = await setup(['acme-flight-school']);
  const da = daStub({ unauthorizedPreview: true });
  const err = await runBulk({
    template: 'case-study',
    mode: 'run',
    options: { runId: 'bulk-401-preview', concurrency: 1 },
    io: { ...io, http: httpStub().client, da: da.client },
  }).catch((e) => e);
  assert.ok(err instanceof DaTokenError);
  const [stored] = await listRecords('urls', { where: { template: 'case-study' }, paths });
  assert.equal(stored.status, 'uploaded');
});

function sizeFetch(sizes) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      return new Response('', { headers: { 'content-length': String(sizes[url] ?? 1000) } });
    },
  };
}

function fixerStub() {
  const calls = [];
  return {
    calls,
    fixMedia: async ({ html, scope, client }) => {
      calls.push({ scope, hasClient: Boolean(client) });
      return {
        html: html.replaceAll(HUGE, DOWNSCALED),
        fixed: [{ from: HUGE, to: DOWNSCALED, method: 'downscale' }],
        skipped: [],
      };
    },
  };
}

test('a media-only validation failure is repaired and the URL continues', async () => {
  const { dir, paths, io } = await setup(['oversize']);
  const fixer = fixerStub();
  const da = daStub();
  const report = await runBulk({
    template: 'case-study',
    mode: 'run',
    options: { runId: 'bulk-media', concurrency: 1 },
    io: {
      ...io,
      http: httpStub().client,
      da: da.client,
      fixMedia: fixer.fixMedia,
      fetchImpl: sizeFetch({ [HUGE]: 31457280, [DOWNSCALED]: 480000 }).fetchImpl,
    },
  });
  assert.equal(report.counts.previewed, 1);
  assert.deepEqual(fixer.calls, [{ scope: 'case-study/oversize', hasClient: true }]);
  const file = path.join(dir, 'content', 'case-study', 'oversize.html');
  const written = await readFile(file, 'utf8');
  assert.ok(written.includes(DOWNSCALED) && !written.includes(HUGE), 'the fix is written to disk');
  const [uploaded] = da.calls;
  assert.equal(uploaded.method, 'put');
  const [stored] = await listRecords('urls', { where: { template: 'case-study' }, paths });
  assert.equal(stored.status, 'previewed');
  assert.equal(stored.mediaFixed, 1);
});

test('a non-media validation failure stays long-tail and never calls the fixer', async () => {
  const { paths, io } = await setup(['bad-block']);
  const fixer = fixerStub();
  const report = await runBulk({
    template: 'case-study',
    mode: 'run',
    options: { runId: 'bulk-media-skip', concurrency: 1 },
    io: {
      ...io, http: httpStub().client, da: daStub().client, fixMedia: fixer.fixMedia,
    },
  });
  assert.equal(report.counts['long-tail'], 1);
  assert.deepEqual(fixer.calls, []);
  const [stored] = await listRecords('urls', { where: { template: 'case-study' }, paths });
  assert.equal(stored.status, 'long-tail');
  assert.equal(stored.mediaFixed, 0);
});

test('an unreachable URL is failed, not long-tail', async () => {
  const { paths, io } = await setup(['acme-flight-school']);
  const report = await runBulk({
    template: 'case-study',
    mode: 'run',
    options: { runId: 'bulk-fetch', concurrency: 1 },
    io: {
      ...io,
      http: httpStub({ failing: new Set([urlFor('acme-flight-school')]) }).client,
      da: daStub().client,
    },
  });
  assert.equal(report.counts.failed, 1);
  assert.equal(report.failures[0].class, 'fetch: GET <url> -> N');
  assert.equal(report.failures[0].exampleUrl, urlFor('acme-flight-school'));
  const [stored] = await listRecords('urls', { where: { template: 'case-study' }, paths });
  assert.equal(stored.status, 'failed');
  assert.match(stored.error, /-> 503$/);
});

test('the CLI requires a template and exactly one mode', async () => {
  const missing = await execFileP(process.execPath, [cliPath, '--dry-run']).catch((e) => e);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Usage: bulk\.mjs --template <t> \(--dry-run \| --run\)/);
  const bothArgs = [cliPath, '--template', 'case-study', '--dry-run', '--run'];
  const both = await execFileP(process.execPath, bothArgs).catch((e) => e);
  assert.equal(both.code, 1);
  assert.match(both.stderr, /Usage: bulk\.mjs/);
});

test('a dry run counts media-only failures as transformed with pending repairs', async () => {
  const results = [
    {
      url: 'a', status: 'transformed', media: { images: 2, remote: 2, svg: 1 }, mediaPending: 1,
    },
    {
      url: 'b', status: 'transformed', media: { images: 1, remote: 1, svg: 0 }, mediaFixed: 1,
    },
  ];
  const ctx = {
    template: 't', mode: 'dry-run', runId: 'r', generatedAt: 'now',
  };
  const report = buildReport(ctx, results);
  assert.equal(report.coverage, 1);
  assert.equal(report.media.pending, 1);
  assert.equal(report.media.fixed, 1);
  assert.deepEqual(report.longTail, []);
});

test('longTailReport groups by fingerprint and proposes templates above the minimum', () => {
  const results = [
    { url: 'https://example.com/a', status: 'long-tail' },
    { url: 'https://example.com/b', status: 'long-tail' },
    { url: 'https://example.com/c', status: 'long-tail' },
    { url: 'https://example.com/d', status: 'done' },
  ];
  const urls = [
    { url: 'https://example.com/a', fingerprint: 'h|m|f' },
    { url: 'https://example.com/b', fingerprint: 'h|m|f' },
    { url: 'https://example.com/c', fingerprint: 'h|t' },
    { url: 'https://example.com/d', fingerprint: 'h|m|f' },
  ];
  const r = longTailReport(results, urls, { newTemplateMin: 2 });
  assert.equal(r.groups.length, 2);
  assert.equal(r.groups[0].urls.length, 2);
  assert.equal(r.groups[0].proposedTemplate, true);
  assert.equal(r.groups[1].proposedTemplate, false);
  assert.match(r.markdown, /## Proposed new templates/);
  assert.match(r.markdown, /- 2 pages share `h\|m\|f`/);
  assert.match(r.markdown, /- https:\/\/example\.com\/c \(`h\|t`\)/);
});

test('feedbackForces matches global, template and page scopes only', () => {
  const target = { template: 'case-study', path: '/case-study/a/', docPath: '/case-study/a' };
  assert.equal(feedbackForces({ scope: 'global' }, target), true);
  assert.equal(feedbackForces({ scope: 'template:case-study' }, target), true);
  assert.equal(feedbackForces({ scope: 'template:video' }, target), false);
  assert.equal(feedbackForces({ scope: 'page:/case-study/a' }, target), true);
  assert.equal(feedbackForces({ scope: 'page:/case-study/a/' }, target), true);
  assert.equal(feedbackForces({ scope: 'page:/case-study/b' }, target), false);
  assert.equal(feedbackForces({ scope: 'block:cards' }, target), false);
});

test('a dry run writes the long-tail report grouped by the stored fingerprints', async () => {
  const { dir, paths, io } = await setup(['boom', 'boom-2', 'acme-flight-school']);
  const boom = (slug) => ({
    url: urlFor(slug), path: `/case-study/${slug}/`, fingerprint: 'h|m|f',
  });
  await upsertRecords('urls', [boom('boom'), boom('boom-2')], paths);
  const transformerBoom = {
    ...transformer,
    transformDOM: (args) => {
      if (args.url.includes('/boom')) throw new Error('cannot map the hero');
      return transformer.transformDOM(args);
    },
  };
  await runBulk({
    template: 'case-study',
    mode: 'dry-run',
    options: { runId: 'bulk-lt', concurrency: 1 },
    io: { ...io, http: httpStub().client, transformer: transformerBoom },
  });
  const md = await readFile(path.join(dir, 'reports', 'bulk-case-study-longtail.md'), 'utf8');
  assert.match(md, /^2 URLs matched no transformer\.$/m);
  assert.match(md, /- 2 pages share `h\|m\|f`\n {2}- .*\/boom\/\n {2}- .*\/boom-2\//);
});

test('the capture mirrors the fetched source: unchanged pages keep it, changed pages refresh it',
  async () => {
    const { paths, io } = await setup(['acme-flight-school']);
    const file = path.join(
      paths.dataDir, 'captures', 'case-study', 'case-study-acme-flight-school.html',
    );
    const run = (http) => runBulk({
      template: 'case-study',
      mode: 'dry-run',
      options: { runId: 'bulk-cap', concurrency: 1 },
      io: { ...io, http },
    });
    await run(httpStub().client);
    assert.equal(await readFile(file, 'utf8'), sourcePage('acme-flight-school'));
    const before = (await stat(file)).mtimeMs;
    await new Promise((r) => { setTimeout(r, 20); });
    await run(httpStub().client);
    assert.equal((await stat(file)).mtimeMs, before, 'unchanged source is not rewritten');
    const changed = `${sourcePage('acme-flight-school')}<!-- v2 -->`;
    await run({ get: async (url) => ({ url, status: 200, body: changed }) });
    assert.equal(await readFile(file, 'utf8'), changed, 'changed source refreshes the capture');
  });

async function feedbackRun({ io, paths }, runId, slugs, http = httpStub().client) {
  const item = await addFeedback({
    scope: 'template:case-study', decision: 'rerun', note: 'hero mapping changed',
  }, paths);
  await setFeedback(item.id, { status: 'applied' }, paths);
  const da = daStub();
  const report = await runBulk({
    template: 'case-study',
    mode: 'run',
    options: { runId, concurrency: 1 },
    io: { ...io, http, da: da.client },
  });
  const [after] = await listFeedback({ id: item.id }, paths);
  return { report, after, da, slugs };
}

test('applied feedback forces up-to-date URLs and is marked with the run id on success',
  async () => {
    const { paths, io } = await setup(['acme-flight-school']);
    const first = daStub();
    await runBulk({
      template: 'case-study',
      mode: 'run',
      options: { runId: 'r1', concurrency: 1 },
      io: { ...io, http: httpStub().client, da: first.client },
    });
    const { report, after, da } = await feedbackRun({ io, paths }, 'r2', ['acme-flight-school']);
    assert.equal(report.counts.previewed, 1, 'the up-to-date URL was re-transformed');
    assert.equal(da.calls.length, 2);
    assert.equal(after.appliedRun, 'r2');
  });

test('feedback stays pending when one of the URLs it forced did not finish', async () => {
  const { paths, io } = await setup(['acme-flight-school', 'boom']);
  const { report, after } = await feedbackRun({ io, paths }, 'r-fail', ['acme-flight-school']);
  assert.equal(report.counts['long-tail'], 1);
  assert.equal(after.appliedRun, undefined);
});

test('a template-scoped item settles when its only matching URL is excluded', async () => {
  const { paths, io } = await setup(['acme-flight-school']);
  await upsertRecords('urls', [{
    url: urlFor('acme-flight-school'),
    path: '/case-study/acme-flight-school/',
    sitemapType: 'case-study',
    template: 'case-study',
    status: 'excluded',
  }], paths);
  const item = await addFeedback({ scope: 'template:case-study', decision: 'rerun' }, paths);
  await setFeedback(item.id, { status: 'applied' }, paths);
  await runBulk({
    template: 'case-study',
    mode: 'run',
    options: { runId: 'r-excluded', concurrency: 1 },
    io: { ...io, http: httpStub().client, da: daStub().client },
  });
  const [after] = await listFeedback({ id: item.id }, paths);
  assert.equal(after.appliedRun, 'r-excluded', 'zero forced URLs settle vacuously');
});

test('a global item forces its URLs but is never auto-settled', async () => {
  const { paths, io } = await setup(['acme-flight-school']);
  const item = await addFeedback({ scope: 'global', decision: 'rerun' }, paths);
  await setFeedback(item.id, { status: 'applied' }, paths);
  const first = daStub();
  await runBulk({
    template: 'case-study',
    mode: 'run',
    options: { runId: 'r1', concurrency: 1 },
    io: { ...io, http: httpStub().client, da: first.client },
  });
  const second = daStub();
  const report = await runBulk({
    template: 'case-study',
    mode: 'run',
    options: { runId: 'r2', concurrency: 1 },
    io: { ...io, http: httpStub().client, da: second.client },
  });
  assert.equal(report.counts.previewed, 1, 'the up-to-date URL was re-transformed');
  assert.equal(second.calls.length, 2, 'a global item forces even up-to-date URLs');
  const [after] = await listFeedback({ id: item.id }, paths);
  assert.equal(after.appliedRun, undefined, 'global items are settled by the operator');
});

test('a page-scoped item for another template is neither forced nor settled', async () => {
  const { paths, io } = await setup(['acme-flight-school']);
  const item = await addFeedback({
    scope: 'page:/other-template/some-page', decision: 'rerun',
  }, paths);
  await setFeedback(item.id, { status: 'applied' }, paths);
  const report = await runBulk({
    template: 'case-study',
    mode: 'run',
    options: { runId: 'r-other', concurrency: 1 },
    io: { ...io, http: httpStub().client, da: daStub().client },
  });
  assert.equal(report.counts.skipped ?? 0, 0, 'nothing was up to date yet');
  assert.equal(report.counts.previewed, 1, 'the run proceeds unaffected');
  const [after] = await listFeedback({ id: item.id }, paths);
  assert.equal(after.appliedRun, undefined);
  assert.equal(after.status, 'applied', 'left exactly as it was');
});

test('--run refuses when no dry-run report exists', async () => {
  const { paths, io } = await setup(['acme-flight-school'], { dryRunCoverage: null });
  const err = await runBulk({
    template: 'case-study',
    mode: 'run',
    options: { runId: 'r-nogate', concurrency: 1 },
    io: { ...io, http: httpStub().client, da: daStub().client },
  }).catch((e) => e);
  const file = path.join(paths.dataDir, 'bulk', 'case-study-dryrun.json');
  assert.match(err.message, /Run bulk\.mjs --template case-study --dry-run first/);
  assert.ok(err.message.includes(file));
});

test('--run refuses when the dry-run coverage is below the threshold', async () => {
  const { io } = await setup(['acme-flight-school'], { dryRunCoverage: 0.5 });
  const err = await runBulk({
    template: 'case-study',
    mode: 'run',
    options: { runId: 'r-lowcov', concurrency: 1 },
    io: { ...io, http: httpStub().client, da: daStub().client },
  }).catch((e) => e);
  assert.match(err.message, /Dry-run coverage 0\.5 is below thresholds\.coverage 0\.95/);
  assert.match(err.message, /--accept-coverage/);
});

test('--accept-coverage proceeds below the threshold and records it in the ledger', async () => {
  const { paths, io } = await setup(['acme-flight-school'], { dryRunCoverage: 0.5 });
  const report = await runBulk({
    template: 'case-study',
    mode: 'run',
    options: { runId: 'r-accept', concurrency: 1, acceptCoverage: true },
    io: { ...io, http: httpStub().client, da: daStub().client },
  });
  assert.equal(report.counts.previewed, 1);
  const units = await readRows('units', paths);
  assert.equal(units[0].detail, 'bulk run (coverage accepted)');
});

test('feedback is not settled when --limit left URLs out of the batch', async () => {
  const { paths, io } = await setup(['acme-flight-school', 'harbour-clinic']);
  const item = await addFeedback({ scope: 'template:case-study', decision: 'rerun' }, paths);
  await setFeedback(item.id, { status: 'applied' }, paths);
  await runBulk({
    template: 'case-study',
    mode: 'run',
    options: { runId: 'r-limit', concurrency: 1, limit: 1 },
    io: { ...io, http: httpStub().client, da: daStub().client },
  });
  const [after] = await listFeedback({ id: item.id }, paths);
  assert.equal(after.appliedRun, undefined, 'half a template is not an applied rerun');
});

test('defaultRunId is unique per run and names the template', () => {
  const a = defaultRunId('case-study', new Date('2026-09-10T12:34:56.789Z'));
  assert.equal(a, 'bulk-case-study-20260910T123456Z');
  assert.notEqual(defaultRunId('case-study'), defaultRunId('case-study', new Date(0)));
});

test('--run writes a run report saying what was selected, what is terminal and what remains',
  async () => {
    const { paths, io } = await setup(['acme-flight-school', 'harbour-clinic']);
    const runOptions = (runId, extra = {}) => ({
      template: 'case-study',
      mode: 'run',
      options: { runId, concurrency: 1, ...extra },
      io: { ...io, http: httpStub().client, da: daStub().client },
    });
    const partial = await runBulk(runOptions('r-deadline', { maxMinutes: 0 }));
    assert.equal(partial.stopped, 'deadline');
    const file = path.join(paths.dataDir, 'bulk', 'case-study-run.json');
    const first = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(first.selected, 2);
    assert.ok(first.remaining >= 1, 'the deadline left at least one URL untouched');
    assert.equal(first.terminal + first.remaining, first.selected);
    assert.equal(first.stopped, 'deadline');
    assert.equal(first.runId, 'r-deadline');
    await runBulk(runOptions('r-full'));
    const second = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(
      { selected: second.selected, terminal: second.terminal, remaining: second.remaining },
      { selected: 2, terminal: 2, remaining: 0 },
    );
    assert.equal(second.stopped, null);
    assert.equal(second.longTail, 0);
    assert.equal(second.failed, 0);
  });

test('a version bump alone does not re-push: unchanged output is skipped by its hash', async () => {
  const { io } = await setup(['acme-flight-school']);
  const base = { template: 'case-study', mode: 'run' };
  const first = daStub();
  await runBulk({
    ...base,
    options: { runId: 'h1', concurrency: 1 },
    io: { ...io, http: httpStub().client, da: first.client },
  });
  const bumped = { ...transformer, version: '1.0.1' };
  await writeDryRunReport(io.paths, 'case-study', 1, '1.0.1');
  const second = daStub();
  const report = await runBulk({
    ...base,
    options: { runId: 'h2', concurrency: 1 },
    io: {
      ...io, transformer: bumped, http: httpStub().client, da: second.client,
    },
  });
  assert.deepEqual(second.calls, [], 'same output, no PUT');
  assert.equal(report.counts.skipped, 1);
  assert.equal(report.counts.unchanged, 1);
  const stored = await listRecords('urls', { where: { template: 'case-study' }, paths: io.paths });
  assert.equal(stored[0].transformerVersion, '1.0.1', 'the record follows the version');
  assert.equal(stored[0].status, 'previewed');
});

test('--run refuses a dry-run report written for another transformer version', async () => {
  const { io } = await setup(['acme-flight-school']);
  await writeDryRunReport(io.paths, 'case-study', 1, '0.9.0');
  const da = daStub();
  const err = await runBulk({
    template: 'case-study',
    mode: 'run',
    options: { runId: 'stale', concurrency: 1 },
    io: { ...io, http: httpStub().client, da: da.client },
  }).catch((e) => e);
  assert.match(err.message, /transformer 0\.9\.0.*current 1\.0\.0/s);
  assert.match(err.message, /bulk\.mjs --template case-study --dry-run/);
  assert.deepEqual(da.calls, []);
});

test('--run refuses before the first PUT when the token expires inside the window', async () => {
  const { io } = await setup(['acme-flight-school', 'harbour-clinic']);
  const da = daStub();
  da.client.expiresAt = Date.now() + 2 * 60 * 1000;
  const err = await runBulk({
    template: 'case-study',
    mode: 'run',
    options: { runId: 'expiring', concurrency: 1 },
    io: { ...io, http: httpStub().client, da: da.client },
  }).catch((e) => e);
  assert.ok(err instanceof DaTokenError, String(err));
  assert.match(err.message, /expires in 2 min/);
  assert.match(err.message, /needs at least 10 min/);
  assert.deepEqual(da.calls, []);
});

test('a 401 drains the pool: workers stop taking URLs and no lock is left behind', async () => {
  const slugs = ['a', 'b', 'c', 'd', 'e', 'f'].map((s) => `clinic-${s}`);
  const { io, paths } = await setup(slugs);
  const da = daStub({ unauthorizedAt: 1 });
  const err = await runBulk({
    template: 'case-study',
    mode: 'run',
    options: { runId: 'drain', concurrency: 3 },
    io: { ...io, http: httpStub().client, da: da.client },
  }).catch((e) => e);
  assert.ok(err instanceof DaTokenError);
  assert.equal(da.calls.length, 1, 'in-flight workers do not upload after the abort');
  const lock = await stat(path.join(paths.dataDir, 'urls.json.lock')).catch(() => null);
  assert.equal(lock, null, 'lock released');
  const stored = await listRecords('urls', { where: { template: 'case-study' }, paths });
  assert.ok(stored.filter((r) => r.status === 'analyzed').length >= 3, 'untouched URLs stay');
});

test('long-tail ledger rows carry the validator message', async () => {
  const { io, paths } = await setup(['bad-block']);
  const da = daStub();
  await runBulk({
    template: 'case-study',
    mode: 'run',
    options: { runId: 'lt', concurrency: 1 },
    io: { ...io, http: httpStub().client, da: da.client },
  });
  const row = (await readRows('units', paths)).find((r) => r.runId === 'lt');
  assert.equal(row.verdict, 'long-tail');
  assert.match(row.detail, /bulk run: .*cells/);
});

test('an aborted signal skips the remaining URLs and returns a consistent report', async () => {
  const { io, paths } = await setup(['acme-flight-school', 'harbour-clinic']);
  const da = daStub();
  const controller = new AbortController();
  controller.abort();
  const report = await runBulk({
    template: 'case-study',
    mode: 'run',
    options: { runId: 'sig', concurrency: 2 },
    io: {
      ...io, http: httpStub().client, da: da.client, signal: controller.signal,
    },
  });
  assert.equal(report.counts.skipped, 2);
  assert.deepEqual(da.calls, []);
  assert.equal(await stat(path.join(paths.dataDir, 'urls.json.lock')).catch(() => null), null);
});
