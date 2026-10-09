// The band correction sheet: a method's cuts drawn on each body; a person clicks to add
// a cut where one is missing, clicks a cut to remove it, names each band's kind, and
// exports — the ground truth at band level. A tool view, with script.
import { esc } from './report-html.mjs';
import { KINDS, readProposal, readVerdicts } from './bands.mjs';
import { read as readSelection } from './selections.mjs';
import { read as readTable } from './pages.mjs';
import { bodyFile } from './trees.mjs';

export const SHEET_WIDTH = 640;

const CSS = `
body { margin: 0; font: 14px/1.4 -apple-system, system-ui, sans-serif; color: #1c1c1c; }
main { max-width: 1400px; margin: 0 auto; padding: 20px; }
.bar { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #ddd; padding: 10px 0;
  display: flex; gap: 16px; align-items: center; z-index: 3; }
.page { display: grid; grid-template-columns: ${SHEET_WIDTH}px 1fr; gap: 18px; padding: 16px 0;
  border-bottom: 1px solid #e3e3e3; }
.page.done { background: #f3faf3; }
.url { font-size: 16px; font-weight: 600; word-break: break-all; margin: 0 0 6px; }
.stage { position: relative; width: ${SHEET_WIDTH}px; cursor: crosshair; }
.stage img { display: block; width: ${SHEET_WIDTH}px; }
.stage canvas { position: absolute; left: 0; top: 0; pointer-events: none; }
.bands { position: sticky; top: 56px; align-self: start; max-height: calc(100vh - 70px);
  overflow: auto; }
.band { display: flex; gap: 8px; align-items: center; margin: 3px 0; font-size: 13px; }
.band .n { width: 26px; font-weight: 600; } .band .h { color: #666; width: 60px; }
.hint { color: #666; font-size: 12px; margin: 6px 0; }
textarea { width: 100%; height: 40px; }
`;

const SCRIPT = `
const KINDS = ${JSON.stringify(KINDS)};
const KEY = 'band-verdicts:' + location.pathname;
const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
const pages = [...document.querySelectorAll('.page')];
const state = {};
for (const el of pages) {
  const id = el.dataset.page;
  const initial = JSON.parse(el.dataset.initial);
  state[id] = saved[id] || initial;
}
function bandsOf(st) {
  const cuts = [...new Set(st.cuts)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const prev = (st.bands || []).find((b) => b.top === cuts[i]);
    out.push({ top: cuts[i], bottom: cuts[i + 1], kind: prev ? prev.kind : 'text' });
  }
  return out;
}
function render(el) {
  const id = el.dataset.page, st = state[id];
  const top = Number(el.dataset.top), scale = Number(el.dataset.scale);
  const img = el.querySelector('img'), canvas = el.querySelector('canvas');
  canvas.width = img.clientWidth; canvas.height = img.clientHeight;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const bands = bandsOf(st);
  st.bands = bands;
  bands.forEach((b, i) => {
    const y = (b.top - top) * scale;
    ctx.fillStyle = 'rgba(220,0,0,0.9)'; ctx.fillRect(0, Math.round(y), canvas.width, 2);
    ctx.font = 'bold 13px sans-serif'; ctx.fillStyle = '#fff';
    ctx.fillRect(4, y + 4, 26 + String(i + 1).length * 8, 16);
    ctx.fillStyle = '#d00'; ctx.fillText((i + 1) + ' ' + b.kind, 6, y + 16);
  });
  ctx.fillRect(0, canvas.height - 2, canvas.width, 2);
  const list = el.querySelector('.bands');
  const option = (k, b) => '<option' + (k === b.kind ? ' selected' : '') + '>' + k + '</option>';
  const row = (b, i) => '<div class="band"><span class="n">' + (i + 1) + '</span>'
    + '<span class="h">' + (b.bottom - b.top) + ' px</span><select data-i="' + i + '">'
    + KINDS.map((k) => option(k, b)).join('') + '</select></div>';
  list.innerHTML = '<div class="hint">Click the picture to add a cut; click a line to remove'
    + ' it. Name each band.</div>' + bands.map(row).join('')
    + '<textarea placeholder="note">' + (st.note || '') + '</textarea>';
  el.classList.toggle('done', Boolean(st.touched));
}
function persist() {
  localStorage.setItem(KEY, JSON.stringify(state));
  const done = pages.filter((p) => state[p.dataset.page].touched).length;
  document.querySelector('#count').textContent = done + ' / ' + pages.length;
}
for (const el of pages) {
  render(el);
  const img = el.querySelector('img');
  img.addEventListener('load', () => render(el));
  el.querySelector('.stage').addEventListener('click', (ev) => {
    const st = state[el.dataset.page];
    const top = Number(el.dataset.top), scale = Number(el.dataset.scale);
    const rect = img.getBoundingClientRect();
    const y = Math.round(top + (ev.clientY - rect.top) / scale);
    const inner = st.cuts.slice(1, -1);
    const near = inner.find((c) => Math.abs((c - top) * scale - (ev.clientY - rect.top)) <= 8);
    if (near !== undefined) st.cuts = st.cuts.filter((c) => c !== near);
    else st.cuts = [...st.cuts, y].sort((a, b) => a - b);
    st.touched = true; render(el); persist();
  });
  el.addEventListener('change', (ev) => {
    const st = state[el.dataset.page];
    const i = Number(ev.target.dataset.i);
    if (ev.target.tagName === 'SELECT') st.bands[i].kind = ev.target.value;
    if (ev.target.tagName === 'TEXTAREA') st.note = ev.target.value;
    st.touched = true; render(el); persist();
  });
}
persist();
document.querySelector('#export').addEventListener('click', () => {
  const by = document.querySelector('#by').value.trim() || 'operator';
  const all = document.querySelector('#all').checked;
  const verdicts = pages.map((p) => state[p.dataset.page]).filter((st) => st.touched || all)
    .map((st) => ({ page: st.page, cuts: st.cuts, bands: st.bands,
      ...(st.note ? { note: st.note } : {}) }));
  const text = JSON.stringify({ by, verdicts }, null, 2);
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = document.body.dataset.file; a.click();
});
`;

export async function renderAnnotateBands(cwd, selectionName) {
  const sel = await readSelection(cwd, selectionName);
  if (!sel) throw new Error(`no selection ${selectionName}`);
  const table = await readTable(cwd);
  const byId = new Map(table.pages.map((p) => [p.id, p]));
  const existing = new Map(((await readVerdicts(cwd))?.verdicts ?? []).map((v) => [v.page, v]));
  const cards = [];
  for (const id of sel.pages) {
    const page = byId.get(id);
    const proposal = await readProposal(cwd, id);
    if (!page || !proposal) continue;
    const width = proposal.pixels.width ?? 1280;
    const scale = SHEET_WIDTH / width;
    const guess = (s) => (s === 'grid' ? 'cards' : s === 'one' ? 'text' : 'columns');
    const initial = existing.get(id) ? { ...existing.get(id), touched: true } : {
      page: id, cuts: proposal.tree.cuts,
      bands: proposal.tree.bands.map((b) => (
        { top: b.top, bottom: b.bottom, kind: guess(b.structure) })),
    };
    cards.push(`<section class="page" data-page="${id}" data-top="${proposal.body.top}"
 data-scale="${scale}" data-initial="${esc(JSON.stringify(initial))}">
<div><div class="url">${esc(new URL(page.url).pathname)}</div>
<div class="stage"><img src="../${esc(bodyFile(id))}"><canvas></canvas></div></div>
<div class="bands"></div></section>`);
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Bands — ${esc(selectionName)}</title>
<style>${CSS}</style></head>
<body data-file="band-verdicts-${esc(selectionName)}.json"><main>
<div class="bar"><strong>Bands: ${esc(selectionName)}</strong> <span id="count"></span>
<label>by <input id="by" type="text" placeholder="your name"></label>
<label><input id="all" type="checkbox" checked> export untouched pages as proposed</label>
<button id="export">Export JSON</button>
<span class="hint">then: migration.mjs band-verdicts import &lt;file&gt;</span></div>
${cards.join('\n')}
</main><script>${SCRIPT}</script></body></html>
`;
}
