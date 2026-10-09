import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkBands, claimedBox, parseColour, rowStats } from './pixels.mjs';

// A 20-wide raw image: `rows` is an array of row painters (x) => [r, g, b].
function image(rows) {
  const width = 20;
  const raw = Buffer.alloc(width * rows.length * 3);
  rows.forEach((paint, y) => {
    for (let x = 0; x < width; x += 1) raw.set(paint(x), (y * width + x) * 3);
  });
  return rowStats(raw, width, rows.length);
}
const white = () => [255, 255, 255];
const grey = () => [248, 248, 248];
const textOnWhite = (x) => (x > 5 && x < 15 ? [0, 0, 0] : [255, 255, 255]);

test('parseColour reads rgb and rgba, and a transparent colour is none', () => {
  assert.deepEqual(parseColour('rgb(248, 248, 248)'), [248, 248, 248]);
  assert.deepEqual(parseColour('rgba(1, 2, 3, 0.5)'), [1, 2, 3]);
  assert.equal(parseColour('rgba(0, 0, 0, 0)'), null);
  assert.equal(parseColour(undefined), null);
});

test('rowStats takes the margin colour from the edges and the ink from the middle', () => {
  const [plain, inked] = image([white, textOnWhite]);
  assert.deepEqual(plain.margin, [255, 255, 255]);
  assert.equal(plain.ink.length, 0);
  assert.deepEqual(inked.margin, [255, 255, 255]);
  assert.equal(inked.ink.length, 9);
});

const capture = (bands, leaves, pageBg = 'rgb(255, 255, 255)', bgs = []) => ({ W: 20, H: 8,
  pageBg, leaves, bgs, analysis: { bands } });

test('a band without its own background shows the innermost wide box over it, else the body',
  () => {
    const band = { id: 'B2', y: 4, h: 4, bg: null };
    const grey = 'rgb(230, 234, 237)';
    assert.deepEqual(claimedBox(capture([band], [], grey), band),
      { colour: [230, 234, 237], x0: 0, x1: 1 });
    const wrapper = { x: 2, y: 0, w: 16, h: 8, bg: 'color:rgb(255, 255, 255)' };
    const panel = { x: 0, y: 4, w: 20, h: 4, bg: 'image' };
    assert.deepEqual(claimedBox(capture([band], [], grey, [wrapper]), band),
      { colour: [255, 255, 255], x0: 0.1, x1: 0.9 });
    assert.equal(claimedBox(capture([band], [], grey, [wrapper, panel]), band).colour, null);
    const own = { ...band, bg: 'color:rgb(0, 0, 0)' };
    const black = { x: 1, y: 4, w: 18, h: 4, bg: 'color:rgb(0, 0, 0)' };
    assert.deepEqual(claimedBox(capture([own], [], grey, [wrapper, black]), own),
      { colour: [0, 0, 0], x0: 0.05, x1: 0.95 });
  });

const leaf = (y) => ({ x: 6, y, w: 8, h: 1, t: 'words' });

test('a band claiming a background the picture does not show is a mismatch', () => {
  const rows = image([textOnWhite, textOnWhite, textOnWhite, textOnWhite]);
  const result = checkBands(capture([{ id: 'B1', y: 0, h: 4, bg: 'color:rgb(248, 248, 248)',
    columns: [{ x0: 4, x1: 16 }] }], [leaf(0), leaf(2)]), rows);
  assert.deepEqual(result.bands[0].background, { claimed: [248, 248, 248],
    pixel: [255, 255, 255], agree: false });
  assert.deepEqual(result.flags, ['bg-mismatch']);
});

test('a painted grey band agrees within tolerance; a band with content and no ink is unpainted',
  () => {
    const rows = image([grey, grey, grey, grey, white, white, white, white]);
    const result = checkBands(capture([
      { id: 'B1', y: 0, h: 4, bg: 'color:rgb(246, 246, 246)', columns: [{ x0: 4, x1: 16 }] },
      { id: 'B2', y: 4, h: 4, bg: null, columns: [{ x0: 4, x1: 16 }] },
    ], [leaf(5), leaf(6)]), rows);
    assert.equal(result.bands[0].background.agree, true);
    assert.equal(result.bands[0].unpainted, false, 'no content leaves, not judged');
    assert.equal(result.bands[1].unpainted, true);
    assert.deepEqual(result.flags, ['unpainted']);
  });

test('a dark band inset from the page edges is read inside its box, not at the margins', () => {
  const inset = (x) => (x >= 1 && x < 19 ? [0, 0, 0] : [255, 255, 255]);
  const rows = image([inset, inset, inset, inset]);
  const band = { id: 'B1', y: 0, h: 4, bg: 'color:rgb(0, 0, 0)', columns: [{ x0: 4, x1: 16 }] };
  const box = { x: 1, y: 0, w: 18, h: 4, bg: 'color:rgb(0, 0, 0)' };
  const result = checkBands(capture([band], [], 'rgb(255, 255, 255)', [box]), rows);
  assert.deepEqual(result.bands[0].background, { claimed: [0, 0, 0], pixel: [0, 0, 0],
    agree: true });
  const photo = { x: 2, y: 0, w: 16, h: 4, m: true };
  const bled = checkBands(capture([band], [photo], 'rgb(255, 255, 255)', [box]), rows);
  assert.equal(bled.bands[0].background.pixel, null, 'no column left to read');
  assert.equal(bled.bands[0].background.agree, true);
});

test('ink outside every band is unclaimed; a band past the shot is marked', () => {
  const rows = image([white, white, textOnWhite, textOnWhite]);
  const result = checkBands(capture([{ id: 'B1', y: 0, h: 2, bg: null },
    { id: 'B2', y: 100, h: 50, bg: null }], []), rows);
  assert.equal(result.unclaimedRows, 2);
  assert.deepEqual(result.bands[1], { id: 'B2', beyondShot: true });
  assert.deepEqual(result.flags, []);
});
