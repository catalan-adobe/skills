import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  blocksOf, loadLeakRules, loadSiteRules, parseHtml, validateFile, validateHtml,
  validateHtmlAsync, createRemoteSizer, isFragmentPath, MAX_RASTER_BYTES,
} from './validate.mjs';
import { resolvePaths } from './paths.mjs';

const execFileP = promisify(execFile);
const validateCli = fileURLToPath(new URL('./validate.mjs', import.meta.url));

const IMG = 'https://content.da.live/o/s/media/a.png';

function page(body, meta = true) {
  const metadata = meta ? '<div class="metadata"><div><div>title</div><div>T</div></div>'
    + '<div><div>description</div><div>D</div></div></div>' : '';
  return `<body><header></header><main><div>${body}${metadata}</div></main>`
    + '<footer></footer></body>';
}

test('parseHtml builds a tree, keeps attributes and closes void tags', () => {
  const root = parseHtml('<main><div><p>a <a href="https://x.test/">b</a></p>'
    + `<img src="${IMG}" alt="c"></div></main>`);
  const main = root.children[0];
  assert.equal(main.tag, 'main');
  assert.equal(main.children[0].children.length, 2);
  assert.equal(main.children[0].children[1].attrs.src, IMG);
  assert.equal(blocksOf(root).length, 0);
});

test('a canonical document passes every built-in rule', () => {
  const html = page('<h1>Hello</h1><div class="cards"><div><div><p>One</p></div>'
    + `<div><img src="${IMG}" alt="one"></div></div></div>`);
  const result = validateHtml({ html, origin: 'https://www.example.com' });
  assert.deepEqual(result.issues, []);
  assert.equal(result.pass, true);
});

test('skeleton rule rejects doctype, script, style attributes and missing main', () => {
  const html = '<!DOCTYPE html><div style="color:red">x</div><script>1</script>';
  const { issues } = validateHtml({ html });
  const rules = issues.map((i) => i.message);
  assert.equal(issues.filter((i) => i.rule === 'skeleton').length, 4);
  assert.ok(rules.some((m) => m.includes('<script>')));
  assert.ok(rules.some((m) => m.includes('doctype')));
  assert.ok(rules.some((m) => m.includes('style=')));
  assert.ok(rules.some((m) => m.includes('exactly one <main>')));
});

test('sections rule rejects non-div children of main and hr separators', () => {
  const html = '<body><main><p>loose</p><div><hr></div></main></body>';
  const messages = validateHtml({ html }).issues.filter((i) => i.rule === 'sections')
    .map((i) => i.message);
  assert.equal(messages.length, 2);
  assert.ok(messages[0].includes('<p>'));
  assert.ok(messages[1].includes('<hr>'));
});

test('blocks rule rejects bad names, missing cells, wide rows and nesting', () => {
  const bad = page('<div class="2col"><div><div>a</div><div>b</div><div>c</div><div>d</div>'
    + '<div>e</div></div></div><div class="wrap"><div><div><div class="inner">'
    + '<div><div>x</div></div></div></div></div></div>');
  const messages = validateHtml({ html: bad }).issues.filter((i) => i.rule === 'blocks')
    .map((i) => i.message);
  assert.ok(messages.some((m) => m.includes('invalid block name "2col"')));
  assert.ok(messages.some((m) => m.includes('has 5 cells')));
  assert.ok(messages.some((m) => m.includes('nested block "inner"')));
});

test('cells rule rejects divs, spans and classes inside cells but allows icon spans', () => {
  const bad = page('<div class="cards"><div><div><span class="pill">x</span>'
    + '<p class="lead">y</p></div></div></div>');
  const messages = validateHtml({ html: bad }).issues.filter((i) => i.rule === 'cells')
    .map((i) => i.message);
  assert.equal(messages.length, 2);
  assert.ok(messages.some((m) => m.includes('<span>')));
  assert.ok(messages.some((m) => m.includes('class/id on <p>')));
  const good = page('<div class="footer-social"><div><div>'
    + '<p><span class="icon icon-x"></span></p></div></div></div>');
  assert.deepEqual(validateHtml({ html: good }).issues, []);
});

test('metadata rule catches misspelled, missing, duplicated and short blocks', () => {
  const misspelled = page('<div class="meta-data"><div><div>title</div>'
    + '<div>T</div></div></div>', false);
  const messages = validateHtml({ html: misspelled }).issues.filter((i) => i.rule === 'metadata')
    .map((i) => i.message);
  assert.ok(messages.some((m) => m.includes('"meta-data" is silently ignored')));
  assert.ok(messages.some((m) => m.includes('no metadata block')));
  const short = page('<div class="metadata"><div><div>title</div></div></div>', false);
  const shortMessages = validateHtml({ html: short }).issues.filter((i) => i.rule === 'metadata')
    .map((i) => i.message);
  assert.ok(shortMessages.some((m) => m.includes('exactly 2 cells')));
  assert.ok(shortMessages.some((m) => m.includes('no "description" row')));
});

test('media rule requires absolute image URLs, alt text and icon class shape', () => {
  const html = page('<p><img src="/media/a.png"></p><p><span class="icon">x</span></p>');
  const messages = validateHtml({ html }).issues.filter((i) => i.rule === 'media')
    .map((i) => i.message);
  assert.equal(messages.length, 3);
  assert.ok(messages.some((m) => m.includes('about:error')));
  assert.ok(messages.some((m) => m.includes('no alt attribute')));
  assert.ok(messages.some((m) => m.includes('"icon icon-<name>"')));
});

function sizeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const route = routes[url];
    if (!route) throw new Error(`unexpected ${method} ${url}`);
    if (method === 'HEAD') {
      const status = route.headStatus ?? 200;
      return new Response('', { status, headers: route.headHeaders ?? {} });
    }
    return new Response(route.body ?? '', { status: route.status ?? 200 });
  };
  return { fetchImpl, calls };
}

const SVG = 'https://www.example.com/uploads/2026/01/badge.svg';
const PHOTO = 'https://www.example.com/uploads/2024/07/hero.jpg';

test('media rule reports remote SVGs over the 40 KB content-bus cap', async () => {
  const { fetchImpl, calls } = sizeFetch({
    [SVG]: { headHeaders: { 'content-length': '124000' } },
  });
  const html = page(`<p><img src="${SVG}" alt="badge"><img src="${SVG}" alt="again"></p>`);
  const result = await validateHtmlAsync({ html, fetch: fetchImpl });
  const media = result.issues.filter((i) => i.rule === 'media');
  assert.deepEqual(media.map((i) => i.message), [
    `svg ${SVG} is 124000 bytes; content-bus rejects SVGs over 40 KB — run media.mjs`,
  ]);
  assert.equal(result.pass, false);
  assert.deepEqual(calls, [`HEAD ${SVG}`], 'the size of one URL is measured once per run');
});

test('media rule leaves assets under their cap alone', async () => {
  const { fetchImpl, calls } = sizeFetch({
    [SVG]: { headHeaders: { 'content-length': '39999' } },
    [PHOTO]: { headHeaders: { 'content-length': String(MAX_RASTER_BYTES) } },
  });
  const html = page(`<p><img src="${SVG}" alt="badge"><img src="${PHOTO}" alt="photo">`
    + `<img src="${IMG}" alt="da"></p>`);
  const result = await validateHtmlAsync({ html, fetch: fetchImpl });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(calls, [`HEAD ${SVG}`, `HEAD ${PHOTO}`], 'DA-hosted assets are not measured');
});

test('media rule reports remote rasters over the 20 MB Media Bus cap', async () => {
  const { fetchImpl, calls } = sizeFetch({
    [PHOTO]: { headHeaders: { 'content-length': '31457280' } },
  });
  const html = page(`<p><img src="${PHOTO}" alt="png"><img src="${PHOTO}" alt="again">`
    + '<img src="/local.png" alt="relative"></p>');
  const result = await validateHtmlAsync({ html, fetch: fetchImpl });
  const oversize = result.issues.filter((i) => i.message.startsWith('image '));
  assert.deepEqual(oversize, [{
    rule: 'media',
    severity: 'error',
    message: `image ${PHOTO} is 31457280 bytes; Media Bus rejects images over 20 MB `
      + '\u2014 run media.mjs',
  }]);
  assert.equal(result.pass, false);
  assert.equal(MAX_RASTER_BYTES, 20000000);
  assert.deepEqual(calls, [`HEAD ${PHOTO}`], 'relative sources are never fetched');
});

test('createRemoteSizer falls back to GET when HEAD carries no content-length', async () => {
  const { fetchImpl, calls } = sizeFetch({
    [SVG]: { headHeaders: {}, body: 'x'.repeat(45000) },
  });
  const size = createRemoteSizer({ fetch: fetchImpl });
  assert.equal(await size(SVG), 45000);
  assert.equal(await size(SVG), 45000);
  assert.deepEqual(calls, [`HEAD ${SVG}`, `GET ${SVG}`], 'the result is cached per URL');
});

test('validateHtml stays synchronous and skips remote checks without a fetcher', () => {
  const html = page(`<p><img src="${SVG}" alt="badge"></p>`);
  assert.deepEqual(validateHtml({ html }).issues, []);
});

test('links rule flags dead, relative, source-origin and target=_blank links', () => {
  const html = page('<p><a href="#">a</a><a href="../x">b</a>'
    + '<a href="https://www.example.com/pricing/">c</a>'
    + '<a href="https://x.test/" target="_blank">d</a></p>');
  const issues = validateHtml({ html, origin: 'https://www.example.com' }).issues
    .filter((i) => i.rule === 'links');
  assert.equal(issues.length, 4);
  assert.equal(issues.filter((i) => i.severity === 'warn').length, 1);
  assert.ok(issues.some((i) => i.message.includes('still points at the source site')));
});

test('headings rule rejects an empty heading element on any template', () => {
  const html = page('<h1>Hello</h1><h2></h2><h3> \u00a0 </h3>');
  const issues = validateHtml({ html }).issues.filter((i) => i.rule === 'headings');
  assert.equal(issues.length, 2);
  assert.deepEqual(issues.map((i) => i.severity), ['error', 'error']);
  assert.ok(issues[0].message.includes('<h2>'));
  assert.ok(issues[1].message.includes('<h3>'));
});

test('headings rule accepts a heading whose only content is an image', () => {
  const html = page(`<h1><img src="${IMG}" alt="Example"></h1><h2>Copy</h2>`);
  const issues = validateHtml({ html }).issues.filter((i) => i.rule === 'headings');
  assert.deepEqual(issues, []);
});

test('headings rule rejects block content nested inside a heading', () => {
  const html = page('<h1>Hello</h1><h2><div class="logo-wall"><div><div>'
    + `<img src="${IMG}" alt="a logo"></div></div></div></h2>`);
  const issues = validateHtml({ html }).issues.filter((i) => i.rule === 'headings');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'error');
  assert.ok(issues[0].message.includes('<h2> contains a nested <div>'), issues[0].message);
});

test('headings rule rejects a heading, table or paragraph nested in a heading', () => {
  const cases = ['<h2><h2>Integration with Popular Tools</h2> Businesses depend…</h2>',
    '<h2>Compare<table><tr><td>a</td></tr></table></h2>',
    '<h2>Lead<p>a paragraph the parser hoists out</p></h2>'];
  for (const body of cases) {
    const issues = validateHtml({ html: page(`<h1>Hello</h1>${body}`) }).issues
      .filter((i) => i.rule === 'headings');
    assert.ok(issues.length >= 1, body);
    assert.equal(issues[0].severity, 'error');
  }
});

test('headings rule accepts inline markup inside a heading', () => {
  const html = page('<h1>Hello</h1><h2><em>01.</em> Templates &amp; '
    + '<a href="/templates">Customization</a></h2>');
  const issues = validateHtml({ html }).issues.filter((i) => i.rule === 'headings');
  assert.deepEqual(issues, []);
});

test('leakage rule finds placeholder text and reports it once per pattern', () => {
  const html = page('<p>Lorem ipsum dolor</p><p>TODO: write copy</p>');
  const messages = validateHtml({ html }).issues.filter((i) => i.rule === 'leakage');
  assert.equal(messages.length, 2);
});

test('leakage rule keeps a bracketed placeholder that the source itself writes', () => {
  const html = page('<h1>Jotform vs. Typeform [2026 Guide]</h1>'
    + '<p>Open with “Dear [First Name],” and keep it short.</p>'
    + '<ul><li>Ask [Company Name] for the signed copy.</li></ul>'
    + '<p>Manual handoffs leave undefined processes behind.</p>');
  const sourceText = 'Jotform vs. Typeform [2026 Guide] Open with “Dear [First Name],” '
    + 'and keep it short. Ask [Company Name] for the signed copy. Manual handoffs leave undefined '
    + 'processes behind.';
  assert.deepEqual(
    validateHtml({ html, sourceText }).issues.filter((i) => i.rule === 'leakage'),
    [],
    'the source paints the same words in the same prose: it is copy, not scaffolding',
  );
  const strict = validateHtml({ html }).issues.filter((i) => i.rule === 'leakage');
  assert.equal(strict.length, 2, 'without the source to compare against the rule stays strict');
});

test('leakage rule still fails on a placeholder the source does not carry', () => {
  const sourceText = 'A page about customer portals.';
  const cases = [
    ['<p>Dear [First Name], welcome aboard.</p>', /First Name/],
    ['<p>The template returned undefined for every row.</p>', /undefined/],
    ['<div class="cards"><div><div>[Company Name]</div></div></div>', /Company Name/],
    ['<p>Lorem ipsum dolor sit amet.</p>', /Lorem ipsum/],
    ['<p>TODO: write the intro.</p>', /TODO/],
  ];
  for (const [body, pattern] of cases) {
    const issues = validateHtml({ html: page(body), sourceText }).issues
      .filter((i) => i.rule === 'leakage');
    assert.equal(issues.length, 1, body);
    assert.match(issues[0].message, pattern);
  }
});

test('leakage rule reads the source text out of the source HTML', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migration-leak-'));
  const file = path.join(dir, 'post.html');
  await writeFile(file, page('<p>Write “Hi [First Name]” in the subject line.</p>'
    + `<p><img src="${IMG}" alt="Jotform vs. Typeform [2025 Guide]"></p>`));
  const sourceHtml = '<html><head><title>t</title><script>var x = "[Nope Here]";</script></head>'
    + '<body><p class="x">Write &#8220;Hi [First Name]&#8221; in the subject line.</p>'
    + '<img src="a.png" alt="Jotform vs. Typeform [2025 Guide]"></body>'
    + '</html>';
  const clean = await validateFile(file, { sourceHtml });
  assert.deepEqual(clean.issues.filter((i) => i.rule === 'leakage'), []);
  await writeFile(file, page('<p>Write “Hi [Last Name]” in the subject line.</p>'));
  const dirty = await validateFile(file, { sourceHtml });
  assert.equal(dirty.issues.filter((i) => i.rule === 'leakage').length, 1);
});

test('site rules load from a directory and add their own issues', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migration-rules-'));
  await writeFile(
    path.join(dir, 'no-hubspot-embed.mjs'),
    'export function check(doc) {\n'
    + '  const bad = /hs-form/.test(doc.html);\n'
    + "  return bad ? [{ message: 'raw HubSpot embed; use the widget block' }] : [];\n"
    + '}\n',
  );
  const rules = await loadSiteRules(dir);
  assert.deepEqual(rules.map((r) => r.name), ['no-hubspot-embed']);
  const file = path.join(dir, 'page.html');
  await writeFile(file, page('<p>form: hs-form</p>'));
  const result = await validateFile(file, { rulesDir: dir });
  assert.equal(result.pass, false);
  assert.equal(result.issues.at(-1).rule, 'no-hubspot-embed');
  assert.deepEqual(await loadSiteRules(path.join(dir, 'missing')), []);
});

test('site rules receive doc.path and their level maps onto severity', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migration-rules-path-'));
  await writeFile(
    path.join(dir, 'nav-only.mjs'),
    'export function check(doc) {\n'
    + '  if (!/(^|\\/)nav$/.test(doc.path)) return [];\n'
    + "  return [{ rule: 'nav-only', level: 'warn', message: 'seen at ' + doc.path }];\n"
    + '}\n',
  );
  const other = path.join(dir, 'index.html');
  await writeFile(other, page('<p>hello</p>'));
  assert.deepEqual(
    (await validateFile(other, { rulesDir: dir })).issues.filter((i) => i.rule === 'nav-only'),
    [],
  );
  const navFile = path.join(dir, 'nav.html');
  await writeFile(navFile, page('<p>hello</p>'));
  const navResult = await validateFile(navFile, { rulesDir: dir });
  const [issue] = navResult.issues.filter((i) => i.rule === 'nav-only');
  assert.equal(issue.message, 'seen at /nav');
  assert.equal(issue.severity, 'warn');
  assert.equal(navResult.pass, true, 'a warn-level site rule never fails the gate');
  assert.equal(navResult.warnings >= 1, true);
});

test('fragment documents (nav, footer, fragments/*) need no metadata block', () => {
  assert.equal(isFragmentPath('/nav'), true);
  assert.equal(isFragmentPath('/footer'), true);
  assert.equal(isFragmentPath('/fragments/promo'), true);
  assert.equal(isFragmentPath('/pricing'), false);
  const html = '<body><header></header><main><div><ul><li><a href="/x">X</a></li></ul></div>'
    + '</main><footer></footer></body>';
  const asFragment = validateHtml({ html, docPath: '/footer' });
  assert.equal(asFragment.issues.filter((i) => i.rule === 'metadata').length, 0);
  const asPage = validateHtml({ html, docPath: '/pricing' });
  assert.equal(asPage.issues.filter((i) => i.rule === 'metadata').length, 1);
});

test('project leakage rules override the default set', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ecp-rules-'));
  await mkdir(path.join(dir, 'rules'), { recursive: true });
  await writeFile(
    path.join(dir, 'rules', 'leakage.json'),
    JSON.stringify({ leaks: ['\\bFOO\\b'], proseLeaks: [] }),
  );
  const rules = await loadLeakRules(
    resolvePaths({ MIGRATION_PROJECT_DIR: dir }),
  );
  assert.equal(rules.leaks.length, 1);
  assert.ok(rules.leaks[0].test('a FOO b'));
  const defaults = await loadLeakRules(
    resolvePaths({ MIGRATION_PROJECT_DIR:
      await mkdtemp(path.join(os.tmpdir(), 'ecp-')) }),
  );
  assert.ok(defaults.leaks.some((re) => re.test('lorem ipsum')));
});

test('invalid leakage patterns throw with context', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ecp-bad-'));
  await mkdir(path.join(dir, 'rules'), { recursive: true });
  await writeFile(
    path.join(dir, 'rules', 'leakage.json'),
    JSON.stringify({ leaks: ['[invalid(regex'], proseLeaks: [] }),
  );
  await assert.rejects(
    () => loadLeakRules(resolvePaths({ MIGRATION_PROJECT_DIR: dir })),
    /Invalid leakage pattern.*\[invalid\(regex/,
  );
});

test(
  'validateFile applies project leakage rules when rules dir exists',
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ecp-leak-'));
    await mkdir(path.join(dir, 'rules'), { recursive: true });
    await writeFile(
      path.join(dir, 'rules', 'leakage.json'),
      JSON.stringify({ leaks: ['\\bFORBIDDEN_TOKEN\\b'], proseLeaks: [] }),
    );
    const html = page('<p>The FORBIDDEN_TOKEN is here</p>');
    const file = path.join(dir, 'test.html');
    await writeFile(file, html);
    const result = await validateFile(file, {
      rulesDir: path.join(dir, 'rules'),
    });
    const leaks = result.issues.filter((i) => i.rule === 'leakage');
    assert.equal(leaks.length, 1);
    assert.ok(leaks[0].message.includes('FORBIDDEN_TOKEN'));
  },
);

test(
  'validateFile passes without project rules when rules dir does not exist',
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ecp-noruled-'));
    const html = page('<p>Any text is fine</p>');
    const file = path.join(dir, 'test.html');
    await writeFile(file, html);
    const result = await validateFile(file, {
      rulesDir: path.join(dir, 'rules'),
    });
    const leaks = result.issues.filter((i) => i.rule === 'leakage');
    assert.equal(leaks.length, 0);
  },
);

test('CLI with no arguments exits 1 and shows usage', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'validate-cli-test-'));
  const configPath = path.join(dir, 'site.config.json');
  await writeFile(configPath, JSON.stringify({
    origin: 'https://example.com',
    sitemapIndex: 'https://example.com/sitemap.xml',
    exclusions: {},
    overlaySelectors: [],
    viewports: [1440],
    concurrency: { fetch: 2, browser: 2, da: 2 },
    rateLimit: { requestsPerSecond: 2 },
    thresholds: {},
    bundles: { pageTree: 'page-tree-bundle.js' },
    templateSeeds: {},
    da: {},
    templates: {},
  }));
  const env = { ...process.env, MIGRATION_CONFIG: configPath };
  const result = await execFileP(process.execPath, [validateCli], { env })
    .catch((e) => e);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Usage: validate\.mjs <file\.html>/);
});
