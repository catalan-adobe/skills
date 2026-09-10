import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { flag } from './args.mjs';
import { resolvePaths } from './paths.mjs';
import { listRecords } from './state.mjs';
import { assertBlock } from './shapes.mjs';

export const STUB_MARKER = (
  'STUB — structural only, generated from migration/data/blocks.json'
);

/**
 * Structural stub: row/cell classes from the content model, legible layout,
 * no brand.
 *
 * @param {object} block A block record from blocks.json
 * @returns {{js: string, css: string}} Generated JS and CSS stubs
 */
export function renderStub(block) {
  assertBlock(block);
  const { name, model } = block;
  const cols = model.columns.map((c) => c.name);
  const js = `/* ${STUB_MARKER} (block: ${name}). Replace with the real \
implementation. */
export default function decorate(block) {
  const columns = ${JSON.stringify(cols)};
  [...block.children].forEach((row, r) => {
    row.classList.add('${name}-row');${model.header ? `
    if (r === 0) row.classList.add('${name}-header');` : ''}
    [...row.children].forEach((cell, c) => \
cell.classList.add(\`${name}-\${columns[c] ?? 'cell'}\`));
  });
}
`;
  const css = `/* ${STUB_MARKER} (block: ${name}). Layout only; no brand \
tokens. */
.${name} > div {
  display: grid;
  grid-template-columns: repeat(${cols.length}, 1fr);
  gap: 0.5rem 1rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid currentcolor;
}${model.header ? `
.${name}-header { font-weight: 700; }` : ''}
`;
  return { js, css };
}

async function isStub(file) {
  const text = await readFile(file, 'utf8').catch(() => null);
  return text === null ? 'absent' : text.includes(STUB_MARKER) ?
    'stub' : 'real';
}

/**
 * Writes `blocks/<name>/<name>.{js,css}` under `repoRoot` for each block.
 *
 * @param {object[]} blocks Array of block records
 * @param {string} repoRoot The repository root path
 * @param {object} options Options object
 * @param {boolean} [options.force=false] Overwrite even non-stub files
 * @returns {Promise<{written: string[], skipped: object[]}>}
 */
export async function scaffold(blocks, repoRoot, { force = false } = {}) {
  const written = [];
  const skipped = [];
  for (const block of blocks) {
    const dir = path.join(repoRoot, 'blocks', block.name);
    const files = {
      js: path.join(dir, `${block.name}.js`),
      css: path.join(dir, `${block.name}.css`),
    };
    const states = await Promise.all(
      Object.values(files).map(isStub),
    );
    if (!force && states.includes('real')) {
      skipped.push({
        name: block.name,
        reason: 'existing block is not a stub; use --force to overwrite',
      });
      continue;
    }
    const { js, css } = renderStub(block);
    await mkdir(dir, { recursive: true });
    await writeFile(files.js, js);
    await writeFile(files.css, css);
    written.push(
      path.relative(repoRoot, files.js),
      path.relative(repoRoot, files.css),
    );
  }
  return { written, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const paths = resolvePaths();
  const template = flag(argv, '--template');
  const name = flag(argv, '--name');
  if (!template && !name) {
    console.error(
      'Usage: scaffold-block.mjs --template <t> | --name <n> [--force]',
    );
    process.exit(1);
  }
  const all = await listRecords('blocks', { paths });
  const blocks = all.filter(
    (b) => (name ? b.name === name : template in (b.templates ?? {})),
  );
  if (name && blocks.length === 0) {
    console.error(`Unknown block "${name}" in blocks.json`);
    process.exit(1);
  }
  const result = await scaffold(blocks, paths.repoRoot, {
    force: argv.includes('--force'),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
