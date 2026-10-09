import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyEdges } from './crops.mjs';

test('the body is what lies between the located header and footer', () => {
  const frags = [{ id: 'frg-000000000001', part: 'header' },
    { id: 'frg-000000000002', part: 'footer' }];
  const comp = (placed) => ({ fragments: placed });
  const box = (y, height) => ({ x: 0, y, width: 1280, height });
  assert.deepEqual(bodyEdges(comp([
    { ref: 'frg-000000000001', selector: 'h', bounds: box(0, 133) },
    { ref: 'frg-000000000002', selector: 'f', bounds: box(2400, 600) },
  ]), frags, 3000), { top: 133, bottom: 2400 });
  const footerOnly = comp([{ ref: 'frg-000000000002', selector: 'f', bounds: box(2400, 600) }]);
  assert.deepEqual(bodyEdges(footerOnly, frags, 3000), { top: 0, bottom: 2400 },
    'no header: the body starts at the top');
  assert.deepEqual(bodyEdges(comp([{ ref: 'frg-000000000001', selector: 'h' }]), frags, 3000),
    { top: 0, bottom: 3000 }, 'a fragment without bounds says nothing');
  assert.deepEqual(bodyEdges(comp([
    { ref: 'frg-000000000001', selector: 'u', bounds: box(0, 53) },
    { ref: 'frg-000000000001', selector: 'n', bounds: box(53, 80) },
  ]), frags, 3000), { top: 133, bottom: 3000 }, 'two header bands: the lowest bottom');
});
