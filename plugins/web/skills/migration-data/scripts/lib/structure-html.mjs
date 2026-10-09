// The structure review: a method's reading of each page drawn over its screenshot — one
// solid box per section with its style, a dashed box per child (default content, block)
// with its band ids, header and footer greyed — and beside it the bands with what the model
// answered: type and confidence, the boundary probability, the texts. For judging what
// iteration 1 produces. A view, rendered, never edited.
import { esc } from './report-html.mjs';
import { readStructure } from './bands.mjs';
import { read as readSelection } from './selections.mjs';
import { read as readTable } from './pages.mjs';
import { read as readTree, shotFile } from './trees.mjs';

export const SHEET_WIDTH = 640;
const TONE = ['#7b3fd6', '#e07a1f'];

const CSS = `
body { margin: 0; font: 13px/1.4 -apple-system, system-ui, sans-serif; color: #1c1c1c; }
main { max-width: 1500px; margin: 0 auto; padding: 20px; }
h1 { font-size: 20px; } .page { display: grid; grid-template-columns: ${SHEET_WIDTH}px 1fr;
  gap: 18px; padding: 18px 0; border-bottom: 1px solid #e3e3e3; align-items: start; }
.url { font-size: 15px; font-weight: 600; word-break: break-all; margin: 0 0 6px; }
.outline { color: #444; margin: 0 0 8px; }
.stage { position: relative; width: ${SHEET_WIDTH}px; }
.stage img { display: block; width: ${SHEET_WIDTH}px; }
.stage svg { position: absolute; left: 0; top: 0; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { text-align: left; vertical-align: top; padding: 4px 8px 4px 0;
  border-bottom: 1px solid #eee; }
th { color: #666; font-weight: 600; font-size: 11px; text-transform: uppercase; }
td.sec { font-weight: 600; } .right { position: sticky; top: 10px; }
.chrome { background: #f1f1f1; color: #777; }
small { color: #777; }
`;

const pct = (x) => (typeof x === 'number' ? `${Math.round(x * 100)} %` : '');

function overlay(structure, scale, W, H, bodyTop) {
  const parts = [];
  const rect = (y0, y1, colour, dash, label) => {
    const y = Math.round(y0 * scale);
    const h = Math.max(2, Math.round((y1 - y0) * scale));
    parts.push(`<rect x="2" y="${y}" width="${SHEET_WIDTH - 4}" height="${h}" fill="none"`
      + ` stroke="${colour}" stroke-width="${dash ? 1.5 : 3}"`
      + `${dash ? ' stroke-dasharray="6 4"' : ''}/>`);
    if (label) {
      parts.push(`<text x="${dash ? SHEET_WIDTH - 8 : 8}" y="${y + 14}" font-size="12"`
        + ` font-family="sans-serif" font-weight="600" fill="${colour}" stroke="#fff"`
        + ` stroke-width="3" paint-order="stroke"${dash ? ' text-anchor="end"' : ''}>`
        + `${esc(label)}</text>`);
    }
  };
  const bands = new Map(structure.bands.map((b) => [b.id, b]));
  const span = (ids) => {
    const bs = ids.map((id) => bands.get(id)).filter(Boolean);
    return [Math.min(...bs.map((b) => b.y)), Math.max(...bs.map((b) => b.y + b.h))];
  };
  // header and footer
  const grey = 'fill="rgba(120,120,120,0.12)"';
  const top = Math.round(structure.body.top * scale);
  const bottom = Math.round(structure.body.bottom * scale);
  parts.push(`<rect x="0" y="0" width="${SHEET_WIDTH}" height="${top}" ${grey}/>`);
  parts.push(`<rect x="0" y="${bottom}" width="${SHEET_WIDTH}"`
    + ` height="${Math.max(0, Math.round(H * scale) - bottom)}" ${grey}/>`);
  structure.sections.forEach((s, i) => {
    const [y0, y1] = span(s.bands);
    rect(y0, y1, TONE[i % 2], false, `${s.id} · ${s.background}`);
    if (s.children.length > 1) {
      for (const c of s.children) {
        const [c0, c1] = span(c.bands);
        rect(c0 + 2, c1 - 2, TONE[i % 2], true, `${c.type} ${c.bands.join('–')}`);
      }
    } else if (s.children[0]) {
      const c = s.children[0];
      parts.push(`<text x="8" y="${Math.round(y0 * scale) + 30}" font-size="12"`
        + ` font-family="sans-serif" fill="${TONE[i % 2]}" stroke="#fff" stroke-width="3"`
        + ` paint-order="stroke">${esc(c.type)}</text>`);
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET_WIDTH}"`
    + ` height="${Math.round(H * scale)}">${parts.join('')}</svg>`;
}

const span = (c) => (c.bands.length > 1 ? ` (${c.bands[0]}–${c.bands.at(-1)})` : ` ${c.bands[0]}`);
const outline = (structure) => structure.sections.map((s) => `${s.id} `
  + s.children.map((c) => `${c.type}${span(c)}`).join(' + ')).join(' · ');

function table(structure) {
  const childOf = new Map();
  for (const s of structure.sections) {
    for (const c of s.children) for (const id of c.bands) childOf.set(id, { s, c });
  }
  const rows = structure.bands.map((b) => {
    const { s, c } = childOf.get(b.id) ?? {};
    const runner = b.probabilities ? Object.entries(b.probabilities)
      .filter(([k]) => k !== b.said).sort((x, y) => y[1] - x[1])[0] : null;
    const said = b.said && b.said !== b.type ? ` <small>(said ${esc(b.said)})</small>` : '';
    const sure = `${pct(b.confidence)}${runner ? `, ${esc(runner[0])} ${pct(runner[1])}` : ''}`;
    const joins = `${b.joins === null ? '' : pct(b.joins)}`
      + `${b.joinedBySpacing ? ' <small>spacing</small>' : ''}`;
    const text = esc((b.text ?? []).slice(0, 4).join(' · ').slice(0, 160));
    return `<tr><td class="sec">${s ? esc(s.id) : ''}</td><td>${c ? esc(c.type) : ''}</td>`
      + `<td>${esc(b.id)}</td><td>${esc(b.type)}${said} <small>${sure}</small></td>`
      + `<td>${joins}</td><td>${b.cols}</td><td>${esc(b.bg ?? '')}</td>`
      + `<td><small>${text}</small></td></tr>`;
  });
  return '<table><thead><tr><th>section</th><th>child</th><th>band</th><th>type</th><th>joins</th>'
    + `<th>cols</th><th>bg</th><th>text</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

export async function renderStructure(cwd, selectionName, method = 'bands-system1') {
  const sel = await readSelection(cwd, selectionName);
  if (!sel) throw new Error(`no selection ${selectionName}`);
  const byId = new Map((await readTable(cwd)).pages.map((p) => [p.id, p]));
  const cards = [];
  for (const id of sel.pages) {
    const page = byId.get(id);
    const structure = await readStructure(cwd, id, method);
    const tree = await readTree(cwd, id);
    if (!page || !structure || !tree?.page?.shot) continue;
    const W = tree.tree.bounds.width || 1280;
    const H = tree.page.scrollHeight;
    const scale = SHEET_WIDTH / W;
    cards.push(`<section class="page"><div><div class="url"><a href="${esc(page.url)}"`
      + ` target="_blank">${esc(page.url)}</a></div>
<div class="outline">${esc(outline(structure))} <small>· ${structure.bands.length} bands,`
      + ` ${structure.usage?.inputTokens ?? 0} tokens</small></div>
<div class="stage"><img src="../${esc(shotFile(id))}" loading="lazy">
${overlay(structure, scale, W, H)}</div></div>
<div class="right">${table(structure)}</div></section>`);
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Structure — ${esc(selectionName)} — ${esc(method)}</title><style>${CSS}</style></head>
<body><main>
<h1>Structure: ${esc(selectionName)} by ${esc(method)}</h1>
<p>Solid boxes are sections with their background; dashed boxes the children of a section that has
several; header and footer greyed. The table gives each band the model's type with its confidence
and runner-up, the probability that it forms one part with the band before it, its columns.</p>
${cards.join('\n')}</main></body></html>
`;
}
