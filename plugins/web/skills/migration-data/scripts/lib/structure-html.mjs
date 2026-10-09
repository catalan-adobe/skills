// The structure review: a method's reading of each page's first level drawn over its
// screenshot — the candidate cuts the tree proposed as dashed lines, one solid box per
// derived band coloured by its kind (section, block, default content) with its layout,
// header and footer greyed — and beside it a row per candidate with the facts, the model's
// probabilities and the decision. For judging what the method produces, and where to
// correct it. A view, rendered, never edited.
import { esc } from './report-html.mjs';
import { disagreement, readPixelCheck, readStructure } from './bands.mjs';
import { read as readSelection } from './selections.mjs';
import { read as readTable } from './pages.mjs';
import { read as readTree, shotFile } from './trees.mjs';

export const SHEET_WIDTH = 600;
export const COLOUR = { section: '#6a3fd1', block: '#e07b00', default_content: '#0a8f5a' };

const CSS = `
body { margin: 0; font: 13px/1.4 -apple-system, system-ui, sans-serif; color: #1c1c1c; }
main { max-width: 1600px; margin: 0 auto; padding: 20px; }
h1 { font-size: 20px; } .page { display: grid; grid-template-columns: ${SHEET_WIDTH}px 1fr;
  gap: 18px; padding: 18px 0; border-bottom: 1px solid #e3e3e3; align-items: start; }
.url { font-size: 15px; font-weight: 600; word-break: break-all; margin: 0 0 6px; }
.pixels { color: #b3261e; font-size: 13px; margin: 0 0 6px; }
.outline { color: #444; margin: 0 0 8px; }
.stage { position: relative; width: ${SHEET_WIDTH}px; }
.stage img { display: block; width: ${SHEET_WIDTH}px; }
.stage svg { position: absolute; left: 0; top: 0; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { text-align: left; vertical-align: top; padding: 4px 8px 4px 0;
  border-bottom: 1px solid #eee; }
th { color: #666; font-weight: 600; font-size: 11px; text-transform: uppercase; }
td.band { font-weight: 600; white-space: nowrap; } .right { position: sticky; top: 10px; }
.kind-section { color: ${COLOUR.section}; } .kind-block { color: ${COLOUR.block}; }
.kind-default_content { color: ${COLOUR.default_content}; }
.rule { color: #777; font-style: italic; }
small { color: #777; }
`;

const pct = (x) => (typeof x === 'number' ? `${Math.round(x * 100)}` : '');

function overlay(structure, scale, H) {
  const parts = [];
  const grey = 'fill="rgba(120,120,120,0.12)"';
  const top = Math.round(structure.body.top * scale);
  const bottom = Math.round(structure.body.bottom * scale);
  if (top > 0) parts.push(`<rect x="0" y="0" width="${SHEET_WIDTH}" height="${top}" ${grey}/>`);
  const footH = Math.round(H * scale) - bottom;
  if (footH > 0) {
    parts.push(`<rect x="0" y="${bottom}" width="${SHEET_WIDTH}" height="${footH}" ${grey}/>`);
  }
  for (const c of structure.candidates) {
    const y = Math.round(c.top * scale);
    parts.push(`<line x1="0" y1="${y}" x2="${SHEET_WIDTH}" y2="${y}" stroke="#0a4fd1"`
      + ' stroke-width="1" stroke-dasharray="5 4"/>');
    parts.push(`<text x="${SHEET_WIDTH - 4}" y="${y + 11}" font-size="10" font-family="sans-serif"`
      + ` fill="#0a4fd1" stroke="#fff" stroke-width="3" paint-order="stroke" text-anchor="end">`
      + `${esc(c.id)}</text>`);
  }
  for (const b of structure.bands) {
    const y = Math.round(b.top * scale);
    const h = Math.max(2, Math.round((b.bottom - b.top) * scale));
    const colour = COLOUR[b.kind] ?? '#999';
    parts.push(`<rect x="2" y="${y}" width="${SHEET_WIDTH - 4}" height="${h}" fill="none"`
      + ` stroke="${colour}" stroke-width="3"/>`);
    const label = `${b.id} · ${b.kind}${b.layout !== 'single' ? ` · ${b.layout}` : ''}`
      + (b.members.length > 1 ? ` · ${b.members.join('+')}` : '') + (b.leaf ? ' · leaf' : '');
    parts.push(`<text x="8" y="${y + 14}" font-size="12" font-family="sans-serif"`
      + ` font-weight="600" fill="${colour}" stroke="#fff" stroke-width="3" paint-order="stroke">`
      + `${esc(label)}</text>`);
    // level 2: the side columns hatched, the children dashed inside the band
    const sides = (x) => [...(x.side ?? []), ...(x.children ?? []).flatMap(sides)];
    for (const sd of sides(b)) {
      const [sx, sy] = [Math.round(sd.x * scale), Math.round(sd.top * scale)];
      const [sw, sh] = [Math.round(sd.w * scale), Math.round((sd.bottom - sd.top) * scale)];
      parts.push(`<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}"`
        + ' fill="rgba(10,79,209,0.08)" stroke="#0a4fd1" stroke-width="1"'
        + ' stroke-dasharray="2 3"/>');
      parts.push(`<text x="${sx + sw - 4}" y="${sy + 12}" font-size="10" font-family="sans-serif"`
        + ' fill="#0a4fd1" text-anchor="end" stroke="#fff" stroke-width="3" paint-order="stroke">'
        + 'side</text>');
    }
    const drawChildren = (children, depth) => {
      for (const k of children) {
        const ky = Math.round(k.top * scale);
        const kh = Math.max(2, Math.round((k.bottom - k.top) * scale));
        const kc = COLOUR[k.kind] ?? '#999';
        const inset = 14 * depth;
        parts.push(`<rect x="${inset}" y="${ky + depth}" width="${SHEET_WIDTH - 2 * inset}"`
          + ` height="${Math.max(2, kh - 2 * depth)}" fill="none" stroke="${kc}" stroke-width="1.5"`
          + ' stroke-dasharray="6 4"/>');
        const kl = `${k.id} ${k.kind}${k.layout !== 'single' ? ` · ${k.layout}` : ''}`;
        parts.push(`<text x="${SHEET_WIDTH - inset - 4}" y="${ky + 11 + 12 * (depth - 1)}"`
          + ` font-size="11" font-family="sans-serif" fill="${kc}" text-anchor="end" stroke="#fff"`
          + ` stroke-width="3" paint-order="stroke">${esc(kl)}</text>`);
        if (k.children) drawChildren(k.children, depth + 1);
      }
    };
    drawChildren(b.children ?? [], 1);
  }
  return `<svg width="${SHEET_WIDTH}" height="${Math.round(H * scale)}">${parts.join('')}</svg>`;
}

const outline = (structure) => structure.bands.map((b) => (
  `${b.id} ${b.kind}${b.layout !== 'single' ? `/${b.layout}` : ''}`)).join(' · ');

function table(structure) {
  const bandOf = new Map(structure.bands.flatMap((b) => b.members.map((m) => [m, b.id])));
  const mark = (k) => {
    for (const m of k.members) bandOf.set(m, k.id);
    (k.children ?? []).forEach(mark);
  };
  for (const b of structure.bands) (b.children ?? []).forEach(mark);
  const rows = [...structure.candidates, ...(structure.children ?? [])].map((c) => {
    const p = c.probabilities ?? {};
    const probs = c.probabilities ? `default ${pct(p.default_content)} · block ${pct(p.block)}`
      + ` · section ${pct(p.section)} · title↑ ${pct(p.title_above)}` : '';
    const rule = c.rule ? `<span class="rule">${esc(c.rule)}</span>`
      : c.kind !== c.judged ? `<span class="rule">model said ${esc(c.judged)}</span>` : '';
    const merge = c.merge === null || c.id === structure.candidates[0]?.id ? ''
      : c.empty ? '<small>empty</small>' : `${pct(c.merge)} %`;
    const f = c.facts ?? {};
    const factsText = [c.state?.picture, c.state?.text, c.state?.headings].filter(Boolean)
      .join(' · ');
    const text = (c.state?.content ?? []).slice(0, 3)
      .map((t) => String(t).replace(/^[^:]+:\s*/, '')).join(' · ');
    return `<tr><td class="band">${esc(bandOf.get(c.id) ?? '')}</td><td>${esc(c.id)}</td>`
      + `<td class="kind-${esc(c.kind)}">${esc(c.kind)} ${rule}</td>`
      + `<td>${esc(c.layout)}</td><td>${merge}</td><td><small>${esc(probs)}</small></td>`
      + `<td><small>${esc(factsText)}${f.leaves === 0 ? ' · empty' : ''}</small></td>`
      + `<td><small>${esc(text)}</small></td></tr>`;
  });
  return '<table><thead><tr><th>band</th><th>cand</th><th>kind</th><th>layout</th><th>merge</th>'
    + '<th>probabilities</th><th>facts</th><th>text</th></tr></thead>'
    + `<tbody>${rows.join('')}</tbody></table>`;
}

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
    cards.push(`<section class="page"><div><div class="url"><a href="${esc(page.url)}"`
      + ` target="_blank">${esc(page.url)}</a></div>
<div class="outline">${esc(outline(structure))} <small>· ${structure.candidates.length} candidates,`
      + ` ${structure.usage?.inputTokens ?? 0} tokens</small></div>
${pixelsLine(pixels)}<div class="stage"><img src="../${esc(shotFile(id))}" loading="lazy">
${overlay(structure, scale, H)}</div></div>
<div class="right">${table(structure)}</div></section>`);
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Structure — ${esc(selectionName)} — ${esc(method)}</title><style>${CSS}</style></head>
<body><main>
<h1>Structure: ${esc(selectionName)} by ${esc(method)}</h1>
<p>Dashed blue lines are the candidate cuts the tree proposed; solid boxes the bands after the
model's merges, coloured by kind — <span class="kind-section">section</span>,
<span class="kind-block">block</span>, <span class="kind-default_content">default content</span>
— with their layout. The table gives each candidate the model's probabilities, the decision
and the rule that changed it, the merge probability with the candidate before, and the facts
the model was told.</p>
${cards.join('\n')}</main></body></html>
`;
}
