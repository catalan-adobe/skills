/**
 * WebImporter-compatible DOM helpers used by the deterministic transformers.
 *
 * Every function is a pure DOM operation: it takes the nodes it works on and the owning
 * `document`, never imports jsdom itself, and never touches the filesystem or the network.
 */

const BACKGROUND_URL_RE = /background[^;:]*:[^;]*url\(\s*(['"]?)([^'")]+)\1\s*\)/i;
const ELEMENT_NODE = 1;

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function slug(segment) {
  return safeDecode(segment)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const BLOCK_TOKEN_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_CELLS_PER_ROW = 4;

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.some(hasValue);
  return true;
}

/**
 * Normalizes a URL or pathname to the EDS document path of the page.
 *
 * @param {string} input For example `https://www.knack.com/case-study/Kingdom-Air/` or `/x.html`.
 * @returns {string} Lower-case, hyphenated, no trailing slash; `/` becomes `/index`.
 */
function sanitizePath(input) {
  const raw = String(input ?? '').trim();
  const pathname = /^https?:\/\//i.test(raw) ? new URL(raw).pathname : raw;
  const segments = pathname
    .replace(/\.html?$/i, '')
    .split('/')
    .map(slug)
    .filter(Boolean);
  return segments.length ? `/${segments.join('/')}` : '/index';
}

/**
 * Removes every descendant of `root` matching one of `selectors`.
 *
 * @param {Element} root Subtree to clean, usually the source `main`.
 * @param {string[]|string} selectors CSS selectors of the nodes to drop.
 * @returns {number} How many elements were removed.
 */
function remove(root, selectors) {
  const list = typeof selectors === 'string' ? [selectors] : selectors;
  let removed = 0;
  for (const selector of list) {
    for (const element of root.querySelectorAll(selector)) {
      element.remove();
      removed += 1;
    }
  }
  return removed;
}

function backgroundUrl(element) {
  const match = BACKGROUND_URL_RE.exec(element.getAttribute('style') ?? '');
  return match ? match[2].trim() : null;
}

function insertBackgroundImg(element, src, document) {
  const img = document.createElement('img');
  img.setAttribute('src', src);
  img.setAttribute('alt', element.getAttribute('aria-label') ?? '');
  element.removeAttribute('style');
  if (element.firstElementChild) element.prepend(img);
  else element.replaceWith(img);
  return img;
}

/**
 * Turns inline `background-image` declarations into real `<img>` elements.
 *
 * The holder keeps its children when it has any (a `wp-block-cover` hero keeps its `<h1>`) and is
 * replaced outright when it is empty. The `style` attribute goes either way: DA strips it.
 *
 * @param {Element} root Subtree to convert; `root` itself is converted when it matches.
 * @param {Document} document Owning document, used to create the images.
 * @returns {Element[]} Created images in document order.
 */
function replaceBackgroundByImg(root, document) {
  const candidates = [root, ...root.querySelectorAll('[style*="url("]')];
  const images = [];
  for (const element of candidates) {
    const src = element.nodeType === ELEMENT_NODE ? backgroundUrl(element) : null;
    if (src) images.push(insertBackgroundImg(element, src, document));
  }
  return images;
}

const WIDTH_DESCRIPTOR_RE = /^\d+(?:\.\d+)?w$/;

function srcsetCandidates(value) {
  return String(value ?? '')
    .split(',')
    .map((part) => part.trim().split(/\s+/))
    .filter(([url, descriptor]) => url && WIDTH_DESCRIPTOR_RE.test(descriptor ?? ''))
    .map(([url, descriptor]) => ({ url, width: Number.parseFloat(descriptor) }))
    .sort((a, b) => a.width - b.width);
}

/**
 * Picks the source an `<img>` should keep: the widest srcset candidate still within the cap.
 *
 * WordPress publishes the untouched camera original as the last `srcset` candidate — 20–31 MB
 * on knack — which Media Bus rejects. Only `w` descriptors carry a width; `x` descriptors and a
 * bare `srcset` fall through to `src`. When every candidate is over the cap the smallest one wins,
 * so the document never points at the original.
 *
 * @param {Element} img Source image element.
 * @param {{maxWidth?: number}} [options] `maxWidth` defaults to 2048 pixels.
 * @returns {string} The chosen URL, or an empty string when the image has no source at all.
 */
export function pickImageSrc(img, { maxWidth = 2048 } = {}) {
  const candidates = srcsetCandidates(img.getAttribute('srcset'));
  const best = candidates.filter((c) => c.width <= maxWidth).at(-1) ?? candidates[0];
  return best?.url ?? img.getAttribute('src') ?? '';
}

function buildCell(document, value) {
  const cell = document.createElement('div');
  const items = (Array.isArray(value) ? value : [value]).filter(hasValue);
  cell.append(...items);
  return cell;
}

function buildRow(document, row, name) {
  const values = Array.isArray(row) ? row : [row];
  if (values.length > MAX_CELLS_PER_ROW) {
    throw new Error(`Block "${name}" row has ${values.length} cells; EDS block rows take at `
      + `most ${MAX_CELLS_PER_ROW} — split the row or add a variant`);
  }
  const rowElement = document.createElement('div');
  for (const value of values) rowElement.append(buildCell(document, value));
  return rowElement;
}

/**
 * Builds a block in the canonical `<div class="name variant">` form.
 *
 * Strings become text nodes, never markup: scraped source text cannot inject HTML.
 *
 * @param {Document} document Owning document.
 * @param {{name: string, variants?: string[], cells: Array}} spec Rows of cells; a cell is a
 *   string, a Node, or an array of both.
 * @returns {Element} The detached block element.
 * @throws {Error} On an invalid class token, no rows, or a row wider than four cells.
 */
function createBlock(document, { name, variants = [], cells }) {
  const tokens = [name, ...variants].map((token) => String(token).trim());
  const invalid = tokens.find((token) => !BLOCK_TOKEN_RE.test(token));
  if (invalid !== undefined) {
    throw new Error(`Invalid block class token "${invalid}": use lowercase a-z, 0-9 and single `
      + 'hyphens, e.g. "case-study-hero"');
  }
  if (!Array.isArray(cells) || cells.length === 0) {
    throw new Error(`Block "${name}" has no rows: pass cells as an array of rows`);
  }
  const block = document.createElement('div');
  block.className = tokens.join(' ');
  for (const row of cells) block.append(buildRow(document, row, name));
  return block;
}

/**
 * Builds the page `Metadata` block from a key/value map.
 *
 * @param {Document} document Owning document.
 * @param {object|Map} meta Keys such as `title`, `description`, `image`, `canonical`.
 * @returns {Element} `<div class="metadata">` with one row per non-empty key.
 * @throws {Error} When every value is empty.
 */
function getMetadataBlock(document, meta) {
  const source = meta instanceof Map ? [...meta.entries()] : Object.entries(meta ?? {});
  const entries = source.filter(([, value]) => hasValue(value));
  if (entries.length === 0) {
    throw new Error('Metadata block needs at least one key with a value (title, description)');
  }
  return createBlock(document, {
    name: 'metadata',
    cells: entries.map(([key, value]) => [String(key).toLowerCase().trim(), value]),
  });
}

const TEXT_NODE = 3;
const COMMENT_NODE = 8;

function metaKey(key) {
  const lower = String(key).toLowerCase().trim();
  return lower === 'style' ? 'Style' : lower;
}

function metaValue(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.every((item) => typeof item === 'string') ? list.join(', ') : list;
}

/**
 * Builds a `Section Metadata` block for the section it is appended to.
 *
 * @param {Document} document Owning document.
 * @param {object} props `style` becomes section classes; other keys become `data-*` attributes.
 * @returns {Element} `<div class="section-metadata">`.
 * @throws {Error} When every property is empty.
 */
export function sectionMetadata(document, props) {
  const entries = Object.entries(props ?? {}).filter(([, value]) => hasValue(value));
  if (entries.length === 0) {
    throw new Error('Section Metadata needs at least one property, e.g. { style: "dark" }');
  }
  return createBlock(document, {
    name: 'section-metadata',
    cells: entries.map(([key, value]) => [metaKey(key), metaValue(value)]),
  });
}

const isDroppable = (node) => (node.nodeType === COMMENT_NODE
  || (node.nodeType === TEXT_NODE && node.textContent.trim() === ''));

const isSeparator = (node) => node.nodeType === ELEMENT_NODE && node.tagName === 'HR';

const startsSection = (node, selectors) => node.nodeType === ELEMENT_NODE
  && selectors.some((selector) => node.matches(selector));

function groupChildren(nodes, selectors) {
  const groups = [[]];
  const open = () => {
    if (groups[groups.length - 1].length > 0) groups.push([]);
  };
  for (const node of nodes.filter((n) => !isDroppable(n))) {
    if (isSeparator(node)) open();
    else {
      if (startsSection(node, selectors)) open();
      groups[groups.length - 1].push(node);
    }
  }
  return groups.filter((group) => group.length > 0);
}

/**
 * Groups the children of `main` into EDS section `<div>`s.
 *
 * A new section opens at every element matching `breakSelectors` and at every `<hr>` (DA has no
 * `<hr>` separators — the section `<div>` is the boundary). Comments and blank text go.
 *
 * @param {Element} main Element whose children become sections.
 * @param {string[]} [breakSelectors] Selectors of elements that start a new section.
 * @returns {Element[]} The created sections, already attached to `main`.
 */
export function splitSections(main, breakSelectors = []) {
  const { ownerDocument } = main;
  const sections = groupChildren([...main.childNodes], breakSelectors).map((nodes) => {
    const section = ownerDocument.createElement('div');
    section.append(...nodes);
    return section;
  });
  main.replaceChildren(...sections);
  return sections;
}

export const DOMUtils = { remove, replaceBackgroundByImg };
export const Blocks = { createBlock, getMetadataBlock };
export const FileUtils = { sanitizePath };
