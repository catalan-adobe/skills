// The structure review: a method's reading of each page drawn over its screenshot — the
// first level's candidate cuts as dashed lines, then every node of the band tree at its own
// extent, coloured by kind (section, layout, block, default content), deeper nodes dashed
// and inset, unresolved containers marked; header and footer greyed — and beside it a row
// per node with the facts, the model's probabilities, the decision and the rule that changed
// it, and a mark for the reader. Marks stay in the browser and are exported as JSON: the
// first ground truth below the first level. A view, rendered, never edited.
import { esc } from './report-html.mjs';
import { disagreement, readPixelCheck, readStructure } from './bands.mjs';
import { read as readSelection } from './selections.mjs';
import { read as readTable } from './pages.mjs';
import { read as readTree, shotFile } from './trees.mjs';

export const SHEET_WIDTH = 600;
export const COLOUR = { section: '#6a3fd1', layout: '#c2185b', block: '#e07b00',
  default_content: '#0a8f5a' };
export const MARKS = ['ok', 'section', 'layout', 'block', 'default_content', 'wrong cut'];

const CSS = `
body { margin: 0; font: 13px/1.4 -apple-system, system-ui, sans-serif; color: #1c1c1c; }
main { max-width: 1700px; margin: 0 auto; padding: 20px; }
h1 { font-size: 20px; } .page { display: grid; grid-template-columns: ${SHEET_WIDTH}px 1fr;
  gap: 18px; padding: 18px 0; border-bottom: 1px solid #e3e3e3; align-items: start; }
.url { font-size: 15px; font-weight: 600; word-break: break-all; margin: 0 0 6px; }
.pixels { color: #b3261e; font-size: 13px; margin: 0 0 6px; }
.outline { color: #444; margin: 0 0 8px; font-family: ui-monospace, monospace; }
.stage { position: relative; width: ${SHEET_WIDTH}px; }
.stage img { display: block; width: ${SHEET_WIDTH}px; }
.stage svg { position: absolute; left: 0; top: 0; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { text-align: left; vertical-align: top; padding: 4px 8px 4px 0;
  border-bottom: 1px solid #eee; }
th { color: #666; font-weight: 600; font-size: 11px; text-transform: uppercase; }
td.node { font-weight: 600; white-space: nowrap; } .right { position: sticky; top: 10px; }
${Object.entries(COLOUR).map(([k, c]) => `.kind-${k} { color: ${c}; }`).join(' ')}
.rule { color: #777; font-style: italic; } small { color: #777; }
tr.marked td { background: #fff6d6; } select, input { font-size: 12px; }
.bar { position: sticky; top: 0; background: #fff; padding: 8px 0; z-index: 2;
  border-bottom: 1px solid #ddd; }
`;

const pct = (x) => (typeof x === 'number' ? `${Math.round(x * 100)}` : '');
const walk = (nodes, depth = 1) => nodes.flatMap((n) => [{ n, depth },
  ...walk(n.children ?? [], depth + 1)]);
const letter = (k) => (k === 'default_content' ? 'd' : k[0]);
export const treeOf = (n) => letter(n.kind)
  + (n.children ? `[${n.children.map(treeOf).join(' ')}]` : n.unresolved ? '?' : '');

function overlay(structure, scale, H, W) {
  const parts = [];
  const grey = 'fill="rgba(120,120,120,0.12)"';
  const top = Math.round(structure.body.top * scale);
  const bottom = Math.round(structure.body.bottom * scale);
  if (top > 0) parts.push(`<rect x="0" y="0" width="${SHEET_WIDTH}" height="${top}" ${grey}/>`);
  const footH = Math.round(H * scale) - bottom;
  if (footH > 0) {
    parts.push(`<rect x="0" y="${bottom}" width="${SHEET_WIDTH}" height="${footH}" ${grey}/>`);
  }
  for (const c of structure.candidates.filter((x) => x.depth === 1)) {
    const y = Math.round(c.top * scale);
    parts.push(`<line x1="0" y1="${y}" x2="${SHEET_WIDTH}" y2="${y}" stroke="#0a4fd1"`
      + ' stroke-width="1" stroke-dasharray="5 4"/>');
  }
  const text = (x, y, size, colour, anchor, label) => parts.push(`<text x="${x}" y="${y}"`
    + ` font-size="${size}" font-family="sans-serif" font-weight="600" fill="${colour}"`
    + ` stroke="#fff" stroke-width="3" paint-order="stroke" text-anchor="${anchor}">`
    + `${esc(label)}</text>`);
  for (const { n, depth } of walk(structure.bands)) {
    const inset = 2 + 3 * (depth - 1);
    const x = Math.round((depth === 1 ? 0 : n.left ?? 0) * scale) + inset;
    const w = Math.round(((depth === 1 ? W : n.right ?? W) - (depth === 1 ? 0 : n.left ?? 0))
      * scale) - 2 * inset;
    const y = Math.round(n.top * scale) + inset;
    const h = Math.max(2, Math.round((n.bottom - n.top) * scale) - 2 * inset);
    const colour = COLOUR[n.kind] ?? '#999';
    parts.push(`<rect x="${x}" y="${y}" width="${Math.max(2, w)}" height="${h}" fill="`
      + `${n.unresolved ? 'rgba(179,38,30,0.08)' : 'none'}" stroke="${colour}"`
      + ` stroke-width="${depth === 1 ? 3 : 1.5}"`
      + `${depth === 1 ? '' : ' stroke-dasharray="6 3"'}/>`);
    const label = `${n.id} ${n.kind}${n.unresolved ? ' ?' : ''}`;
    if (depth === 1) text(x + 6, y + 14, 12, colour, 'start', label);
    else text(x + w - 4, y + 12, 10, colour, 'end', label);
  }
  return `<svg width="${SHEET_WIDTH}" height="${Math.round(H * scale)}">${parts.join('')}</svg>`;
}

function note(n, c) {
  if (n.unresolved) return 'unresolved: nothing to cut';
  if (n.checked) return 'judged default content; checked inside, holds more';
  if (n.collapsed) return 'one child: took its kind';
  if (n.members.length > 1) return `merged ${n.members.join('+')}`;
  if (!c) return '';
  if (c.rule) return c.rule;
  return c.judged && c.kind !== c.judged ? `model said ${c.judged}` : '';
}

function table(structure) {
  const byId = new Map(structure.candidates.map((c) => [c.id, c]));
  const rows = walk(structure.bands).map(({ n, depth }) => {
    const c = n.members.length === 1 ? byId.get(n.members[0]) : null;
    const p = c?.probabilities ?? {};
    const probs = c?.probabilities ? `default ${pct(p.default_content)} · block ${pct(p.block)}`
      + ` · section ${pct(p.section)} · title↑ ${pct(p.title_above)}`
      + (p.layout === undefined ? '' : ` · layout ${pct(p.layout)}`) : '';
    const merge = !c || c.merge === 0 || c.merge === null ? ''
      : c.empty ? '<small>empty</small>' : `${pct(c.merge)} %`;
    const factsText = [c?.state?.parts, c?.state?.stack, c?.state?.picture, c?.state?.text,
      c?.state?.headings]
      .filter(Boolean).join(' · ');
    const text = (c?.state?.content ?? []).slice(0, 3)
      .map((t) => String(t).replace(/^[^:]+:\s*/, '')).join(' · ');
    const pad = `padding-left:${14 * (depth - 1)}px`;
    const options = MARKS.map((m) => `<option>${esc(m)}</option>`).join('');
    return `<tr data-node="${esc(n.id)}"><td class="node" style="${pad}">${esc(n.id)}</td>`
      + `<td class="kind-${esc(n.kind)}">${esc(n.kind)}${n.unresolved ? ' ?' : ''}`
      + ` <span class="rule">${esc(note(n, c))}</span></td>`
      + `<td>${merge}</td><td><small>${esc(probs)}</small></td>`
      + `<td><small>${esc(factsText)}</small></td><td><small>${esc(text)}</small></td>`
      + `<td><select name="mark"><option></option>${options}</select>`
      + ' <input name="note" placeholder="note" size="10"></td></tr>';
  });
  return '<table><thead><tr><th>node</th><th>kind</th><th>merge</th><th>probabilities</th>'
    + '<th>facts</th><th>text</th><th>mark</th></tr></thead>'
    + `<tbody>${rows.join('')}</tbody></table>`;
}

// Marks are kept per page, node and wording in the browser; Export downloads them all.
const SCRIPT = `
const KEY = 'structure-marks:' + document.body.dataset.selection;
const marks = JSON.parse(localStorage.getItem(KEY) || '{}');
const keyOf = (tr) => tr.closest('.page').dataset.page + '|' + tr.dataset.node;
const count = () => { document.querySelector('#count').textContent =
  Object.values(marks).filter((m) => m.mark).length + ' marked'; };
for (const tr of document.querySelectorAll('tr[data-node]')) {
  const m = marks[keyOf(tr)];
  const [sel, note] = [tr.querySelector('[name=mark]'), tr.querySelector('[name=note]')];
  if (m) { sel.value = m.mark || ''; note.value = m.note || ''; tr.classList.toggle('marked',
    Boolean(m.mark)); }
  const save = () => {
    const page = tr.closest('.page');
    marks[keyOf(tr)] = { page: page.dataset.page, node: tr.dataset.node,
      wording: page.dataset.wording, kind: tr.querySelector('td:nth-child(2)').firstChild
        .textContent.trim(), mark: sel.value, note: note.value };
    if (!sel.value && !note.value) delete marks[keyOf(tr)];
    tr.classList.toggle('marked', Boolean(sel.value));
    localStorage.setItem(KEY, JSON.stringify(marks)); count();
  };
  sel.addEventListener('change', save); note.addEventListener('change', save);
}
document.querySelector('#export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ selection: document.body.dataset.selection,
    marks: Object.values(marks) }, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob),
    download: 'structure-marks-' + document.body.dataset.selection + '.json' });
  a.click();
});
count();
`;

/** One line where the screenshot disagrees with the reading; empty when it does not. */
export function pixelsLine(check) {
  const text = disagreement(check);
  if (!text) return '';
  return `<div class="pixels">Picture disagrees — ${esc(text)}. Look before judging.</div>`;
}

export async function renderStructure(cwd, selectionName, method = 'candidates-system1') {
  const sel = await readSelection(cwd, selectionName);
  if (!sel) throw new Error(`no selection ${selectionName}`);
  const byId = new Map((await readTable(cwd)).pages.map((p) => [p.id, p]));
  const cards = [];
  for (const id of sel.pages) {
    const page = byId.get(id);
    const structure = await readStructure(cwd, id, method);
    const tree = await readTree(cwd, id);
    if (!page || !structure || !tree?.page?.shot) continue;
    const pixels = await readPixelCheck(cwd, id);
    const W = tree.tree.bounds.width || 1280;
    const H = tree.page.scrollHeight;
    const scale = SHEET_WIDTH / W;
    const asked = structure.candidates.filter((c) => c.probabilities).length;
    cards.push(`<section class="page" data-page="${esc(id)}"`
      + ` data-wording="${esc(structure.method.wording ?? '')}"><div><div class="url">`
      + `<a href="${esc(page.url)}" target="_blank">${esc(page.url)}</a></div>
<div class="outline">${esc(structure.bands.map(treeOf).join(' '))}</div>
<div><small>${structure.candidates.length} candidates, ${asked} asked,`
      + ` ${structure.usage?.inputTokens ?? 0} tokens</small></div>
${pixelsLine(pixels)}<div class="stage"><img src="../${esc(shotFile(id))}" loading="lazy">
${overlay(structure, scale, H, W)}</div></div>
<div class="right">${table(structure)}</div></section>`);
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Structure — ${esc(selectionName)} — ${esc(method)}</title><style>${CSS}</style></head>
<body data-selection="${esc(selectionName)}"><main>
<h1>Structure: ${esc(selectionName)} by ${esc(method)}</h1>
<p>Each page is cut into bands, each band qualified —
<span class="kind-section">section</span>, <span class="kind-layout">layout</span> (parts side
by side), <span class="kind-block">block</span>,
<span class="kind-default_content">default content</span> — and every section and layout cut
and qualified again, until nothing is one. Solid boxes are the first level, dashed ones deeper,
each at its own extent; a red tint marks a container with nothing left to cut. Under the URL,
the tree in letters: <code>s[d l[d b]]</code>. Mark a node <em>ok</em>, the kind it should be,
or <em>wrong cut</em> when its edges are wrong; marks stay in this browser until exported.</p>
<div class="bar"><button id="export">Export marks</button> <span id="count"></span></div>
${cards.join('\n')}</main><script>${SCRIPT}</script></body></html>
`;
}
