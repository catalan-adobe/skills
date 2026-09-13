import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { flag } from './args.mjs';
import { resolvePaths } from './paths.mjs';
import { loadPrepRecipe } from './state.mjs';

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);
// Blocks the harness adds from the page head; their rows are not page content and would count
// as invented tokens in the output.
const HARNESS_BLOCKS = new Set(['metadata', 'section-metadata']);
const normalise = (t) => t.replace(/\s+/g, ' ').trim().toLowerCase();
const isHarnessBlock = (el) => [...el.classList].some((c) => HARNESS_BLOCKS.has(c));

const SKIP_HREF = /^(#|mailto:|tel:|javascript:)/i;

/** Image basename from the first real URL: lazy loaders park a `data:` placeholder in src. */
function imageToken(el) {
  const src = [el.getAttribute('data-src'), el.getAttribute('src')]
    .find((v) => v && !v.startsWith('data:'));
  return src ? `img:${src.split('/').pop().split('?')[0]}` : null;
}

/** Link token by path: sources write links absolute or protocol-relative, outputs root-relative. */
function linkToken(el) {
  const href = el.getAttribute('href') ?? '';
  if (!href || SKIP_HREF.test(href)) return null;
  try {
    const u = new URL(href, 'https://source.invalid/');
    return `link:${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

/** Tooltip text (`title`) is content an output may carry as prose; a/img titles are chrome. */
function titleToken(el) {
  if (el.tagName === 'A' || el.tagName === 'IMG') return null;
  const title = normalise(el.getAttribute('title') ?? '');
  return title.length >= 3 && /[\p{L}\p{N}]/u.test(title) ? title : null;
}

/**
 * Content tokens of a document: each element's own text (not descendants), tooltip titles,
 * image basenames and link paths. Space-joining at element boundaries avoids
 * tokenisation artefacts.
 * @param {string} html - HTML document to tokenise
 * @param {string} rootSelector - CSS selector for root element (default 'main')
 * @param {string[]} [ignore] - Selectors of elements the template declares "not migrated";
 *   removed before tokenising so a deliberate omission does not count as lost content
 * @returns {Set<string>} Set of normalised tokens
 */
export function contentSet(html, rootSelector = 'main', ignore = []) {
  const { document } = new JSDOM(html).window;
  const root = document.querySelector(rootSelector) ?? document.body;
  for (const sel of ignore) root.querySelectorAll(sel).forEach((el) => el.remove());
  const set = new Set();
  const walk = (el) => {
    if (SKIP.has(el.tagName) || isHarnessBlock(el)) return;
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join(' ');
    const text = normalise(own);
    if (text.length >= 3 && /[\p{L}\p{N}]/u.test(text)) set.add(text);
    const extra = el.tagName === 'IMG' ? imageToken(el) : el.tagName === 'A' ? linkToken(el) : null;
    for (const token of [extra, titleToken(el)]) if (token) set.add(token);
    [...el.children].forEach(walk);
  };
  walk(root);
  return set;
}

/**
 * Compare source and output content sets. Recall = source tokens preserved;
 * precision = output tokens traceable to the source.
 * @param {Set<string>} sourceSet - Content tokens from source
 * @param {Set<string>} outSet - Content tokens from output
 * @returns {Object} Recall, precision, missing tokens, invented tokens
 */
export function compare(sourceSet, outSet) {
  const missing = [...sourceSet].filter((t) => !outSet.has(t));
  const invented = [...outSet].filter((t) => !sourceSet.has(t));
  const r = (n, d) => (d ? Number((n / d).toFixed(3)) : 1);
  const sourceWords = wordBag(sourceSet);
  const outWords = wordBag(outSet);
  const shared = bagIntersection(sourceWords, outWords);
  return {
    recall: r(sourceSet.size - missing.length, sourceSet.size),
    precision: r(outSet.size - invented.length, outSet.size),
    wordRecall: r(shared, bagSize(sourceWords)),
    wordPrecision: r(shared, bagSize(outWords)),
    missing,
    invented,
  };
}

/**
 * Words of the text tokens plus one entry per image, as a bag (word → count). Links are left
 * to the element diff: their paths are rewritten on purpose.
 */
function wordBag(set) {
  const bag = new Map();
  for (const token of set) {
    if (token.startsWith('link:')) continue;
    const words = token.startsWith('img:') ? [token] : token.match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const w of words) bag.set(w, (bag.get(w) ?? 0) + 1);
  }
  return bag;
}

const bagSize = (bag) => [...bag.values()].reduce((a, b) => a + b, 0);

function bagIntersection(a, b) {
  let n = 0;
  for (const [w, count] of a) n += Math.min(count, b.get(w) ?? 0);
  return n;
}

/**
 * The fidelity gate: word recall and precision against `thresholds`. Element tokens are
 * boundary-sensitive (an unwrapped `<span>` merges two tokens into a third) and stay in the
 * result as the diff aid; words say whether content was lost or invented.
 *
 * @param {{wordRecall: number, wordPrecision: number}} scored From {@link compare}.
 * @param {{recall: number, precision: number}} thresholds `thresholds.fidelity` of the config.
 * @returns {boolean}
 */
export function passes(scored, thresholds) {
  return scored.wordRecall >= thresholds.recall && scored.wordPrecision >= thresholds.precision;
}

/**
 * Validate each block table's column count against its model declaration.
 * Block tables: `<div class="<name>"><div>row…</div></div>` where columns are
 * direct children of row divs. With `template`, only the blocks whose
 * `templates` include it are checked — a page carries its template's blocks,
 * not every block of the site.
 * @param {string} outHtml - Output HTML
 * @param {Array} blocks - Block records with name, model.columns, templates
 * @param {{template?: string}} [options] - Restrict to one template's blocks
 * @returns {Array} Array of {name, ok, reason} objects
 */
export function checkBlockShape(outHtml, blocks, { template } = {}) {
  const { document } = new JSDOM(outHtml).window;
  const scoped = template
    ? blocks.filter((b) => b.templates && template in b.templates)
    : blocks;
  return scoped.map(({ name, model }) => {
    const el = document.querySelector(`main .${name}`);
    if (!el) {
      return { name, ok: false, reason: 'block not present in output' };
    }
    const bad = [...el.children].find(
      (row) => row.children.length !== model.columns.length
    );
    return bad
      ? {
          name,
          ok: false,
          reason: `row has ${bad.children.length} cells, ` +
            `model has ${model.columns.length}`,
        }
      : { name, ok: true, reason: '' };
  });
}

/**
 * Check if checklist items are present in output.
 * @param {Array<string>} items - Checklist items
 * @param {Set<string>} outSet - Content tokens from output
 * @returns {Array} Array of {item, present} objects
 */
function checklist(items, outSet) {
  return items.map((item) => ({
    item,
    present: outSet.has(normalise(item)),
  }));
}

/**
 * Main CLI runner for fidelity gates.
 * @param {Array<string>} argv - Command line arguments
 * @returns {Promise<Object>} Fidelity report with pass/fail
 */
async function main(argv) {
  const [source, out] = argv;
  if (!source || !out) {
    throw new Error(
      'Usage: fidelity.mjs <source.html> <out.html> ' +
        '[--source-root sel] [--ignore sel]... [--checklist f] [--blocks f] ' +
        '[--template t] [--min-recall 0.98] [--min-precision 0.95]'
    );
  }
  // Site overlays (page-prep.json) are never content; they join the template's own ignores.
  const recipe = await loadPrepRecipe(resolvePaths());
  const ignore = [
    ...argv.flatMap((a, i) => (a === '--ignore' ? [argv[i + 1]] : [])),
    ...recipe.selectors,
  ];
  const srcSet = contentSet(
    await readFile(source, 'utf8'),
    flag(argv, '--source-root', 'main'),
    ignore,
  );
  const outHtml = await readFile(out, 'utf8');
  const outSet = contentSet(outHtml, 'main');
  const result = compare(srcSet, outSet);
  const listFile = flag(argv, '--checklist');
  const items = listFile
    ? (await readFile(listFile, 'utf8'))
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    : [];
  const blocksFile = flag(argv, '--blocks');
  const blocks = blocksFile
    ? checkBlockShape(outHtml, JSON.parse(await readFile(blocksFile, 'utf8')), {
      template: flag(argv, '--template'),
    })
    : [];
  const list = checklist(items, outSet);
  const thresholds = {
    recall: Number(flag(argv, '--min-recall', 0.98)),
    precision: Number(flag(argv, '--min-precision', 0.95)),
  };
  const pass = passes(result, thresholds)
    && list.every((c) => c.present)
    && blocks.every((b) => b.ok);
  return { ...result, checklist: list, blocks, pass };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((r) => process.stdout.write(`${JSON.stringify(r)}\n`))
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}
