// What a System 1 model is told about a band: position, height, background and column
// widths as words (it reads words better than numbers; all counting stays here), and the
// band's content as tokens, column by column, an equal share per column. Ported from the
// site census's blocks.mjs.
export const SCREEN = 900; // the capture's viewport height
export const SNIPPETS = 16; // content tokens per band in the state
const WORDS = ['one', 'two', 'three', 'four', 'five', 'six'];
const INPUTS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function background(bg, leaves = []) {
  if (!bg) return 'none';
  if (bg === 'gradient' || bg === 'image') return bg;
  if (bg === 'media') return mediaBackground(leaves);
  if (!bg.startsWith('color:')) throw new Error(`unknown band background "${bg}"`);
  const [r, g, b, a = 1] = bg.match(/[\d.]+/g).map(Number);
  // A see-through colour depends on what is under it, and the page may be light or dark.
  if (a < 0.5) return 'faint tint';
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? 'dark colour' : 'light colour';
}

export function layout({ cols, columns }) {
  if (cols < 2) return 'one column';
  const widths = columns.map((c) => c.x1 - c.x0);
  const n = WORDS[cols - 1] ?? 'many';
  if (Math.max(...widths) <= 1.25 * Math.min(...widths)) return `${n} equal columns`;
  if (cols > 2) return `${n} columns of different widths`;
  return widths[0] < widths[1] ? 'a narrow column beside a wide one'
    : 'a wide column beside a narrow one';
}

function at({ y, h }, H) {
  if (y < SCREEN / 2) return 'top of the page';
  if (y + h >= H - SCREEN / 2) return 'bottom of the page';
  return y + h / 2 < H / 2 ? 'upper half of the page' : 'lower half of the page';
}

const height = (h) => (h < 100 ? 'thin strip' : h < 400 ? 'short' : h < 1200 ? 'medium' : 'tall');

export function token(l) {
  if (l.e === 'IFRAME') return l.src ? `iframe from ${l.src}` : 'iframe';
  if (l.e === 'PICTURE') return null; // its IMG is a leaf of its own
  if (l.m) {
    return l.e === 'VIDEO' ? 'video' : l.e === 'svg' && l.w < 64 && l.h < 64 ? 'icon' : 'image';
  }
  if (INPUTS.has(l.e)) return 'input field';
  if (!l.t) return null;
  const kind = /^H[1-6]$/.test(l.e) ? l.e.toLowerCase()
    : { A: 'link', BUTTON: 'button' }[l.e] ?? 'text';
  return `${kind}: ${l.t}`;
}

export const contentLeaves = (leaves) => leaves.filter((l) => l.t || l.m || INPUTS.has(l.e));
// A side rail's leaves (`r`) belong to no band: the rail is a page-level part.
export const inBand = (leaves, { y, h }) => leaves.filter((l) => !l.r && l.y + l.h / 2 >= y
  && l.y + l.h / 2 < y + h);

// Column by column, top to bottom, so a card's parts, a sidebar's links and an article's
// paragraphs each stay together. Every column gets an equal share of the tokens: a long
// sidebar must not crowd the main text out of the state.
function content(leaves, columns, budget = SNIPPETS) {
  const col = (l) => Math.max(0, columns.findLastIndex((c) => l.x >= c.x0 - 10));
  const share = Math.ceil(budget / columns.length);
  return columns.flatMap((_, i) => leaves.filter((l) => col(l) === i)
    .sort((a, b) => a.y - b.y || a.x - b.x).map(token).filter(Boolean).slice(0, share));
}

// A wide media element is content, not decoration: name it by what it is.
function mediaBackground(leaves) {
  const widest = leaves.filter((l) => l.m).sort((a, b) => b.w * b.h - a.w * a.h)[0];
  return widest?.e === 'VIDEO' || widest?.e === 'IFRAME' ? 'full-width video' : 'full-width image';
}

// Landmarks around at least a quarter of the band's content: one search form in a long
// article does not make the article a form.
function landmarks(leaves) {
  const n = new Map();
  for (const l of leaves) if (l.l) n.set(l.l, (n.get(l.l) ?? 0) + 1);
  return [...n].filter(([, c]) => c >= leaves.length / 4).sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
}

export function bandState(band, leaves, H) {
  const inside = inBand(contentLeaves(leaves), band);
  const state = {
    at: at(band, H), height: height(band.h),
    background: background(band.bg, inside),
    layout: layout(band), content: content(inside, band.columns),
  };
  const around = landmarks(inside);
  if (around.length) state.inside = around;
  return state;
}
