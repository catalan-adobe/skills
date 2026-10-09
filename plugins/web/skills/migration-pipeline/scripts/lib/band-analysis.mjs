// From a page dump to its bands: paragraph and section spacing read off the page itself,
// gutters likewise, cuts at gaps and background edges and where the header and footer meet
// the content, columns from a thresholded x-projection, continuations merged, side rails
// found from the markup. Ported whole from the site census's bands-probe.mjs; the comments
// are its own. Pure functions over the dump.
export const GAP_RANGE = [32, 80];
export const GUTTER_RANGE = [12, 48];
// A band this short (a toolbar, an ad bar) counts its columns with the set's gutter.
export const THIN = 80;
export const ROW_STEP = 4;   // sample the column profile every N px
export const MIN_RUN = 24;   // a column-count run shorter than this (in content rows) is noise

function coverage(boxes, len, lo = (b) => b.y, hi = (b) => b.y + b.h) {
  const cov = new Uint16Array(len);
  for (const b of boxes) for (let i = Math.max(0, lo(b)); i < Math.min(len, hi(b)); i++)
    cov[i] += 1;
  return cov;
}

function runs(arr, pred) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= arr.length; i++) {
    const on = i < arr.length && pred(arr[i]);
    if (on && start === -1) start = i;
    if (!on && start !== -1) { out.push([start, i]); start = -1; }
  }
  return out;
}

// Columns of a band from a thresholded x-projection: a gutter is an x-range covered in fewer
// than GUTTER_FRAC of the band's content rows. A heading spanning the gutter for 48 px out of
// 1000 does not close it; a divider that persists does. Returns the column x-ranges.
const GUTTER_FRAC = 0.15;
const COLUMN_SUPPORT = 0.4;
const COLUMN_MIN_ROWS = 240;
const MIN_COLUMN_ROWS = 48;
function columnsOf(inside, y0, y1, W, gutter, minRows = MIN_COLUMN_ROWS) {
  const h = y1 - y0;
  const rowHas = new Uint8Array(h);
  for (const b of inside) if (!b.s) for (let y = Math.max(b.y, y0); y < Math.min(b.y + b.h, y1);
    y++) rowHas[y - y0] = 1;
  const contentRows = rowHas.reduce((n, v) => n + v, 0);
  // One row of links or a toolbar is not a multi-column layout.
  if (contentRows < minRows) return [{ x0: 0, x1: W }];
  const xcov = new Float64Array(W);
  for (const b of inside) {
    const rows = Math.min(b.y + b.h, y1) - Math.max(b.y, y0);
    for (let x = Math.max(0, b.x); x < Math.min(W, b.x + b.w); x++) xcov[x] += rows;
  }
  const lo = Math.max(0, Math.min(...inside.map((b) => b.x)));
  const hi = Math.min(W, Math.max(...inside.map((b) => b.x + b.w)));
  // Empty = few rows relatively AND absolutely: a short sidebar beside a long article covers
  // 11 % of the rows but 1000 px of content — not a gutter.
  const gutters = runs(xcov.subarray(lo, hi), (v) => v < GUTTER_FRAC * contentRows &&
    v < COLUMN_MIN_ROWS)
    .filter(([a, b]) => b - a >= gutter);
  const stripes = [];
  let x = lo;
  for (const [a, b] of gutters) { stripes.push({ x0: x, x1: lo + a }); x = lo + b; }
  stripes.push({ x0: x, x1: hi });
  // A stripe is a column only if content sits in it for a good share of the band's rows. One
  // breadcrumb line or a row of icons makes stripes, not columns.
  // A stripe is a column if it holds content for a good share of the band's rows, or for a
  // lot of rows in absolute terms (a 1350 px sidebar beside a 5600 px article).
  const supportRows = (c) => {
    const rows = new Uint8Array(h);
    for (const b of inside) if (b.x < c.x1 && b.x + b.w > c.x0) for (let y = Math.max(b.y, y0);
      y < Math.min(b.y + b.h, y1); y++) rows[y - y0] = 1;
    return rows.reduce((n, v) => n + v, 0);
  };
  const cols = stripes.filter((c) => { const r = supportRows(c);
    return r / contentRows >= COLUMN_SUPPORT || r >= COLUMN_MIN_ROWS; });
  return cols.length >= 2 ? cols : [{ x0: lo, x1: hi }];
}

// A row holding only stretched sticky rails is as empty as a line gap: it must not break runs.
function columnsAtRow(leaves, y, W, gutter) {
  const row = leaves.filter((b) => b.y <= y && y < b.y + b.h);
  if (!row.length || row.every((b) => b.s)) return 0;
  const cov = coverage(row, W, (b) => b.x, (b) => b.x + b.w);
  const lo = Math.min(...row.map((b) => b.x)); const hi = Math.max(...row.map((b) => b.x + b.w));
  const gutters = runs(cov.subarray(lo, hi), (v) => v === 0).filter(([a, b]) => b - a >= gutter);
  return gutters.length + 1;
}

// Sub-ranges of [y0, y1) with a stable column count: a run of ≥ STRUCTURE_RUN px whose column
// count differs from its neighbour's starts a new range. Short runs (a heading line) stay put.
const STRUCTURE_RUN = 120;
function structureCuts(inside, y0, y1, W, gutter) {
  const rows = [];
  for (let y = y0; y < y1; y += ROW_STEP) rows.push({ y, c: columnsAtRow(inside, y, W, gutter) });
  const runs_ = [];
  for (const r of rows) {
    if (r.c === 0) continue;
    const last = runs_.at(-1);
    if (last && last.c === r.c) last.h += ROW_STEP; else runs_.push({ y: r.y, c: r.c,
      h: ROW_STEP });
  }
  const long = runs_.filter((r) => r.h >= STRUCTURE_RUN);
  const cuts = [y0];
  for (let i = 1; i < long.length; i++) if (long[i].c !== long[i - 1].c) cuts.push(long[i].y);
  cuts.push(y1);
  return cuts.slice(0, -1).map((c, i) => [c, cuts[i + 1]]);
}

/** Most frequent value (2 px bins) of a list, or fallback when the list is small. */
function mode(values, fallback, bin = 2) {
  if (values.length < 6) return fallback;
  const count = new Map();
  for (const v of values) { const k = Math.round(v / bin) * bin; count.set(k, (count.get(k) ?? 0) +
    1); }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const percentile = (values, q, fallback) => (values.length < 6 ? fallback
  : [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))]);

/** Empty vertical runs between content (not inside decorated boxes): line,
  paragraph and section spacing. */
function verticalGaps(leaves, bgs, H) {
  const ycov = coverage(leaves, H);
  const inDecorated = (y) => bgs.some((b) => b.y < y && y < b.y + b.h);
  return runs(ycov, (v) => v === 0).filter(([a, b]) => !inDecorated((a + b) / 2) && a > 0 &&
    b < H).map(([a, b]) => b - a);
}

/**
 * Horizontal gaps between a tall box (a paragraph, a card, a column) and its nearest tall right
 * neighbour on the same rows. Word and icon spacing happens between short boxes and never enters.
 */
function horizontalGaps(leaves) {
  const out = [];
  const byY = [...leaves].filter((b) => !b.s && b.h >= 40).sort((a, b) => a.x - b.x);
  for (const a of byY) {
    let best = Infinity;
    for (const b of byY) {
      if (b === a || b.x < a.x + a.w) continue;
      if (b.y < a.y + a.h && a.y < b.y + b.h) best = Math.min(best, b.x - (a.x + a.w));
    }
    if (best > 0 && best < 200) out.push(best);
  }
  return out;
}

// The wide colour covering the most area, not body's computed colour (a grey body under a white
// site wrapper is common). It only decides where white space may be cut and which small boxes are
// content: it is often a section colour (grey sections between white ones), so it must not hide
// backgrounds; see surfaceColor.
function baseColor(bgs) {
  const area = new Map();
  for (const b of bgs) if (b.bg.startsWith('color:')) area.set(b.bg, (area.get(b.bg) ?? 0) +
    b.w * b.h);
  return [...area.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// The page's own surface: a colour box spanning most of the page height (a site wrapper). The
// <body> colour is never recorded as a box, so a page without a wrapper has none.
const surfaceColor = (bgs, H) => bgs.filter((b) => b.bg.startsWith('color:') && b.h >= 0.8 * H)
  .sort((a, b) => b.h - a.h)[0]?.bg ?? null;

/**
 * Where the page's own header and footer (tagged `c` by the capture) meet the content: the
 * white space between them as [start, end], empty where one ends on the row the other starts.
 * Rows where tagged chrome and content overlap (a header laid over a hero) are never cut.
 */
function chromeCuts(leaves, H) {
  const cov = (keep) => coverage(leaves.filter(keep), H);
  const hd = cov((l) => l.c === 'header');
  const ft = cov((l) => l.c === 'footer');
  const ct = cov((l) => !l.c);
  const out = [];
  let last = null;
  let end = 0;
  for (let y = 0; y < H; y++) {
    const kind = (ct[y] ? 'c' : '') + (hd[y] ? 'h' : '') + (ft[y] ? 'f' : '');
    if (!kind) continue;
    if (kind.length > 1) last = null;
    else if (last && kind !== last) out.push([end, y]);
    if (kind.length === 1) last = kind;
    end = y + 1;
  }
  return out;
}

// A colour with alpha 0 paints nothing: not a background, not a decoration.
const paints = (bg) => !/^color:rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(bg);

/**
 * The background a band sits on, among `boxes` covering 60 % of its height. A photo or video
 * counts only with text on it (a hero); without, it is the band's content. The smallest box
 * wins; of boxes the same size, an image or gradient paints over its container's colour.
 */
function backgroundOf(y0, y1, boxes, textOn) {
  const cover = boxes.filter((b) => Math.min(b.y + b.h, y1) - Math.max(b.y, y0) >= 0.6 * (y1 - y0)
    && (b.bg !== 'media' || textOn(b))).sort((a, b) => a.w * a.h - b.w * b.h);
  if (!cover.length) return null;
  const tied = cover.filter((b) => b.w * b.h <= 1.02 * cover[0].w * cover[0].h);
  return (tied.find((b) => !b.bg.startsWith('color:')) ?? tied[0]).bg;
}

/**
 * Bands of a page dump. `setGutter`, the set's usual gutter (the census passes its instances'
 * median), is a floor for bands under THIN px: a toolbar or ad bar is laid out the same on every
 * page, and a narrow gutter found in one page's body text must not change its column count.
 */
// A side rail the page's markup marks (#3): its own nav or aside, or a sticky column, narrow beside
// the main content. It is a page-level part like the header and footer: its leaves leave the bands,
// and the content beside it is cut by its own white space. Unmarked side columns stay in the bands.
const RAIL_WIDTH = 0.4; // at most this share of the page's content width
const RAIL_BESIDE = 0.5; // other content beside it spans at least this share of its height
// A rail is a column of items: at least this many. On the stored censuses, marked groups of one or
// two items were boxes under 131 px (sponsor labels, share buttons); every real rail held 3 to 126.
const RAIL_ITEMS = 3;
// Marked: sticky, or inside a nav or aside (the innermost landmark, or any step of its path: a
// search form inside the side navigation's aside has `form` as its innermost landmark).
const NAV_STEP = /^(nav|aside)( |$)/; // the tag itself, not a custom element such as <nav-bar>
const railMarked = (l, paths) => !l.c && (l.s || l.l === 'nav' || l.l === 'aside'
  || (paths?.[l.p] ?? '').split(' > ').some((step) => NAV_STEP.test(step)));
// The element a marked leaf belongs to: its sticky column, else its own nav or aside (the path down
// to the last such step), so that a breadcrumb nav and a side nav stay apart.
function railKey(l, paths) {
  if (l.s) return 'sticky';
  const steps = (paths?.[l.p] ?? '').split(' > ');
  const i = steps.findLastIndex((step) => NAV_STEP.test(step));
  return i < 0 ? l.l : steps.slice(0, i + 1).join(' > ');
}

/**
 * Rails among a page's content leaves:
 * `{ rails: [{ side, x0, x1, y0, y1, kind, n }], railOf: Map<leaf, side> }`.
 */
export function findRails(leaves, W, paths) {
  const railOf = new Map();
  const rails = [];
  const others = leaves.filter((l) => !l.c && !railMarked(l, paths));
  if (!others.length) return { rails, railOf };
  const lo = Math.min(...leaves.filter((l) => !l.c).map((l) => l.x));
  const hi = Math.max(...leaves.filter((l) => !l.c).map((l) => l.x + l.w));
  for (const own of Map.groupBy(leaves.filter((l) => railMarked(l, paths)), (l) => railKey(l,
    paths)).values()) {
    // One element's leaves in columns by overlapping x; two columns closer than the narrower one's
    // width are one (a sticky progress bar 12 px beside its table of contents).
    const columns = [];
    for (const l of [...own].sort((a, b) => a.x - b.x)) {
      const last = columns.at(-1);
      const near = last && l.x - last.x1 < Math.min(last.x1 - last.x0, l.w);
      if (last && (l.x < last.x1 || near)) { last.items.push(l); last.x1 = Math.max(last.x1, l.x +
        l.w); } else columns.push({ x0: l.x, x1: l.x + l.w, items: [l] });
    }
    for (const c of columns) {
      if (c.items.length < RAIL_ITEMS || c.x1 - c.x0 > RAIL_WIDTH * (hi - lo)) continue;
      const y0 = Math.min(...c.items.map((l) => l.y)), y1 = Math.max(...c.items.map((l) => l.y +
        l.h));
      const beside = others.filter((l) => (l.x >= c.x1 || l.x + l.w <= c.x0) && l.y < y1 && l.y +
        l.h > y0);
      if (!beside.length) continue;
      const span = Math.min(y1, Math.max(...beside.map((l) => l.y + l.h))) - Math.max(y0,
        Math.min(...beside.map((l) => l.y)));
      if (span < RAIL_BESIDE * (y1 - y0)) continue;
      const right = beside.filter((l) => l.x >= c.x1).length;
      const side = right * 2 >= beside.length ? 'left' : 'right';
      const kinds = c.items.map((l) => (l.s ? 'sticky' : l.l));
      const kind = [...Map.groupBy(kinds, (k) => k)]
        .sort((a, b) => b[1].length - a[1].length)[0][0];
      rails.push({ side, x0: c.x0, x1: c.x1, y0, y1, kind, n: c.items.length });
      for (const l of c.items) railOf.set(l, side);
    }
  }
  rails.sort((a, b) => a.x0 - b.x0);
  return { rails, railOf };
}

/**
 * Whether a reanalysis left a page's bands and rails as they were: then its System 1
 * answers stand.
 */
export const sameBands = (before, after) => JSON.stringify(before.rails ?? [])
  === JSON.stringify(after.rails)
  && before.bands.length === after.bands.length
  && before.bands.every((b, i) => ['id', 'y', 'h', 'cols']
    .every((k) => b[k] === after.bands[i][k]));

export function analyse({ W, H, leaves: stamped, bgs: stored, paths }, { setGutter } = {}) {
  const allLeaves = stamped.map(({ r, ...l }) => l);
    // rails found by an earlier analysis are found again
  const allBgs = stored.filter((b) => paints(b.bg));
  const base = baseColor(allBgs);
  const bgs = allBgs.filter((b) => b.bg !== base);
  // What a band sits on, and where one background ends: every box but the page's own surface.
  const surface = surfaceColor(allBgs, H);
  const backgrounds = allBgs.filter((b) => b.bg !== surface);
  // Content = text, media, or a box with its own decorated background (a tile, a card).
  // Empty undecorated boxes (spacers, overlay anchors) are not content.
  const content = allLeaves.filter((b) => b.t || b.m || (b.d && b.d !== base && paints(b.d)));
  // Input fields carry no text, yet blocks.mjs reads them: one inside a rail is the rail's too.
  const inContent = new Set(content);
  const inputs = allLeaves.filter((b) => /^(INPUT|TEXTAREA|SELECT)$/.test(b.e) &&
    !inContent.has(b));
  const { rails, railOf } = findRails([...content, ...inputs], W, paths);
  const leaves = content.filter((b) => !railOf.has(b));
  const onBox = new Map();
  const textOn = (box) => {
    if (!onBox.has(box)) {
      onBox.set(box, leaves.some((l) => l.t && l.x + l.w / 2 > box.x && l.x + l.w / 2 < box.x +
        box.w
        && l.y + l.h / 2 > box.y && l.y + l.h / 2 < box.y + box.h));
    }
    return onBox.get(box);
  };
  // A section's style comes from a box as wide as the page's widest background (full-bleed);
  // a narrower one (a card, a panel, a toolbar) decorates a block inside the section.
  const widest = Math.max(0, ...backgrounds.map((b) => b.w));
  const fullBleed = backgrounds.filter((b) => b.w >= widest - 4);
  // Paragraph spacing is the modal whitespace run; a band break is a clear multiple of it.
  const GAP = clamp(1.5 * mode(verticalGaps(leaves, bgs, H).filter((g) => g >= 8 && g <= 60), 27),
    GAP_RANGE);
  // The grid gutter is the smallest significant gap between tall neighbours (20th percentile):
  // the mode gets captured by whichever layout has the most blocks, hiding narrower gutters.
  const GUTTER = clamp(0.8 * percentile(horizontalGaps(leaves), 0.2, 30), GUTTER_RANGE);
  const CONTINUE_GAP = 2 * GAP;
  const ycov = coverage(leaves, H);
  const cuts = new Set([0, H]);
  // A decorated box owns its whole extent: no gap cuts inside it (padding above a CTA button).
  const inDecorated = (y) => bgs.some((b) => b.y < y && y < b.y + b.h);
  for (const [a, b] of runs(ycov, (v) => v === 0)) {
    const mid = Math.round((a + b) / 2);
    if (b - a >= GAP && !inDecorated(mid)) cuts.add(mid);
  }
  for (const b of backgrounds) { cuts.add(b.y); cuts.add(b.y + b.h); }
  // The site's header and footer never share a band with content, white space or not. A cut
  // already in that white space (a gap, a background edge) is the edge; else its middle.
  const chrome = new Set();
  for (const [a, b] of chromeCuts(leaves, H)) {
    const c = [...cuts].find((x) => x >= a && x <= b) ?? Math.round((a + b) / 2);
    cuts.add(c);
    chrome.add(c);
  }
  const edges = [...cuts].filter((c) => c >= 0 && c <= H).sort((a, b) => a - b);
  const bands = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const [y0, y1] = [edges[i], edges[i + 1]];
    if (y1 - y0 < 8) continue;
    const inside = leaves.filter((b) => b.y < y1 && b.y + b.h > y0);
    if (!inside.length) continue;
    const bg = backgroundOf(y0, y1, backgrounds, textOn);
    const sbg = backgroundOf(y0, y1, fullBleed, textOn);
    // column profile: runs of equal column count down the band
    // Empty rows (line gaps, padding) do not break a run: only a change of column count does.
    const profile = [];
    for (let y = y0; y < y1; y += ROW_STEP) {
      const c = columnsAtRow(inside, y, W, GUTTER);
      if (c === 0) continue;
      const last = profile.at(-1);
      if (last && last.cols === c) last.h += ROW_STEP; else profile.push({ cols: c, h: ROW_STEP });
    }
    const clean = profile.filter((p) => p.h >= MIN_RUN);
    // A sustained change of column structure inside the band is a boundary too (a 2-up card
    // row stacked on a 3-up one with no whitespace or background between them).
    for (const [s0, s1] of structureCuts(inside, y0, y1, W, GUTTER)) {
      const part = inside.filter((b) => b.y < s1 && b.y + b.h > s0);
      if (!part.length) continue;
      const columns = columnsOf(part, s0, s1, W, GUTTER, 0); // no min-rows yet: rows merge first
      const text = part.filter((b) => b.t).sort((a, b) => a.y - b.y || a.x - b.x)
        .map((b) => b.t).slice(0, 6);
      bands.push({ y: s0, h: s1 - s0, bg, sbg, cols: columns.length, columns,
        profile: clean.map((p) => `${p.cols}×${p.h}`).join(' '), text, inside: part });
    }
  }
  // Merge continuations on the raw columns, then judge column-ness on the merged band: two
  // 28 px rows of a 3-up link list are one 56 px 3-column band, one 28 px toolbar is not.
  // Continuations never cross the header or footer edge, nor the edges of a full-width photo that
  // is content (no text on it): a banner image stays a band of its own.
  const hard = new Set([...chrome, ...backgrounds.filter((b) => b.bg === 'media' &&
    !textOn(b)).flatMap((b) => [b.y, b.y + b.h])]);
  const merged = mergeContinuations(bands, CONTINUE_GAP, hard).map((b) => {
    const columns = columnsOf(b.inside, b.y, b.y + b.h, W, setGutter && b.h < THIN ?
      Math.max(GUTTER, setGutter) : GUTTER);
    return { ...b, columns, cols: columns.length };
  });
  return {
    base, gap: GAP, gutter: GUTTER, bands: merged.map((b, i) => ({ id: `B${i + 1}`, ...b,
      inside: undefined })),
    rails, leaves: allLeaves.map((l) => (railOf.has(l) ? { ...l, r: railOf.get(l) } : l)),
  };
}

// Consecutive bands that continue the same column structure — a sidebar's tail under its list,
// result rows under filters + results, one card row under another — are one band when they sit
// on the same background, their contents close together, and every column of the lower band
// lands on a column of the upper one. Contents, not band boxes: bands are cut in the middle of
// the white space between them, so their boxes always touch. A list whose items sit further apart
// than that stays split here; structure.mjs joins its pieces by meaning.
const overlapsCol = (a, b) => a.x0 < b.x1 - 10 && b.x0 < a.x1 - 10;
const contentTop = (band) => Math.min(...band.inside.map((l) => l.y));
const contentBottom = (band) => Math.max(...band.inside.map((l) => l.y + l.h));
function mergeContinuations(bands, CONTINUE_GAP, hard) {
  const out = [];
  for (const b of bands) {
    const prev = out.at(-1);
    let fits = prev && !hard.has(b.y) && b.bg === prev.bg && contentTop(b) - contentBottom(prev)
      <= CONTINUE_GAP;
    if (fits && b.cols === 1 && prev.cols >= 2) {
      // a full-width heading/intro under a grid starts the next section; a narrow block that
      // sits inside some, not all, of the grid's columns is a column's tail
      const lo = Math.min(...b.inside.map((l) => l.x)), hi = Math.max(...b.inside.map((l) => l.x +
        l.w));
      // …and only the column(s) that ran lowest can have a tail: when every column ends at the
      // same height, a centred heading below them starts the next row. A stretched sticky rail
      // ends where its own scroll box is clipped, not where a column's content does: left out.
      const bottom = (c) => Math.max(0, ...prev.inside.filter((l) => !l.s && l.x < c.x1 && l.x +
        l.w > c.x0).map((l) => l.y + l.h));
      const bottoms = prev.columns.map(bottom);
      fits = prev.columns.some((_, i) => prev.columns.some((__, j) => j >= i && j - i +
        1 < prev.cols
        && lo >= prev.columns[i].x0 - 10 && hi <= prev.columns[j].x1 + 10
        && Math.max(...bottoms.slice(i, j + 1)) > Math.max(0, ...bottoms.filter((_, k) => k < i ||
          k > j)) + 8));
    } else if (fits && prev.cols === 1 && b.cols >= 2) {
      fits = false;
    } else if (fits && b.cols >= 2) {
      fits = b.columns.every((c) => prev.columns.some((pc) => overlapsCol(c, pc)));
    }
    if (fits) {
      prev.h = b.y + b.h - prev.y;
      prev.text = [...prev.text, ...b.text].slice(0, 8);
      prev.profile = `${prev.profile} | ${b.profile}`;
      prev.inside = [...prev.inside, ...b.inside];
    } else out.push({ ...b });
  }
  return out;
}

