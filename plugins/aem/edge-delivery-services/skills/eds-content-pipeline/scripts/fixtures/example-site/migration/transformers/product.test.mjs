import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as importer from '../../../../lib/importer.mjs';

const mod = await import('./product.mjs').catch(() => null);
const { transformDOM } = mod || {};

test('transformDOM is defensive against missing elements', async () => {
  const html = `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
<main id="maincontent">
  <h1>Some Title</h1>
  <p>No product sections here.</p>
</main>
</body>
</html>`;
  const dom = new JSDOM(html);
  const { element, warnings } = transformDOM({
    document: dom.window.document,
    importer,
  });
  assert.ok(element, 'should return an element');
  assert.equal(warnings.length, 2, 'should have 2 warnings');
  assert.match(warnings[0], /hero|missing/i,
    'first warning about missing hero');
  assert.match(warnings[1], /specs|empty|rows/i,
    'second warning about empty specs');
});
