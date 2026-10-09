// The body cut into bands by its pixels alone: rows that are one colour across the width
// are gaps or solid backgrounds; a run of them, or a change of the background colour
// between two runs, is a boundary. Blind to the DOM, which is its value as a second
// reader; blind to semantics, which is why it is never the only one.
export const UNIFORM_STD = 6;
export const MIN_RUN_PX = 6;
export const COLOUR_STEP = 24;
export const MIN_BAND_PX = 16;
// A gap is a band boundary when it is clearly larger than the page's line spacing: this
// many times the median uniform run, and at least this many pixels.
export const GAP_TIMES_MEDIAN = 3;
export const MIN_GAP_PX = 40;

/** Per row of a raw RGB buffer: the mean colour and how uniform the row is. */
export function rowStats(data, width, height, channels = 3) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let sum = 0;
    let sq = 0;
    const base = y * width * channels;
    for (let x = 0; x < width; x += 1) {
      const i = base + x * channels;
      const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      r += data[i]; g += data[i + 1]; b += data[i + 2];
      sum += lum; sq += lum * lum;
    }
    const mean = sum / width;
    rows.push({
      colour: [Math.round(r / width), Math.round(g / width), Math.round(b / width)],
      std: Math.sqrt(Math.max(0, sq / width - mean * mean)),
    });
  }
  return rows;
}

const distance = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]),
  Math.abs(a[2] - b[2]));
const rgb = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

/** Runs of uniform rows: [start, end) with their colour. */
export function uniformRuns(rows, { std = UNIFORM_STD, minRun = MIN_RUN_PX } = {}) {
  const runs = [];
  let start = null;
  for (let y = 0; y <= rows.length; y += 1) {
    const uniform = y < rows.length && rows[y].std < std
      && (start === null || distance(rows[y].colour, rows[start].colour) < COLOUR_STEP);
    if (uniform && start === null) start = y;
    if (!uniform && start !== null) {
      if (y - start >= minRun) runs.push({ start, end: y, colour: rows[start].colour });
      start = null;
      if (y < rows.length && rows[y].std < std) start = y;
    }
  }
  return runs;
}

/**
 * The cuts: the middle of every gap (a uniform run with content on both sides), and the
 * edge of every change of background colour. Then the bands between them, each with the
 * colour of the uniform rows it holds most of, when any.
 */
export function bandsFromPixels(rows, { minBand = MIN_BAND_PX } = {}) {
  const height = rows.length;
  const runs = uniformRuns(rows);
  const lengths = runs.map((r) => r.end - r.start).sort((a, b) => a - b);
  const typical = lengths[Math.floor(lengths.length / 2)] ?? 0;
  const gap = Math.max(MIN_GAP_PX, typical * GAP_TIMES_MEDIAN);
  const cuts = new Set([0, height]);
  let previous = null;
  for (const run of runs) {
    const inner = run.start > 0 && run.end < height;
    if (inner && run.end - run.start >= gap) cuts.add(Math.round((run.start + run.end) / 2));
    if (previous && distance(previous.colour, run.colour) >= COLOUR_STEP) {
      // The content between two runs of different colours changes background somewhere
      // inside; the nearer edge of the darker/lighter run is the best guess.
      cuts.add(run.start);
    }
    previous = run;
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const bands = [];
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const top = sorted[i];
    const bottom = sorted[i + 1];
    if (bottom - top < minBand) continue;
    const inside = runs.filter((r) => r.end > top && r.start < bottom)
      .sort((a, b) => (Math.min(b.end, bottom) - Math.max(b.start, top))
        - (Math.min(a.end, bottom) - Math.max(a.start, top)));
    bands.push({ top, bottom, height: bottom - top,
      background: inside[0] ? rgb(inside[0].colour) : null });
  }
  return { cuts: sorted, bands };
}

/** The pixel reader on an image file: `sharp` reads it, the body is the whole image. */
export async function bandsFromImage(sharp, file) {
  const { data, info } = await sharp(file).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const rows = rowStats(data, info.width, info.height, info.channels);
  return { ...bandsFromPixels(rows), width: info.width, height: info.height };
}
