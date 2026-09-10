import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { flag } from './args.mjs';
import { loadConfig } from './config.mjs';
import { resolvePaths } from './paths.mjs';

const TOKEN_RE = new RegExp([
  '<!--[\\s\\S]*?-->',
  '<!(?<decl>\\w[^>]*)>',
  '</(?<close>[a-zA-Z][\\w-]*)\\s*>',
  '<(?<open>[a-zA-Z][\\w-]*)(?<attrs>(?:\\s+[\\w:.-]+'
    + '(?:\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s"\'>]+))?)*)\\s*(?<selfClose>/?)>',
].join('|'), 'g');
const ATTR_RE = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'source', 'track', 'wbr']);
const BLOCK_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const PROSE_TAGS = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const SOURCE_DROP_RE = /<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi;
const ENTITY_RE = /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp|rsquo|lsquo|ldquo|rdquo));/gi;

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '\u2019',
  lsquo: '\u2018',
  ldquo: '\u201c',
  rdquo: '\u201d',
};

function parseAttrs(raw) {
  const attrs = {};
  for (const m of raw.matchAll(ATTR_RE)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

function pushText(stack, raw) {
  if (!raw.trim()) return;
  stack[stack.length - 1].children.push({
    tag: '#text', attrs: {}, children: [], text: raw,
  });
}

function closeTag(stack, tag) {
  for (let i = stack.length - 1; i > 0; i -= 1) {
    if (stack[i].tag === tag) {
      stack.length = i;
      return;
    }
  }
}

function applyToken(stack, groups) {
  const top = stack[stack.length - 1];
  if (groups.decl) {
    top.children.push({
      tag: '#decl', attrs: {}, children: [], text: groups.decl,
    });
    return;
  }
  if (groups.close) {
    closeTag(stack, groups.close.toLowerCase());
    return;
  }
  if (!groups.open) return;
  const tag = groups.open.toLowerCase();
  const node = { tag, attrs: parseAttrs(groups.attrs ?? ''), children: [] };
  top.children.push(node);
  if (!groups.selfClose && !VOID_TAGS.has(tag)) stack.push(node);
}

// Load default leakage rules at module initialization for synchronous validateHtml.
const DEFAULT_LEAK_RULES = (() => {
  const fallback = fileURLToPath(
    new URL('./rules/leakage.default.json', import.meta.url),
  );
  const raw = JSON.parse(readFileSync(fallback, 'utf8'));
  const compile = (list) => list.map((s) => {
    try {
      return new RegExp(s, 'i');
    } catch (cause) {
      throw new Error(
        `Invalid pattern "${s}" in default rules:
          ${cause.message}`,
        { cause },
      );
    }
  });
  return {
    leaks: compile(raw.leaks),
    proseLeaks: compile(raw.proseLeaks ?? []),
  };
})();

/**
 * Loads leakage rules from the project directory, or the default set.
 *
 * @param {object} [paths] Paths from {@link resolvePaths}.
 * @returns {Promise<{leaks: RegExp[], proseLeaks: RegExp[]}>} Compiled rules.
 */
export async function loadLeakRules(paths = resolvePaths()) {
  const project = path.join(paths.projectDir, 'rules', 'leakage.json');
  const fallback = fileURLToPath(
    new URL('./rules/leakage.default.json', import.meta.url),
  );
  const raw = JSON.parse(
    await readFile(project, 'utf8').catch(
      () => readFile(fallback, 'utf8'),
    ),
  );
  const compile = (list) => list.map((s) => {
    try {
      return new RegExp(s, 'i');
    } catch (cause) {
      const file = project && /rules\/leakage/.test(project)
        ? project : fallback;
      throw new Error(
        `Invalid leakage pattern "${s}" in ${file}:
          ${cause.message}`,
        { cause },
      );
    }
  });
  return {
    leaks: compile(raw.leaks),
    proseLeaks: compile(raw.proseLeaks ?? []),
  };
}

/**
 * Parses a DA HTML body fragment into a small element tree.
 *
 * DA documents are a constrained subset (no scripts, no styles, no CDATA), so a tolerant
 * tokenizer is enough and keeps the runner dependency-free.
 *
 * @param {string} html Document source.
 * @returns {{tag: string, attrs: object, children: object[]}} Root node (`#root`).
 */
export function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  let last = 0;
  for (const m of html.matchAll(TOKEN_RE)) {
    pushText(stack, html.slice(last, m.index));
    last = m.index + m[0].length;
    applyToken(stack, m.groups);
  }
  pushText(stack, html.slice(last));
  return root;
}

/**
 * Collects every descendant node matching `predicate`, depth first.
 *
 * @param {object} node Start node (not tested itself).
 * @param {(node: object) => boolean} predicate Test applied to each descendant.
 * @param {object[]} [acc] Accumulator used by the recursion.
 * @returns {object[]} Matching nodes in document order.
 */
export function findAll(node, predicate, acc = []) {
  for (const child of node.children) {
    if (predicate(child)) acc.push(child);
    findAll(child, predicate, acc);
  }
  return acc;
}

/** Concatenates the text content of a node and its descendants. */
export function textOf(node) {
  if (node.tag === '#text') return node.text;
  return node.children.map(textOf).join('');
}

const isTag = (tag) => (node) => node.tag === tag;
const elements = (node) => node.children.filter((c) => !c.tag.startsWith('#'));
const classTokens = (node) => (node.attrs.class ?? '').trim().split(/\s+/).filter(Boolean);

/**
 * Returns the sections (direct `div` children of `main`) of a parsed DA document.
 *
 * @param {object} root Node returned by `parseHtml`.
 * @returns {object[]} Section nodes; empty when the document has no `main`.
 */
export function sectionsOf(root) {
  const main = findAll(root, isTag('main'))[0];
  return main ? elements(main).filter(isTag('div')) : [];
}

/**
 * Returns the block nodes of a parsed DA document (classed divs inside a section).
 *
 * @param {object} root Node returned by `parseHtml`.
 * @returns {object[]} Block nodes in document order.
 */
export function blocksOf(root) {
  const isBlock = (n) => n.tag === 'div' && n.attrs.class;
  return sectionsOf(root).flatMap((s) => elements(s).filter(isBlock));
}

const issue = (rule, message, severity = 'error') => ({ rule, severity, message });

function skeletonCheck(doc) {
  const issues = [];
  const banned = ['html', 'head', 'script', 'style', 'link', 'meta', 'title'];
  for (const tag of banned) {
    if (findAll(doc.root, isTag(tag)).length) {
      issues.push(issue('skeleton', `forbidden <${tag}> element: the pipeline injects head, `
        + 'scripts and styles from Code Bus'));
    }
  }
  if (findAll(doc.root, (n) => n.tag === '#decl').length) {
    issues.push(issue('skeleton', 'forbidden doctype declaration in a DA body fragment'));
  }
  const styled = findAll(doc.root, (n) => n.attrs.style !== undefined
    || Object.keys(n.attrs).some((a) => a.startsWith('on')));
  if (styled.length) {
    issues.push(issue('skeleton', `${styled.length} element(s) carry style= or on*= attributes; `
      + 'both are stripped on ingestion'));
  }
  if (findAll(doc.root, isTag('main')).length !== 1) {
    issues.push(issue('skeleton', 'expected exactly one <main> element'));
  }
  return issues;
}

function sectionsCheck(doc) {
  const main = findAll(doc.root, isTag('main'))[0];
  if (!main) return [];
  const issues = [];
  const strays = elements(main).filter((n) => n.tag !== 'div');
  if (strays.length) {
    issues.push(issue('sections', '<main> may only contain section divs, found: '
      + `${strays.map((n) => `<${n.tag}>`).join(', ')}`));
  }
  if (findAll(main, isTag('hr')).length) {
    issues.push(issue('sections', 'no <hr> between sections; the section div is the boundary'));
  }
  if (!sectionsOf(doc.root).length) {
    issues.push(issue('sections', '<main> has no section div'));
  }
  return issues;
}

function blockRowIssues(block, name) {
  const issues = [];
  const rows = elements(block);
  if (!rows.length) issues.push(issue('blocks', `block "${name}" has no rows`));
  for (const row of rows) {
    if (row.tag !== 'div') {
      issues.push(issue('blocks', `block "${name}" row must be a <div>, found <${row.tag}>`));
    } else {
      const cells = elements(row);
      if (!cells.length || cells.some((c) => c.tag !== 'div')) {
        issues.push(issue('blocks', `block "${name}" row must contain cell divs only`));
      }
      if (cells.length > 4) {
        issues.push(issue('blocks', `block "${name}" row has ${cells.length} cells; 4 is the max`));
      }
    }
  }
  return issues;
}

function blocksCheck(doc) {
  const issues = [];
  for (const block of blocksOf(doc.root)) {
    const [name] = classTokens(block);
    if (!BLOCK_NAME_RE.test(name)) {
      issues.push(issue('blocks', `invalid block name "${name}": alphanumeric and single `
        + 'hyphens only, never digit-first'));
    }
    issues.push(...blockRowIssues(block, name));
    const nested = findAll(block, (n) => n.tag === 'div' && n.attrs.class);
    if (nested.length) {
      issues.push(issue('blocks', `block "${name}" contains a nested block `
        + `"${classTokens(nested[0])[0]}"; EDS does not support nested blocks`));
    }
  }
  return issues;
}

const isIconSpan = (node) => node.tag === 'span'
  && /^icon icon-[a-z0-9-]+$/.test((node.attrs.class ?? '').trim());

function cellIssues(name, cell) {
  const issues = [];
  for (const node of findAll(cell, (n) => !n.tag.startsWith('#'))) {
    if (node.tag === 'div') {
      issues.push(issue('cells', `block "${name}" cell contains a <div>; cells hold content, `
        + 'not more structure'));
    } else if (node.tag === 'span' && !isIconSpan(node)) {
      issues.push(issue('cells', `block "${name}" cell contains a <span>; spans are unwrapped `
        + 'in cells (icons must be <span class="icon icon-name">)'));
    } else if (!isIconSpan(node)
      && (node.attrs.class !== undefined || node.attrs.id !== undefined)) {
      issues.push(issue('cells', `block "${name}" cell has a class/id on <${node.tag}>; `
        + 'decoration sets those'));
    }
  }
  return issues;
}

function cellsCheck(doc) {
  const issues = [];
  for (const block of blocksOf(doc.root)) {
    const [name] = classTokens(block);
    for (const row of elements(block)) {
      for (const cell of elements(row)) issues.push(...cellIssues(name, cell));
    }
  }
  return issues;
}

function metadataBlockIssues(block) {
  const issues = [];
  const rows = elements(block);
  if (rows.some((row) => elements(row).length !== 2)) {
    issues.push(issue('metadata', 'every metadata row needs exactly 2 cells (key, value)'));
  }
  const keys = rows.map((row) => textOf(elements(row)[0] ?? row).trim().toLowerCase());
  for (const key of ['title', 'description']) {
    if (!keys.includes(key)) issues.push(issue('metadata', `metadata block has no "${key}" row`));
  }
  return issues;
}

function metadataCheck(doc) {
  const issues = [];
  const named = blocksOf(doc.root).filter((b) => /^meta/i.test(classTokens(b)[0] ?? ''));
  const blocks = named.filter((b) => classTokens(b)[0] === 'metadata');
  for (const wrong of named.filter((b) => classTokens(b)[0] !== 'metadata')) {
    issues.push(issue('metadata', `block class "${classTokens(wrong)[0]}" is silently ignored; `
      + 'the Page Metadata block class is exactly "metadata"'));
  }
  if (blocks.length > 1) issues.push(issue('metadata', 'only one metadata block per page'));
  blocks.forEach((block) => issues.push(...metadataBlockIssues(block)));
  if (!blocks.length && !doc.fragment) {
    issues.push(issue('metadata', 'no metadata block; the page ships no title'));
  }
  return issues;
}

function mediaCheck(doc) {
  const issues = [];
  for (const img of findAll(doc.root, isTag('img'))) {
    const src = img.attrs.src ?? '';
    if (!/^https?:\/\//.test(src)) {
      issues.push(issue('media', `img src "${src}" is not an absolute URL; the preview step `
        + 'cannot fetch it and renders src="about:error"'));
    }
    if (img.attrs.alt === undefined) {
      issues.push(issue('media', `img src "${src}" has no alt attribute`));
    }
  }
  const iconish = (n) => n.tag === 'span' && /\bicon\b/.test(n.attrs.class ?? '');
  for (const span of findAll(doc.root, iconish)) {
    if (!isIconSpan(span)) {
      issues.push(issue('media', `icon span class "${span.attrs.class}" must be `
        + '"icon icon-<name>"'));
    }
  }
  return issues;
}

/** Content-bus hard cap for an SVG referenced from an `<img src>` (aem.live/docs/limits). */
export const MAX_SVG_BYTES = 40000;

/** Media Bus hard cap for a raster referenced from an `<img src>` (aem.live/docs/limits). */
export const MAX_RASTER_BYTES = 20000000;

async function measure(fetchImpl, url) {
  const head = await fetchImpl(url, { method: 'HEAD' }).catch(() => null);
  const length = head?.ok ? Number(head.headers.get('content-length')) : NaN;
  if (Number.isFinite(length) && length > 0) return length;
  const res = await fetchImpl(url, { method: 'GET' });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}: cannot measure the asset`);
  return (await res.arrayBuffer()).byteLength;
}

/**
 * Creates a remote size probe: HEAD for `content-length`, GET when the header is absent.
 *
 * Results are memoized per URL so one run measures each asset once.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch] Fetch implementation; injected by tests.
 * @returns {(url: string) => Promise<number>} Size in bytes.
 */
export function createRemoteSizer({ fetch: fetchImpl = globalThis.fetch } = {}) {
  const cache = new Map();
  return function size(url) {
    if (!cache.has(url)) cache.set(url, measure(fetchImpl, url));
    return cache.get(url);
  };
}

const SVG_URL_RE = /^https?:\/\/\S+\.svg(\?|#|$)/i;
// DA-hosted assets answer 401 to an anonymous HEAD and `media.mjs` wrote them within the caps.
const DA_ASSET_RE = /^https:\/\/content\.da\.live\//i;

function remoteImageUrls(root) {
  const srcs = findAll(root, isTag('img')).map((img) => img.attrs.src ?? '');
  return [...new Set(srcs.filter((src) => /^https?:\/\//.test(src) && !DA_ASSET_RE.test(src)))];
}

/**
 * Lists the absolute `.svg` URLs a document references from an `<img src>`, deduplicated.
 *
 * @param {object} root Node returned by `parseHtml`.
 * @returns {string[]} URLs in document order.
 */
export function svgImageUrls(root) {
  return remoteImageUrls(root).filter((src) => SVG_URL_RE.test(src));
}

/**
 * Lists the absolute non-SVG `<img src>` URLs a document references, deduplicated.
 *
 * @param {object} root Node returned by `parseHtml`.
 * @returns {string[]} URLs in document order.
 */
export function rasterImageUrls(root) {
  return remoteImageUrls(root).filter((src) => !SVG_URL_RE.test(src));
}

const CAPS = [
  {
    kind: 'svg',
    urls: svgImageUrls,
    over: (url, bytes) => `svg ${url} is ${bytes} bytes; content-bus rejects SVGs over 40 KB `
      + '\u2014 run media.mjs',
  },
  {
    kind: 'image',
    urls: rasterImageUrls,
    over: (url, bytes) => `image ${url} is ${bytes} bytes; Media Bus rejects images over 20 MB `
      + '\u2014 run media.mjs',
  },
];

async function capIssues(root, sizer, cap, max) {
  const issues = [];
  for (const url of cap.urls(root)) {
    const bytes = await sizer(url).catch((err) => {
      issues.push(issue(
        'media',
        `${cap.kind} ${url} could not be measured: ${err.message}`,
        'warn',
      ));
      return 0;
    });
    if (bytes > max) issues.push(issue('media', cap.over(url, bytes)));
  }
  return issues;
}

async function remoteMediaIssues(root, sizer, maxima) {
  const issues = [];
  for (const cap of CAPS) issues.push(...await capIssues(root, sizer, cap, maxima[cap.kind]));
  return issues;
}

function hrefIssue(href, label, origin) {
  if (!href || href === '#') return `link "${label}" has no usable href`;
  if (/^\.{1,2}\//.test(href)) return `document-relative href "${href}" breaks in production`;
  if (/^javascript:/i.test(href)) return `javascript: href "${href}" is stripped by the pipeline`;
  if (origin && href.startsWith(origin)) {
    return `href "${href}" still points at the source site; localize internal links`;
  }
  return null;
}

function linksCheck(doc) {
  const issues = [];
  for (const anchor of findAll(doc.root, isTag('a'))) {
    const href = anchor.attrs.href ?? '';
    const problem = hrefIssue(href, textOf(anchor).trim(), doc.origin ?? '');
    if (problem) issues.push(issue('links', problem));
    if (anchor.attrs.target === '_blank') {
      issues.push(issue('links', `href "${href}" sets target="_blank"; `
        + 'decorateExternalLinks does that at delivery', 'warn'));
    }
  }
  return issues;
}

const HEADING_TAG_RE = /^h[1-6]$/;
// A heading holds inline content and one optional image. A div, table, picture, list, paragraph
// or second heading inside one means a transformer cloned a whole source container into the
// heading: this parser keeps the nesting, but the browser's HTML parser hoists the block content
// out on ingestion and leaves an empty heading with loose text beside it.
const BLOCK_IN_HEADING = new Set(['div', 'table', 'picture', 'p', 'ul', 'ol',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

function nestedBlockIssues(node) {
  const [nested] = findAll(node, (n) => BLOCK_IN_HEADING.has(n.tag));
  if (!nested) return [];
  return [issue(
    'headings',
    `<${node.tag}> contains a nested <${nested.tag}>: a heading holds inline content only, and `
      + 'the HTML parser lifts block content out of it, dropping the copy on ingestion',
  )];
}

// axe's `empty-heading` audit fails a heading with neither text nor an image, and an empty
// heading in a generated document always means a transformer dropped its source copy in silence.
function headingsCheck(doc) {
  const issues = [];
  for (const node of findAll(doc.root, (n) => HEADING_TAG_RE.test(n.tag))) {
    if (!textOf(node).trim() && !findAll(node, isTag('img')).length) {
      issues.push(issue(
        'headings',
        `empty <${node.tag}> element: a heading needs text (or an image with alt text); `
          + 'an empty one fails axe empty-heading and hides copy the transformer dropped',
      ));
    }
    issues.push(...nestedBlockIssues(node));
  }
  return issues;
}

// `alt` and `title` are copy the page paints too: the featured image of a blog post carries the
// post title, brackets and all.
const ALT_RE = /\s(?:alt|title)\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const tagText = (tag) => {
  const match = ALT_RE.exec(tag);
  return match ? ` ${match[1] ?? match[2]} ` : ' ';
};

/**
 * Reduces a source page to comparable plain text: scripts and styles out, tags out (keeping the
 * `alt`/`title` copy they carry), entities decoded, whitespace collapsed.
 *
 * @param {string} html Source page HTML.
 * @returns {string} The text the page paints.
 */
export function htmlText(html) {
  return String(html ?? '')
    .replace(SOURCE_DROP_RE, ' ')
    .replace(/<[^>]*>/g, tagText)
    .replace(ENTITY_RE, (whole, dec, hex, name) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

const collapse = (text) => text.replace(/\s+/g, ' ');

function proseText(root) {
  return findAll(root, (n) => PROSE_TAGS.has(n.tag))
    .map((node) => [textOf(node), ...findAll(node, isTag('img')).map((img) => img.attrs.alt ?? '')])
    .map((parts) => collapse(parts.join(' ')))
    .join(' ');
}

// A match is authored copy when the document writes it as prose and the source writes
// the very same string; anything else — a match in a block cell, a heading, or a
// string the source never paints — stays a leak.
function leakMatch(doc, re) {
  const rgx = new RegExp(re.source, `${re.flags.replace('g', '')}g`);
  const matches = doc.html.match(rgx) ?? [];
  const isProseLeak = doc.rules.proseLeaks.some(
    (p) => p.source === re.source,
  );
  if (!isProseLeak || !doc.sourceText) return matches[0] ?? null;
  const prose = proseText(doc.root);
  const authored = (text) => doc.sourceText.includes(text)
    && prose.includes(text);
  return matches.find((text) => !authored(collapse(text))) ?? null;
}

function leakageCheck(doc) {
  const issues = [];
  for (const re of doc.rules.leaks) {
    const found = leakMatch(doc, re);
    if (found) {
      issues.push(issue(
        'leakage',
        `document leaks source scaffolding: "${found.slice(0, 60)}"`,
      ));
    }
  }
  return issues;
}

/** The built-in content-gate rules (§10.2), in execution order. */
export const RULES = [
  { name: 'skeleton', check: skeletonCheck },
  { name: 'sections', check: sectionsCheck },
  { name: 'blocks', check: blocksCheck },
  { name: 'cells', check: cellsCheck },
  { name: 'metadata', check: metadataCheck },
  { name: 'headings', check: headingsCheck },
  { name: 'media', check: mediaCheck },
  { name: 'links', check: linksCheck },
  { name: 'leakage', check: leakageCheck },
];

/**
 * Loads project rules from `<project>/rules/*.mjs`.
 *
 * Each module exports `check(doc) → issues[]`; the file name is the rule name.
 *
 * @param {string} dir Rules directory; a missing directory yields no rules.
 * @returns {Promise<{name: string, check: Function}[]>} Loaded rules.
 */
export async function loadSiteRules(dir) {
  let entries = [];
  try {
    entries = (await readdir(dir))
      .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const rules = [];
  for (const file of entries) {
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    if (typeof mod.check !== 'function') {
      throw new Error(`Site rule ${file} must export check(doc) => issues[]`);
    }
    rules.push({ name: path.basename(file, '.mjs'), check: mod.check });
  }
  return rules;
}

/**
 * Runs every rule over one DA HTML document.
 *
 * @param {object} options
 * @param {string} options.html Document source.
 * @param {string} [options.origin] Source-site origin; internal links to it are flagged.
 * @param {string} [options.docPath] DA path without extension, e.g. `/nav`; rules read `doc.path`.
 * @param {string} [options.sourceText] Plain text of the source page; the leakage rule excuses a
 *   bracketed placeholder or the word "undefined" that the source itself writes as prose.
 * @param {{name: string, check: Function}[]} [options.rules] Rules to run.
 * @returns {{pass: boolean, errors: number, warnings: number, issues: object[]}} Verdict.
 */
const FRAGMENT_PATHS = new Set(['/nav', '/footer']);

/**
 * Tells whether a DA path holds a fragment (nav, footer, `/fragments/**`) rather than a page.
 * Fragments carry no metadata block and no page `h1`.
 *
 * @param {string} docPath DA path without extension.
 * @returns {boolean} True for fragment documents.
 */
export function isFragmentPath(docPath) {
  return FRAGMENT_PATHS.has(docPath) || /(^|\/)fragments\//.test(docPath);
}

export function validateHtml({
  html, origin = '', docPath = '', sourceText = '', rules = RULES,
  leakRules = DEFAULT_LEAK_RULES,
}) {
  const doc = {
    path: docPath,
    html,
    root: parseHtml(html),
    origin,
    sourceText,
    fragment: isFragmentPath(docPath),
    rules: leakRules,
  };
  const issues = rules.flatMap((rule) => (rule.check(doc) ?? []).map((i) => ({
    rule: i.rule ?? rule.name,
    severity: i.severity ?? i.level ?? 'error',
    message: i.message,
  })));
  const errors = issues.filter((i) => i.severity === 'error').length;
  return {
    pass: errors === 0, errors, warnings: issues.length - errors, issues,
  };
}

/**
 * Runs every rule plus the remote media checks (over-cap SVGs) over one document.
 *
 * @param {object} options Everything {@link validateHtml} takes, plus:
 * @param {typeof fetch} [options.fetch] Fetch implementation used to measure remote
 *   SVGs.
 * @param {(url: string) => Promise<number>} [options.sizer] Reuse a sizer across
 *   documents.
 * @param {number} [options.maxSvgBytes] Cap in bytes; defaults to
 *   {@link MAX_SVG_BYTES}.
 * @param {number} [options.maxRasterBytes] Cap in bytes; defaults to
 *   {@link MAX_RASTER_BYTES}.
 * @returns {Promise<{pass: boolean, errors: number, warnings: number,
 *   issues: object[]}>} Verdict.
 */
export async function validateHtmlAsync(options) {
  const {
    fetch: fetchImpl, sizer, maxSvgBytes = MAX_SVG_BYTES,
    maxRasterBytes = MAX_RASTER_BYTES, ...rest
  } = options;
  const local = validateHtml(rest);
  const probe = sizer
    ?? (fetchImpl ? createRemoteSizer({ fetch: fetchImpl }) : null);
  if (!probe) return local;
  const maxima = { svg: maxSvgBytes, image: maxRasterBytes };
  const remote = await remoteMediaIssues(parseHtml(rest.html), probe, maxima);
  const issues = [...local.issues, ...remote];
  const errors = issues.filter((i) => i.severity === 'error').length;
  return {
    pass: errors === 0, errors, warnings: issues.length - errors, issues,
  };
}

/**
 * Validates one DA HTML file on disk, including the remote SVG size check.
 *
 * @param {string} file Path to the document.
 * @param {object} [options]
 * @param {string} [options.origin] Source-site origin.
 * @param {string} [options.rulesDir] Project rules directory.
 * @param {string} [options.docPath] DA path; defaults to `/<basename without
 *   .html>`.
 * @param {typeof fetch} [options.fetch] Fetch implementation; defaults to the
 *   global one.
 * @param {string} [options.sourceHtml] Source page HTML; its text is what the
 *   leakage rule compares the document against.
 * @returns {Promise<object>} `{ file, pass, errors, warnings, issues }`.
 */
export async function validateFile(file, {
  origin = '', rulesDir, docPath, sourceHtml = '',
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  const html = await readFile(file, 'utf8');
  const siteRules = rulesDir ? await loadSiteRules(rulesDir) : [];
  const projectDir = rulesDir ? path.dirname(rulesDir) : undefined;
  const leakRules = await loadLeakRules(
    projectDir ? resolvePaths({ MIGRATION_PROJECT_DIR: projectDir }) : resolvePaths(),
  );
  return {
    file,
    ...await validateHtmlAsync({
      html,
      origin,
      docPath: docPath ?? `/${path.basename(file, '.html')}`,
      sourceText: htmlText(sourceHtml),
      rules: [...RULES, ...siteRules],
      leakRules,
      fetch: fetchImpl,
    }),
  };
}

async function cli(argv) {
  const paths = resolvePaths();
  const file = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
  if (!file) {
    throw new Error('Usage: validate.mjs <file.html> [--origin <url>] [--rules-dir <dir>] '
      + '[--path <da-path>]');
  }
  const config = await loadConfig(paths.configPath);
  const result = await validateFile(file, {
    origin: flag(argv, '--origin', config.origin),
    rulesDir: flag(argv, '--rules-dir', path.join(paths.siteDir, 'rules')),
    docPath: flag(argv, '--path'),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
