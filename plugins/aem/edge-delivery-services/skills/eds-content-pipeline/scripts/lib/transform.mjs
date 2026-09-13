import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { flag } from './args.mjs';
import { loadConfig, originAliasHosts } from './config.mjs';
import { resolvePaths } from './paths.mjs';
import { loadPrepRecipe } from './state.mjs';
import { createClient } from './http.mjs';
import * as importer from './importer.mjs';
const { FileUtils } = importer;

const CONTRACT = ['match', 'transformDOM', 'generateDocumentPath'];
const DROP_TAGS = 'script, style, noscript, template, link, meta, title, base';
const ICON_RE = /^icon icon-[a-z0-9-]+$/;
const DROP_ATTRS = new Set(['style', 'id', 'target', 'srcset', 'sizes', 'loading', 'decoding']);
const USAGE = 'Usage: transform.mjs <url|file.html> --template <t> [--url <source-url>] '
  + '[--out <file>] [--params <json>]';

const warn = (code, message) => ({ code, message });
const titleCase = (key) => key.replace(/(^|-)([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());

/**
 * Loads a template transformer and asserts the transformer contract.
 *
 * @param {string} template Template name, e.g. `case-study`.
 * @param {object} [options]
 * @param {string} [options.dir] Transformer directory; defaults to
 *   `<project>/transformers`.
 * @param {object} [options.config] Site config; `templates.<t>.transformer` names the
 *   module to load instead of `<t>.mjs`, so several templates share one transformer.
 * @returns {Promise<{template: string, file: string, match: Function,
 *   transformDOM: Function, generateDocumentPath: Function, version:
 *   string}>} The transformer.
 * @throws {Error} When the module is missing or does not export the
 *   contract.
 */
export async function loadTransformer(template, { dir, config } = {}) {
  const base = dir ?? path.join(resolvePaths().siteDir, 'transformers');
  const name = config?.templates?.[template]?.transformer ?? template;
  const file = path.join(base, `${name}.mjs`);
  const module = await import(pathToFileURL(file).href).catch((err) => {
    throw new Error(
      `No transformer for template "${template}" at ${file}
      (${err.message}); author it there (see
      references/transformer-contract.md)`,
    );
  });
  const missing = CONTRACT.filter(
    (name) => typeof module[name] !== 'function',
  );
  if (missing.length) {
    throw new Error(`Transformer ${file} breaks the contract: it must
      export ${missing.join(', ')} as function(s)`);
  }
  return {
    template,
    file,
    match: module.match,
    transformDOM: module.transformDOM,
    generateDocumentPath: module.generateDocumentPath,
    version: String(module.version ?? '0'),
  };
}

function metaContent(document, selector) {
  const el = document.querySelector(selector);
  if (!el) return '';
  return (el.getAttribute('content') ?? el.getAttribute('href') ?? '').trim();
}

/**
 * Reads the page metadata a DA `Metadata` block needs from the
 * source head.
 *
 * @param {Document} document Source document parsed by jsdom.
 * @returns {object} Non-empty `title`, `description`, `image`,
 *   `canonical`, `publication-date`.
 */
export function extractMetadata(document) {
  const title = (document.querySelector('title')?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const published = metaContent(document, 'meta[property="article:published_time"]');
  const entries = {
    title: title || metaContent(document, 'meta[property="og:title"]'),
    description: metaContent(document, 'meta[name="description"]')
      || metaContent(document, 'meta[property="og:description"]'),
    image: metaContent(document, 'meta[property="og:image"]'),
    canonical: metaContent(document, 'link[rel="canonical"]'),
    'publication-date': published.slice(0, 10),
  };
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== ''));
}

function metadataRows(document, metadata) {
  return Object.entries(metadata).map(([key, value]) => {
    if (key !== 'image') return [key, value];
    const img = document.createElement('img');
    img.setAttribute('src', value);
    img.setAttribute('alt', '');
    return [key, img];
  });
}

function appendMetadataBlock(document, sections, metadata, warnings) {
  const filled = { title: '', description: '', ...metadata };
  for (const key of ['title', 'description']) {
    if (!filled[key]) warnings.push(warn('metadata', `source has no page ${key}`));
  }
  const block = importer.Blocks.createBlock(document, {
    name: 'metadata',
    cells: metadataRows(document, filled),
  });
  sections[sections.length - 1].append(block);
}

function sectionMetadata(document, section) {
  const rows = [...section.attributes]
    .filter((attr) => attr.name.startsWith('data-section-'))
    .map((attr) => [titleCase(attr.name.slice('data-section-'.length)), attr.value]);
  for (const [key] of rows) section.removeAttribute(`data-section-${key.toLowerCase()}`);
  if (!rows.length) return;
  section.append(
    importer.Blocks.createBlock(document, {
      name: 'section-metadata',
      cells: rows,
    }),
  );
}

function stripAttributes(el, keepClass) {
  for (const attr of [...el.attributes]) {
    const drop = DROP_ATTRS.has(attr.name) || attr.name.startsWith('on')
      || attr.name.startsWith('data-') || (attr.name === 'class' && !keepClass);
    if (drop) el.removeAttribute(attr.name);
  }
}

function fixImage(el, ctx) {
  el.setAttribute('src', el.src);
  if (el.hasAttribute('alt')) return;
  el.setAttribute('alt', '');
  ctx.warnings.push(warn('media', `img ${el.src} had no alt attribute`));
}

// EDS serves `/templates/case-management`, not `/templates/case-management/`:
// `generateDocumentPath` stores documents without the source's trailing slash, so the internal
// links between them lose it too, or every intra-site link 404s on `.aem.page`.
// The site root keeps its single slash; query and fragment ride along unchanged.
function internalHref(absolute) {
  const { pathname, search, hash } = new URL(absolute);
  return `${pathname.replace(/\/+$/, '') || '/'}${search}${hash}`;
}

// A site links to itself under several spellings: the canonical `https://www.example.com`
// origin, the same host over `http`, and both over the bare apex `example.com`. All of them are
// the same site and localise; a different host that merely ends in the origin's name
// (`learn.example.com`, `notexample.com`) is external, so the comparison is on the whole
// hostname minus `www.`.
const hostOf = (url) => url.hostname.replace(/^www\./i, '').toLowerCase();

/** True when `absolute` points at one of the site's origin alias hosts. */
export function isInternal(absolute, hosts) {
  const url = new URL(absolute);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return hosts.includes(hostOf(url));
}

function fixAnchor(el, ctx) {
  const href = el.getAttribute('href') ?? '';
  if (!href || href === '#' || /^javascript:/i.test(href)) {
    ctx.warnings.push(warn('links', `unwrapped anchor with unusable href "${href}"`));
    el.replaceWith(...el.childNodes);
    return;
  }
  if (href.startsWith('#')) return;
  const absolute = el.href;
  const internal = isInternal(absolute, ctx.hosts);
  el.setAttribute('href', internal ? internalHref(absolute) : absolute);
}

function keepsClass(el, section) {
  if (ICON_RE.test(el.getAttribute('class') ?? '')) return true;
  return el.tagName === 'DIV' && el.parentElement === section && el.hasAttribute('class');
}

function sanitizeSection(section, ctx) {
  for (const el of section.querySelectorAll(DROP_TAGS)) {
    ctx.warnings.push(warn('skeleton', `removed forbidden <${el.tagName.toLowerCase()}> element`));
    el.remove();
  }
  for (const el of section.querySelectorAll('*')) {
    if (el.tagName === 'IMG') fixImage(el, ctx);
    if (el.tagName === 'A') fixAnchor(el, ctx);
    stripAttributes(el, keepsClass(el, section));
  }
  stripAttributes(section, false);
}

function prepareSections(document, root, ctx) {
  const children = [...root.children];
  let sections = children;
  if (!children.length || children.some((el) => el.tagName !== 'DIV')) {
    const section = document.createElement('div');
    for (const el of children) section.append(el);
    ctx.warnings.push(warn('sections', 'transformDOM returned loose content; wrapped it in '
      + 'one section div'));
    sections = [section];
  }
  for (const section of sections) {
    sectionMetadata(document, section);
    sanitizeSection(section, ctx);
  }
  return sections;
}

function serialize(sections) {
  const body = sections.map((section) => `    ${section.outerHTML}`).join('\n');
  return `<body>\n  <header></header>\n  <main>\n${body}\n  </main>\n`
    + '  <footer></footer>\n</body>\n';
}

/**
 * Hashes the normalised source root so a re-run can tell whether the page changed.
 *
 * @param {string} html Source page HTML.
 * @param {string} [rootSelector='main'] Content root selector; falls back to `<body>`.
 * @returns {string} Hex sha256 of the root markup without scripts, comments or extra whitespace.
 */
export function contentHash(html, rootSelector = 'main') {
  const { document } = new JSDOM(html).window;
  const root = document.querySelector(rootSelector) ?? document.body;
  const clone = root.cloneNode(true);
  for (const el of clone.querySelectorAll(DROP_TAGS)) el.remove();
  const normalised = clone.innerHTML
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalised).digest('hex');
}

function rootElement(result, transformer) {
  const element = result?.nodeType === 1 ? result : result?.element;
  if (element?.nodeType === 1) return element;
  throw new Error(`Transformer "${transformer.template}" transformDOM returned `
    + `${typeof result}; it must return the main element or { element }`);
}

/**
 * Runs one transformer over one source page and serialises the DA document.
 *
 * @param {object} options
 * @param {string} options.html Source page HTML.
 * @param {string} options.url Source page URL (jsdom base URL).
 * @param {object} options.transformer Result of {@link loadTransformer}.
 * @param {object} [options.params] Transformer parameters; `sourceRoot` drives the hash.
 * @param {string[]} options.hosts Hosts that count as the source site
 *   (`originAliasHosts(config)`); required, so no runner reads config behind a caller's back.
 * @param {string[]} [options.strip] Selectors of site overlays (cookie banners, modals — the
 *   `page-prep.json` recipe) removed from the source document before anything reads it.
 * @returns {Promise<{path: string, html: string, metadata: object, hash: string,
 *   warnings: object[]}>} The DA document and its provenance.
 * @throws {Error} When `match` is false or `transformDOM` returns no element.
 */
export async function transformHtml({
  html, url, transformer, params = {}, hosts, strip = [],
}) {
  if (!hosts) {
    throw new Error('transformHtml needs hosts (originAliasHosts(config))');
  }
  const { document } = new JSDOM(html, { url }).window;
  for (const selector of strip) document.querySelectorAll(selector).forEach((el) => el.remove());
  if (!transformer.match(url, document)) {
    throw new Error(`Transformer "${transformer.template}" does not match ${url}; the URL is `
      + 'outside the template scope');
  }
  const metadata = extractMetadata(document);
  // `transformDOM` may be async: the `video` transformer fetches the Wistia oEmbed poster at
  // transform time. Awaiting a plain object is a no-op for the synchronous transformers.
  const result = await transformer.transformDOM({
    document, url, html, params, importer,
  });
  const warnings = [...(result?.warnings ?? [])];
  const ctx = { hosts, warnings };
  const sections = prepareSections(document, rootElement(result, transformer), ctx);
  appendMetadataBlock(document, sections, { ...metadata, ...(result?.metadata ?? {}) }, warnings);
  const docPath = FileUtils.sanitizePath(
    transformer.generateDocumentPath({ document, url }),
  );
  return {
    path: docPath,
    html: serialize(sections),
    metadata,
    hash: contentHash(html, params.sourceRoot ?? 'main'),
    warnings,
  };
}

async function loadSource(input, argv, config, paths) {
  if (/^https?:\/\//.test(input)) {
    const client = createClient({
      requestsPerSecond: config.rateLimit.requestsPerSecond,
      cacheDir: paths.cacheDir,
    });
    const res = await client.get(input);
    if (res.status !== 200) {
      throw new Error(`GET ${input} -> ${res.status}; check the URL or the source site`);
    }
    return { html: res.body, url: res.finalUrl };
  }
  const url = flag(argv, '--url');
  if (!url) throw new Error(`Transforming the file ${input} needs --url <source-url>`);
  return { html: await readFile(input, 'utf8'), url };
}

async function cli(argv) {
  const positional = argv.filter((a, i) => !a.startsWith('--')
    && !(i > 0 && argv[i - 1].startsWith('--')));
  const [input] = positional;
  const template = flag(argv, '--template');
  if (!input || !template) throw new Error(USAGE);
  const paths = resolvePaths();
  const config = await loadConfig(paths.configPath);
  const transformer = await loadTransformer(template, { config });
  const { html, url } = await loadSource(input, argv, config, paths);
  const params = {
    sourceRoot: config.templates?.[template]?.sourceRoot ?? 'main',
    ...JSON.parse(flag(argv, '--params', '{}')),
  };
  const result = await transformHtml({
    html, url, transformer, params, hosts: originAliasHosts(config),
    strip: (await loadPrepRecipe(paths)).selectors,
  });
  const fallbackOut = path.join(paths.siteDir, 'content', `${result.path.slice(1)}.html`);
  const out = flag(argv, '--out', fallbackOut);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, result.html, 'utf8');
  console.log(JSON.stringify({
    url,
    template,
    path: result.path,
    file: out,
    hash: result.hash,
    transformerVersion: transformer.version,
    bytes: Buffer.byteLength(result.html),
    warnings: result.warnings,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
