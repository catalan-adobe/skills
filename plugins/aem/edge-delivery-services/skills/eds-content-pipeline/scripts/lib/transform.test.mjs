import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import {
  contentHash, extractMetadata, isInternal, loadTransformer, transformHtml,
} from './transform.mjs';
import { validateFile } from './validate.mjs';


const execFileP = promisify(execFile);
const cli = fileURLToPath(new URL('./transform.mjs', import.meta.url));

const HOSTS = ['example.com'];
const SOURCE = `<!doctype html><html><head>
<title> Acme Flight School Revamps Operations </title>
<meta name="description" content="Acme Flight School gets off spreadsheets.">
<meta property="og:image" content="https://www.example.com/uploads/2023/10/5639711_orig.jpg">
<link rel="canonical" href="https://www.example.com/case-study/acme-flight-school/">
</head><body><div id="content">
<h1>Acme Flight School</h1>
<p class="lead" style="color:red">Flying <b>high</b> with Example.</p>
<img src="/uploads/2023/10/plane.jpg">
<script>window.dataLayer = [];</script>
<a href="/pricing/">See pricing</a>
</div></body></html>`;

const FIXTURE_TRANSFORMER = `export const version = '1.2.0';
export const match = (url) => /\\/case-study\\/[^/]+\\/$/.test(new URL(url).pathname);
export const generateDocumentPath = ({ url }) => new URL(url).pathname;
export function transformDOM({ document, params }) {
  const source = document.querySelector(params.sourceRoot);
  const main = document.createElement('div');
  const hero = document.createElement('div');
  hero.dataset.sectionStyle = 'dark';
  const block = document.createElement('div');
  block.className = 'columns hero';
  const row = document.createElement('div');
  for (const node of [source.querySelector('h1'), source.querySelector('img')]) {
    const cell = document.createElement('div');
    cell.append(node);
    row.append(cell);
  }
  block.append(row);
  hero.append(block);
  const body = document.createElement('div');
  body.append(...source.querySelectorAll('p, a, script'));
  main.append(hero, body);
  const warnings = [{ code: 'sidebar', message: 'Recent Posts sidebar dropped' }];
  return { element: main, warnings };
}
`;

async function fixtureDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migration-transform-'));
  await writeFile(path.join(dir, 'case-study.mjs'), FIXTURE_TRANSFORMER);
  await writeFile(path.join(dir, 'broken.mjs'), 'export const match = () => true;\n');
  return dir;
}

test('loadTransformer asserts the contract and reports missing modules', async () => {
  const dir = await fixtureDir();
  const transformer = await loadTransformer('case-study', { dir });
  assert.equal(transformer.version, '1.2.0');
  assert.equal(transformer.needsBrowser, false);
  assert.equal(typeof transformer.transformDOM, 'function');
  await assert.rejects(
    () => loadTransformer('broken', { dir }),
    /breaks the contract: it must export transformDOM, generateDocumentPath as function\(s\)/,
  );
  await assert.rejects(
    () => loadTransformer('missing', { dir }),
    /No transformer for template "missing" at .*missing\.mjs .*; write it in the template stage/,
  );
});

test('transformHtml serialises a DA skeleton that passes the content gate', async () => {
  const dir = await fixtureDir();
  const transformer = await loadTransformer('case-study', { dir });
  const result = await transformHtml({
    html: SOURCE,
    url: 'https://www.example.com/case-study/acme-flight-school/',
    transformer,
    params: { sourceRoot: '#content' },
    hosts: HOSTS,
  });
  assert.equal(result.path, '/case-study/acme-flight-school');
  assert.match(result.html, /^<body>\n {2}<header><\/header>\n {2}<main>\n/);
  assert.match(result.html, /<\/main>\n {2}<footer><\/footer>\n<\/body>\n$/);
  assert.match(result.html, /<div class="columns hero"><div><div><h1>Acme Flight School<\/h1>/);
  assert.match(result.html, /<div class="section-metadata"><div><div>Style<\/div>/);
  assert.match(result.html, /<div class="metadata">/);
  assert.match(result.html, /<div>description<\/div><div>Acme Flight School gets off spreadsheets/);
  assert.ok(!result.html.includes('<script'), 'scripts are dropped');
  assert.ok(!result.html.includes('style='), 'style attributes are dropped');
  assert.ok(!result.html.includes('class="lead"'), 'default-content classes are dropped');
  const planeSrc = 'https://www.example.com/uploads/2023/10/plane.jpg';
  assert.ok(result.html.includes(`src="${planeSrc}" alt=""`), 'img src absolutised, alt added');
  assert.match(result.html, /<a href="\/pricing">See pricing<\/a>/);
  assert.deepEqual(result.warnings, [
    { code: 'sidebar', message: 'Recent Posts sidebar dropped' },
    { code: 'media', message: `img ${planeSrc} had no alt attribute` },
    { code: 'skeleton', message: 'removed forbidden <script> element' },
  ]);
  const file = path.join(dir, 'acme-flight-school.html');
  await writeFile(file, result.html);
  const verdict = await validateFile(file, {
    origin: 'https://www.example.com',
    docPath: result.path,
  });
  assert.deepEqual(verdict.issues.filter((i) => i.severity === 'error'), []);
  assert.equal(verdict.pass, true);
});

test('internal links lose their trailing slash; the root and externals keep theirs', async () => {
  const dir = await fixtureDir();
  const transformer = await loadTransformer('case-study', { dir });
  const links = ['/templates/foo/', '/', '/contact/?utm=x', '/blog/#top',
    'https://learn.example.com/article/abc/', 'https://www.example.com/health/templates/']
    .map((href) => `<a href="${href}">link</a>`).join('');
  const result = await transformHtml({
    html: SOURCE.replace('<a href="/pricing/">See pricing</a>', links),
    url: 'https://www.example.com/case-study/acme-flight-school/',
    transformer,
    params: { sourceRoot: '#content' },
    hosts: HOSTS,
  });
  const { document } = new JSDOM(`<!doctype html><html>${result.html}</html>`).window;
  assert.deepEqual([...document.querySelectorAll('main a')].map((a) => a.getAttribute('href')), [
    '/templates/foo',
    '/',
    '/contact?utm=x',
    '/blog#top',
    'https://learn.example.com/article/abc/',
    '/health/templates',
  ]);
});

test('the bare apex and the http spelling of the origin localise too', async () => {
  const dir = await fixtureDir();
  const transformer = await loadTransformer('case-study', { dir });
  const links = ['https://example.com/health/', 'http://example.com/health/contact/',
    'http://www.example.com/pricing/', 'https://example.com', 'https://notexample.com/health/',
    'https://learn.example.com/article/abc/']
    .map((href) => `<a href="${href}">link</a>`).join('');
  const result = await transformHtml({
    html: SOURCE.replace('<a href="/pricing/">See pricing</a>', links),
    url: 'https://www.example.com/case-study/acme-flight-school/',
    transformer,
    params: { sourceRoot: '#content' },
    hosts: HOSTS,
  });
  const { document } = new JSDOM(`<!doctype html><html>${result.html}</html>`).window;
  assert.deepEqual([...document.querySelectorAll('main a')].map((a) => a.getAttribute('href')), [
    '/health',
    '/health/contact',
    '/pricing',
    '/',
    'https://notexample.com/health/',
    'https://learn.example.com/article/abc/',
  ]);
});

test('extractMetadata keeps only the fields the source carries', () => {
  const { document } = new JSDOM(SOURCE).window;
  assert.deepEqual(extractMetadata(document), {
    title: 'Acme Flight School Revamps Operations',
    description: 'Acme Flight School gets off spreadsheets.',
    image: 'https://www.example.com/uploads/2023/10/5639711_orig.jpg',
    canonical: 'https://www.example.com/case-study/acme-flight-school/',
  });
});

test('transformHtml refuses out-of-scope URLs and bad transformDOM returns', async () => {
  const dir = await fixtureDir();
  const transformer = await loadTransformer('case-study', { dir });
  await assert.rejects(
    () => transformHtml({
      html: SOURCE, url: 'https://www.example.com/pricing/', transformer, hosts: HOSTS,
    }),
    /does not match https:\/\/www\.example\.com\/pricing\/; the URL is outside the template scope/,
  );
  const broken = { ...transformer, transformDOM: () => null };
  await assert.rejects(
    () => transformHtml({
      html: SOURCE,
      url: 'https://www.example.com/case-study/acme-flight-school/',
      transformer: broken,
      params: { sourceRoot: '#content' },
      hosts: HOSTS,
    }),
    /transformDOM returned object; it must return the main element or \{ element \}/,
  );
});

test('contentHash ignores scripts, comments and whitespace but tracks copy', () => {
  const base = contentHash(SOURCE, '#content');
  const noisy = SOURCE
    .replace('<script>window.dataLayer = [];</script>', '<script>other()</script>')
    .replace('<h1>', '<!-- hero -->\n   <h1>');
  assert.equal(contentHash(noisy, '#content'), base);
  const edited = SOURCE.replace('Acme Flight School<', 'Acme Air<');
  assert.notEqual(contentHash(edited, '#content'), base);
  assert.equal(contentHash(SOURCE, 'main'), contentHash(SOURCE, 'body'));
});

test('the CLI rejects incomplete invocations with the usage line', async () => {
  const failed = await execFileP(process.execPath, [cli, 'page.html']).catch((e) => e);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /Usage: transform\.mjs <url\|file\.html> --template <t>/);
});

test('isInternal accepts every alias host and rejects lookalikes', () => {
  const hosts = ['example.com', 'shop.example.com'];
  assert.equal(isInternal('http://example.com/a', hosts), true);
  assert.equal(isInternal('https://www.example.com/a', hosts), true);
  assert.equal(isInternal('https://shop.example.com/a', hosts), true);
  assert.equal(isInternal('https://learn.example.com/a', hosts), false);
  assert.equal(isInternal('https://notexample.com/a', hosts), false);
  assert.equal(isInternal('mailto:a@example.com', hosts), false);
});
