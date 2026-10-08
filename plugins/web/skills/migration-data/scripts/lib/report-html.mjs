// The report as one HTML file: every unit of the migration on one page, for a person —
// rendered from the data, regenerated, never edited. Images are referenced relatively,
// so the file opens from disk. No script, no dependency: plain HTML and a few rules of CSS.
import { access } from 'node:fs/promises';
import path from 'node:path';
import { readTypes } from './elements.mjs';
import { read as readInventory } from './inventory.mjs';
import { open as openMigration } from './migration.mjs';
import { body as noteBody, index as notesIndex } from './notes.mjs';
import { composed, read as readTable } from './pages.mjs';
import { list as listRuns, liveness } from './runs.mjs';
import { list as listSelections } from './selections.mjs';
import { read as readState } from './state.mjs';
import { openStore } from './store.mjs';
import { shotFile } from './trees.mjs';
import { readFragments, readWebsite } from './website.mjs';

export const MAX_ROWS = 300;

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when = (iso) => (iso
  ? `<span class="nowrap">${esc(iso.slice(0, 16).replace('T', ' '))}</span>` : '—');
const n = (x) => esc(x ?? 0);
const code = (s) => `<code>${esc(s)}</code>`;
const sel = (s) => `<code class="sel">${esc(s)}</code>`;

const CSS = `
:root { color-scheme: light; --ink: #1c1c1c; --mute: #6b6b6b; --line: #e3e3e3; --bg: #fafafa;
  --ok: #2e7d32; --warn: #b26a00; --bad: #b3261e; --soft: #eef2f7; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 -apple-system, system-ui, "Segoe UI", sans-serif;
  color: var(--ink); background: #fff; }
main { max-width: 1120px; margin: 0 auto; padding: 32px 24px 80px; }
h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 20px; margin: 44px 0 10px;
  padding-top: 20px; border-top: 1px solid var(--line); }
h3 { font-size: 16px; margin: 22px 0 6px; } h4 { font-size: 14px; margin: 14px 0 4px; }
p.lead { color: var(--mute); margin: 0 0 18px; }
.summary { background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
  padding: 12px 16px; margin: 10px 0 14px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; margin: 8px 0 12px; }
th, td { text-align: left; vertical-align: top; padding: 6px 10px 6px 0;
  border-bottom: 1px solid var(--line); }
th { color: var(--mute); font-weight: 600; font-size: 12px; text-transform: uppercase;
  letter-spacing: .03em; }
td.num, th.num { text-align: right; padding-right: 14px; font-variant-numeric: tabular-nums; }
code { font: 12.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--soft);
  padding: 1px 5px; border-radius: 4px; white-space: nowrap; }
code.sel { white-space: normal; word-break: break-all; }
.bar { display: inline-block; height: 9px; background: #9db4d6; border-radius: 2px;
  vertical-align: middle; margin-right: 6px; }
.tag { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 10px;
  background: var(--soft); color: var(--ink); white-space: nowrap; }
.tag.ok { background: #e6f4ea; color: var(--ok); } .tag.warn { background: #fff4e0;
  color: var(--warn); } .tag.bad { background: #fdecea; color: var(--bad); }
.tag.mute { color: var(--mute); } .nowrap { white-space: nowrap; }
.shots { display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-start; margin: 8px 0; }
.shots figure { margin: 0; max-width: 100%; }
.shots img { display: block; max-width: 100%; border: 1px solid var(--line);
  border-radius: 4px; }
.shots .page img { max-height: 420px; width: auto; }
.shots figcaption { font-size: 12px; color: var(--mute); margin-top: 4px; }
details { margin: 8px 0; } summary { cursor: pointer; color: var(--mute); }
.note { border-left: 3px solid var(--line); padding: 2px 0 2px 16px; margin: 18px 0; }
.note .meta { font-size: 12px; color: var(--mute); margin-bottom: 4px; }
.note h1, .note h2, .note h3 { border: 0; padding: 0; margin: 12px 0 4px; }
.note h1 { font-size: 17px; } .note h2 { font-size: 15px; } .note h3 { font-size: 14px; }
.note ul { margin: 4px 0; padding-left: 20px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px; margin: 10px 0; }
.kpi { background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
  padding: 10px 12px; } .kpi b { display: block; font-size: 22px; }
.kpi span { font-size: 12px; color: var(--mute); }
a { color: #1a4f8b; text-decoration: none; } a:hover { text-decoration: underline; }
footer { margin-top: 48px; color: var(--mute); font-size: 12px; }
`;

const STATE_TONE = {
  done: 'ok', running: 'warn', ready: '', 'waiting-operator': 'warn', blocked: 'mute',
  failed: 'bad', interrupted: 'bad', stopped: 'mute', queued: 'warn',
};
const tag = (text, tone = '') => `<span class="tag ${tone}">${esc(text)}</span>`;
const stateTag = (state) => tag(state, STATE_TONE[state] ?? '');
const VERDICT_TONE = { in: 'ok', out: 'bad', undecided: 'mute' };

const tableOf = (headers, rows, { numeric = [] } = {}) => [
  '<table><thead><tr>',
  ...headers.map((h, i) => `<th${numeric.includes(i) ? ' class="num"' : ''}>${esc(h)}</th>`),
  '</tr></thead><tbody>',
  ...rows.map((r) => `<tr>${r.map((c, i) => (
    `<td${numeric.includes(i) ? ' class="num"' : ''}>${c}</td>`)).join('')}</tr>`),
  '</tbody></table>',
].join('');

const bar = (value, max) => (
  `<span class="bar" style="width:${Math.max(2, Math.round((value / (max || 1)) * 120))}px">`
  + '</span>');

/** A small Markdown subset to HTML: headings, bullets, tables, paragraphs, inline code. */
export function markdown(text) {
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(https?:\/\/[^\s)<]+)/g, '<a href="$1">$1</a>');
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const h = /^(#{1,4}) (.*)$/.exec(line);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^[-*] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) { items.push(lines[i].slice(2)); i += 1; }
      i -= 1;
      out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`);
      continue;
    }
    if (/^\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i += 1; }
      i -= 1;
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const [head, , ...body] = rows;
      out.push(tableOf(cells(head), body.map((r) => cells(r).map(inline))));
      continue;
    }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  return out.join('\n');
}

function sectionState(state) {
  return [
    '<h2 id="state">State</h2>', `<div class="summary">${esc(state.summary)}</div>`,
    tableOf(['step', 'state', 'progress', 'note'], state.steps.map((s) => [
      esc(s.id), stateTag(s.state), esc(s.progress ?? ''),
      esc([s.blockedBy.length ? `blocked by ${s.blockedBy.join(', ')}` : null, s.note]
        .filter(Boolean).join('; ')),
    ])),
  ];
}

function sectionWebsite(site) {
  if (!site) return ['<h2 id="website">Website</h2>', '<p>No pages discovered yet.</p>'];
  const c = site.counts;
  const kpi = (v, label) => `<div class="kpi"><b>${n(v)}</b><span>${esc(label)}</span></div>`;
  const max = Math.max(...site.groups.map((g) => g.urls), 1);
  return [
    '<h2 id="website">Website</h2>', `<div class="summary">${esc(site.summary)}</div>`,
    `<div class="grid">${kpi(c.urls, 'URLs known')}${kpi(c.inScope, 'in scope')}`
      + `${kpi(c.in, 'in')}${kpi(c.out, 'out')}${kpi(c.undecided, 'undecided')}`
      + `${kpi(c.cached, 'cached')}${kpi(c.composed, 'composed')}</div>`,
    '<h3>Discovery</h3>',
    tableOf(['from', 'source', 'urls'], site.discovery.map((d) => (
      [esc(d.from), esc(d.source ?? ''), n(d.urls)])), { numeric: [2] }),
    `<h3>Groups (${site.groups.length})</h3>`,
    tableOf(['group', '', 'urls', 'in', 'cached', 'composed'], site.groups.map((g) => [
      code(g.name || '/'), bar(g.urls, max), n(g.urls), n(g.in), n(g.cached), n(g.composed),
    ]), { numeric: [2, 3, 4, 5] }),
  ];
}

const exists = (file) => access(file).then(() => true, () => false);

async function sectionPages(cwd, pages, selections) {
  const out = ['<h2 id="pages">Pages</h2>', `<div class="summary">${esc(pages.summary)}</div>`];
  if (selections.length) {
    out.push('<h3>Selections</h3>', tableOf(['name', 'pages', 'criteria', 'created'],
      selections.map((s) => [esc(s.name), n(s.pages.length), code(JSON.stringify(s.criteria)),
        when(s.created)]), { numeric: [1] }));
  }
  const kinds = {};
  for (const p of pages.pages) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
  out.push('<h3>Kinds</h3>', `<p>${Object.entries(kinds).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${tag(k)} ${v}`).join(' &nbsp; ')}</p>`);
  const seen = pages.pages.filter((p) => p.cache || p.verdict.status === 'out')
    .slice(0, MAX_ROWS);
  out.push(`<h3>Pages visited or decided (${seen.length})</h3>`);
  if (seen.length === MAX_ROWS) out.push(`<p>The first ${MAX_ROWS} are shown.</p>`);
  const root = openStore(cwd).root;
  const shots = await Promise.all(seen.map((p) => exists(path.join(root, shotFile(p.id)))));
  out.push(tableOf(['url', 'group', 'kind', 'http', 'verdict', 'reasons', 'fragments',
    'sections', 'shot'], seen.map((p, i) => [
    `<a href="${esc(p.url)}">${esc(new URL(p.url).pathname + new URL(p.url).search)}</a>`,
    p.group === null ? '—' : code(p.group || '/'), esc(p.kind), n(p.http?.status ?? '—'),
    tag(p.verdict.status, VERDICT_TONE[p.verdict.status]),
    esc(p.verdict.reasons.map((r) => r.code + (r.detail ? ` → ${r.detail}` : '')).join('; ')),
    n(p.fragments?.length ?? 0), composed(p) ? n(p.composition.sections) : '—',
    shots[i] ? `<a href="../${esc(shotFile(p.id))}">page</a>` : '—',
  ]), { numeric: [3, 6, 7] }));
  return out;
}

function sectionFragments(fragments) {
  const out = ['<h2 id="fragments">Shared documents</h2>'];
  if (!fragments) return [...out, '<p>None found yet: the chrome step has not run.</p>'];
  out.push(`<div class="summary">${esc(fragments.summary)} — method ${code(fragments.method.name)}`
    + ` at ${when(fragments.method.at)}</div>`);
  for (const f of fragments.fragments) {
    const title = f.label ?? f.part ?? f.name;
    out.push(`<h3>${esc(title)} ${tag(f.placement)} ${code(f.id)} — ${n(f.pages)} pages</h3>`);
    out.push(tableOf(['band', 'selector'], f.selectors.map((s, i) => [n(i + 1), sel(s)])));
    if (f.optional?.length) {
      out.push(`<p>Optional: ${f.optional.map(sel).join(' ')}</p>`);
    }
    const shots = f.evidence ?? [];
    if (shots.length) {
      out.push('<div class="shots">', ...shots.map((file, i) => (
        `<figure class="${i === 0 ? 'page' : 'band'}"><img src="../${esc(file)}" loading="lazy">`
        + `<figcaption>${esc(file.split('/').at(-1))}</figcaption></figure>`)), '</div>');
    }
  }
  if (fragments.rejected.length) {
    out.push(`<details><summary>${fragments.rejected.length} candidates not taken</summary>`,
      tableOf(['selector', 'reason'], fragments.rejected.map((r) => (
        [sel(r.selector), esc(r.reason)]))), '</details>');
  }
  return out;
}

function sectionElements(types, inventory) {
  const out = ['<h2 id="elements">Elements</h2>'];
  if (!types && !inventory) {
    return [...out, '<p>No decomposition yet: no method has read the pages into sections.</p>'];
  }
  if (types) out.push(`<div class="summary">${esc(types.summary)}</div>`);
  if (inventory) {
    out.push(`<div class="summary">${esc(inventory.summary)}</div>`);
    if (inventory.blocks.length) {
      out.push(tableOf(['block', 'types', 'instances', 'pages'], inventory.blocks.map((b) => (
        [esc(b.block), n(b.types.length), n(b.instances), n(b.pages)])), { numeric: [1, 2, 3] }));
    }
  }
  return out;
}

const minutes = (a, b) => (a && b ? `${Math.round((new Date(b) - new Date(a)) / 6000) / 10} min`
  : '');

function sectionRuns(runs) {
  const out = ['<h2 id="runs">Runs</h2>'];
  if (!runs.length) return [...out, '<p>None yet.</p>'];
  return [...out, tableOf(['started', 'step', 'state', 'took', 'done', 'failed', 'summary'],
    [...runs].reverse().map((r) => [
      when(r.started), esc(r.step), stateTag(liveness(r)), esc(minutes(r.started, r.finished)),
      esc(r.total === null ? `${r.done}` : `${r.done}/${r.total}`), n(r.failed.length),
      esc(r.error ? `${r.error}` : r.summary ?? ''),
    ]), { numeric: [4, 5] })];
}

async function sectionNotes(cwd, notes) {
  const out = ['<h2 id="notes">Notes</h2>'];
  if (!notes.length) return [...out, '<p>None yet.</p>'];
  for (const note of notes) {
    // eslint-disable-next-line no-await-in-loop
    const text = await noteBody(cwd, note.id);
    out.push('<div class="note">', `<div class="meta">${when(note.at)} · ${esc(note.step)} · `
      + `${esc(note.author)} · ${code(note.id)}</div>`, markdown(text), '</div>');
  }
  return out;
}

/** The whole report as HTML. */
export async function renderHtml(cwd, { now = new Date() } = {}) {
  const migration = await openMigration(cwd);
  const state = await readState(cwd, { now });
  const [site, pages, fragments, types, inventory, selections, runs, notes] = await Promise.all([
    readWebsite(cwd), readTable(cwd), readFragments(cwd), readTypes(cwd), readInventory(cwd),
    listSelections(cwd), listRuns(cwd), notesIndex(cwd).then((i) => i.notes),
  ]);
  const nav = ['state', 'website', 'pages', 'fragments', 'elements', 'runs', 'notes']
    .map((id) => `<a href="#${id}">${id}</a>`).join(' · ');
  const body = [
    `<h1>${esc(migration.source.scope)}</h1>`,
    `<p class="lead">Migration ${code(migration.id)} · ${nav}</p>`,
    ...sectionState(state), ...sectionWebsite(site),
    ...await sectionPages(cwd, pages, selections),
    ...sectionFragments(fragments), ...sectionElements(types, inventory), ...sectionRuns(runs),
    ...await sectionNotes(cwd, notes),
    `<footer>Rendered ${when(now.toISOString())} from migration/ — regenerate with`
      + ` ${code('migration.mjs report --html')}; do not edit.</footer>`,
  ];
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>Migration report — ${esc(migration.source.scope)}</title>`
    + `<style>${CSS}</style></head><body><main>\n${body.join('\n')}\n</main></body></html>\n`;
}
