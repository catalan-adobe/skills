// The annotation sheet: a tool view for a person judging pages for the bench. The body
// crops of a selection with the six verdict fields beside each; answers kept in the
// browser as you go; one button exports them as the JSON `verdicts import` reads. The
// one view with script, because it is a tool, not a report.
import { esc } from './report-html.mjs';
import { read as readSelection } from './selections.mjs';
import { read as readTable } from './pages.mjs';
import { bodyFile, bodyThumbFile } from './trees.mjs';
import { CATEGORIES, CONSTRUCTS, LAYOUTS, PROBLEMS } from './verdicts.mjs';
import { read as readVerdicts } from './verdicts.mjs';

const CSS = `
body { margin: 0; font: 14px/1.4 -apple-system, system-ui, sans-serif; color: #1c1c1c; }
main { max-width: 1400px; margin: 0 auto; padding: 20px; }
.bar { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #ddd; padding: 10px 0;
  display: flex; gap: 16px; align-items: center; z-index: 2; }
.bar input { padding: 4px 6px; } button { padding: 6px 12px; }
.page { display: grid; grid-template-columns: 340px 1fr; gap: 18px; padding: 16px 0;
  border-bottom: 1px solid #e3e3e3; }
.page.done { background: #f3faf3; }
.shot a { display: block; max-height: 520px; overflow: auto; border: 1px solid #ddd; }
.shot img { width: 100%; display: block; }
.shot .url { font-size: 16px; font-weight: 600; word-break: break-all; margin: 0 0 6px; }
.shot .url small { color: #666; font-weight: 400; }
fieldset { border: 0; padding: 0; margin: 0 0 10px; }
legend { font-weight: 600; margin-bottom: 4px; }
label.opt { display: inline-block; margin: 2px 10px 2px 0; }
select, input[type=number], input[type=text] { padding: 3px 6px; }
input[type=text].note { width: 90%; }
.hint { color: #666; font-size: 12px; }
`;

const SCRIPT = `
const KEY = 'verdicts:' + location.pathname;
const state = JSON.parse(localStorage.getItem(KEY) || '{}');
const pages = [...document.querySelectorAll('.page')];
const read = (el) => {
  const v = { page: el.dataset.page, constructs: [] };
  const problem = el.querySelector('[name=problem]').value;
  if (problem) v.problem = problem;
  v.sameAs = el.querySelector('[name=sameAs]').value || null;
  v.category = el.querySelector('[name=category]').value;
  v.layout = el.querySelector('[name=layout]').value;
  for (const c of el.querySelectorAll('[name=construct]:checked')) v.constructs.push(c.value);
  const bands = el.querySelector('[name=bands]').value;
  if (bands !== '') v.bands = Number(bands);
  const note = el.querySelector('[name=note]').value.trim();
  if (note) v.note = note;
  return v;
};
const write = (el, v) => {
  if (!v) return;
  el.querySelector('[name=problem]').value = v.problem || '';
  el.querySelector('[name=sameAs]').value = v.sameAs || '';
  el.querySelector('[name=category]').value = v.category || '';
  el.querySelector('[name=layout]').value = v.layout || '';
  const chosen = v.constructs || [];
  for (const c of el.querySelectorAll('[name=construct]')) c.checked = chosen.includes(c.value);
  el.querySelector('[name=bands]').value = v.bands ?? '';
  el.querySelector('[name=note]').value = v.note || '';
};
const complete = (v) => Boolean(v.problem || (v.category && v.layout));
const refresh = () => {
  let n = 0;
  for (const el of pages) {
    const v = read(el); el.classList.toggle('done', complete(v)); if (complete(v)) n += 1;
  }
  document.querySelector('#count').textContent = n + ' / ' + pages.length;
};
for (const el of pages) { write(el, state[el.dataset.page]); }
refresh();
document.addEventListener('change', () => {
  for (const el of pages) state[el.dataset.page] = read(el);
  localStorage.setItem(KEY, JSON.stringify(state));
  refresh();
});
document.querySelector('#export').addEventListener('click', () => {
  const by = document.querySelector('#by').value.trim() || 'operator';
  const verdicts = pages.map(read).filter(complete);
  const text = JSON.stringify({ by, verdicts }, null, 2);
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = document.body.dataset.file;
  a.click();
});
`;

const options = (name, values, { blank = true } = {}) => `<select name="${name}">`
  + (blank ? '<option value=""></option>' : '')
  + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('') + '</select>';

/** The sheet for a selection: its readable pages with a body crop, in the selection's order. */
export async function renderAnnotate(cwd, selectionName) {
  const sel = await readSelection(cwd, selectionName);
  if (!sel) throw new Error(`no selection ${selectionName}`);
  const table = await readTable(cwd);
  const byId = new Map(table.pages.map((p) => [p.id, p]));
  const pages = sel.pages.map((id) => byId.get(id)).filter(Boolean);
  const existing = new Map(((await readVerdicts(cwd))?.verdicts ?? []).map((v) => [v.page, v]));
  const short = (p) => new URL(p.url).pathname;
  const sameAs = (i) => `<select name="sameAs"><option value="">new template</option>`
    + pages.slice(0, i).map((p) => `<option value="${p.id}">${esc(short(p))}</option>`).join('')
    + '</select>';
  const cards = pages.map((p, i) => `<section class="page" data-page="${p.id}">
<div class="shot"><div class="url"><small>${i + 1}.</small> ${esc(short(p))}</div>
<a href="../${esc(bodyFile(p.id))}" target="_blank">
<img src="../${esc(bodyThumbFile(p.id))}" loading="lazy"></a></div>
<div>
<fieldset><legend>Problem</legend>${options('problem', PROBLEMS)}
<span class="hint">capture-fault: the picture is wrong (cut short, blank, an overlay) ·
odd: not a page of the site's kind (a tool, a campaign, a shell). Set it and move on;
the rest may stay empty.</span></fieldset>
<fieldset><legend>Same template as</legend>${sameAs(i)}
<span class="hint">an earlier page on this sheet whose structure this one repeats</span></fieldset>
<fieldset><legend>Category</legend>${options('category', CATEGORIES)}
<span class="hint">of the main content only — document: a plain document says it all ·
bands: recurring constructs (hero, cards, CTA band) · composed: columns, tabs, tools,
forms</span></fieldset>
<fieldset><legend>Layout</legend>${options('layout', LAYOUTS)}
<span class="hint">a narrower side column of secondary content running beside the main
content: main-left (a side nav, a contents or fact column on the left) · main-right
(related links, a table of contents, a share rail on the right) · both · single (none).
A hero or a card grid is not a layout, it is a construct.</span></fieldset>
<fieldset><legend>Constructs</legend><span class="hint">in the main content; a table of
contents in a side column still counts as toc</span><br>${CONSTRUCTS.map((c) => (
    `<label class="opt"><input type="checkbox" name="construct" value="${c}"> ${c}</label>`))
    .join('')}
</fieldset>
<fieldset><legend>Bands</legend><input type="number" name="bands" min="0" max="60">
<span class="hint">distinct horizontal bands, roughly</span></fieldset>
<fieldset><legend>Note</legend><input type="text" name="note" class="note"></fieldset>
</div></section>`).join('\n');
  const prefill = Object.fromEntries(pages.filter((p) => existing.has(p.id))
    .map((p) => [p.id, existing.get(p.id)]));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Verdicts — ${esc(selectionName)}</title>
<style>${CSS}</style></head>
<body data-file="verdicts-${esc(selectionName)}.json"><main>
<div class="bar"><strong>Verdicts: ${esc(selectionName)}</strong> <span id="count"></span>
<label>by <input id="by" type="text" placeholder="your name"></label>
<button id="export">Export JSON</button>
<span class="hint">then: migration.mjs verdicts import &lt;file&gt;</span></div>
${cards}
</main>
<script>${existing.size ? `localStorage.setItem('verdicts:' + location.pathname,
  JSON.stringify(Object.assign(${JSON.stringify(prefill)},
  JSON.parse(localStorage.getItem('verdicts:' + location.pathname) || '{}'))));` : ''}
${SCRIPT}</script></body></html>
`;
}
