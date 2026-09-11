import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as importer from '../../../../lib/importer.mjs';
import {
  generateDocumentPath,
  match,
  transformDOM,
} from './page.mjs';

const ABOUT = `<!DOCTYPE html><html><head><title>About Us</title></head>
<body>
<header><nav><a href="/">Home</a></nav></header>
<main id="maincontent"><h1>About Us</h1><img src="/img/about.jpg"
alt="About us">
<p>Founded in 2010.</p><p>Quality first.</p></main><footer><p>©
Example</p></footer>
</body></html>`;

test('page matches the root and about, not products', () => {
  assert.equal(match('https://fixture.example/'), true);
  assert.equal(
    match('https://fixture.example/about.html'),
    true,
  );
  assert.equal(
    match('https://fixture.example/product-a.html'),
    false,
  );
});

test('page paths: root is /index, others drop .html', () => {
  assert.equal(
    generateDocumentPath({
      url: 'https://fixture.example/',
    }),
    '/index',
  );
  assert.equal(
    generateDocumentPath({
      url: 'https://fixture.example/about.html',
    }),
    '/about',
  );
});

test('page is one default-content section with the main '
  + 'content, no blocks', () => {
  const { document } = new JSDOM(ABOUT, {
    url: 'https://fixture.example/about.html',
  }).window;
  const { element, warnings } = transformDOM({
    document,
    importer,
  });
  assert.equal(element.children.length, 1, 'one section');
  const [section] = element.children;
  assert.deepEqual(
    [...section.children].map((el) => el.tagName),
    ['H1', 'IMG', 'P', 'P'],
  );
  assert.equal(
    section.querySelector('[class]'),
    null,
    'no block tables',
  );
  assert.deepEqual(warnings, []);
});
