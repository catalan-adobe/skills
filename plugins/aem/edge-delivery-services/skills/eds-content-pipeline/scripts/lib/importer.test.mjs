import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  Blocks, DOMUtils, FileUtils, pickImageSrc, sectionMetadata, splitSections,
} from './importer.mjs';
import { blocksOf, parseHtml, sectionsOf } from './validate.mjs';

const UPLOADS = 'https://www.example.com/uploads';
const SOURCE = `<!doctype html><html><body>
<div id="cookieNotice-wrap"><p>We use cookies</p></div>
<main class="wp-site-blocks">
  <div class="wp-block-cover" aria-label="Acme Flight School"
    style="background-image:url(${UPLOADS}/hero.jpg?w=2000);color:#fff">
    <h1>Acme Flight School</h1>
    <p>How a flight school runs on Example</p>
  </div>
  <!-- a comment -->
  <h2>The challenge</h2>
  <p>Paper forms everywhere.</p>
  <hr>
  <div class="wp-block-columns">
    <div class="wp-block-column"><p>Before</p></div>
    <div class="wp-block-column"><p>After</p></div>
  </div>
  <aside class="recent-posts"><h3>Recent Posts</h3></aside>
  <div class="wp-block-cover" style="background-image:url('${UPLOADS}/cta.png')"></div>
</main></body></html>`;

function load(html = SOURCE) {
  const { window } = new JSDOM(html);
  return { document: window.document, main: window.document.querySelector('main') };
}

test('DOMUtils.remove drops every matching descendant and counts them', () => {
  const { document } = load();
  const removed = DOMUtils.remove(document.body, ['#cookieNotice-wrap', 'aside.recent-posts']);
  assert.equal(removed, 2);
  assert.equal(document.querySelector('#cookieNotice-wrap'), null);
  assert.equal(document.querySelector('.recent-posts'), null);
  assert.equal(DOMUtils.remove(document.body, '.does-not-exist'), 0);
  assert.equal(DOMUtils.remove(document.body, 'h1'), 1);
});

test('DOMUtils.replaceBackgroundByImg keeps content and replaces empty holders', () => {
  const { document, main } = load();
  const images = DOMUtils.replaceBackgroundByImg(main, document);
  assert.equal(images.length, 2);
  const hero = main.querySelector('.wp-block-cover');
  assert.equal(hero.firstElementChild.tagName, 'IMG');
  assert.equal(hero.firstElementChild.getAttribute('src'), `${UPLOADS}/hero.jpg?w=2000`);
  assert.equal(hero.firstElementChild.getAttribute('alt'), 'Acme Flight School');
  assert.equal(hero.getAttribute('style'), null);
  assert.equal(hero.querySelector('h1').textContent, 'Acme Flight School');
  assert.equal(main.lastElementChild.tagName, 'IMG');
  assert.equal(main.lastElementChild.getAttribute('src'), `${UPLOADS}/cta.png`);
  assert.equal(main.lastElementChild.getAttribute('alt'), '');
  assert.deepEqual(DOMUtils.replaceBackgroundByImg(main, document), []);
});

test('FileUtils.sanitizePath makes an EDS document path from any URL or pathname', () => {
  const cases = [
    ['https://www.example.com/case-study/Acme-Flight/', '/case-study/acme-flight'],
    ['/case-study/harbour-clinic/', '/case-study/harbour-clinic'],
    ['/', '/index'],
    ['', '/index'],
    ['/blog/post.html', '/blog/post'],
    ['/a//b_c d/', '/a/b-c-d'],
    ['/caf%C3%A9-r%C3%A9sum%C3%A9/', '/cafe-resume'],
    ['/100%', '/100'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(FileUtils.sanitizePath(input), expected, input);
  }
});

test('Blocks.createBlock writes the canonical div form and guards the block name', () => {
  const { document } = load();
  const strong = document.createElement('strong');
  strong.textContent = 'Before';
  const block = Blocks.createBlock(document, {
    name: 'columns',
    variants: ['dark', 'two-up'],
    cells: [[[strong, ' and after'], 'Right'], 'full width'],
  });
  assert.equal(block.className, 'columns dark two-up');
  assert.equal(block.children.length, 2);
  assert.equal(block.children[0].children.length, 2);
  assert.equal(block.children[0].children[0].innerHTML, '<strong>Before</strong> and after');
  assert.equal(block.children[0].children[1].textContent, 'Right');
  assert.equal(block.children[1].children.length, 1);
  assert.equal(block.children[1].textContent, 'full width');
  const bad = [
    [{ name: '2col', cells: [['a']] }, /Invalid block class token "2col"/],
    [{ name: 'hero_wide', cells: [['a']] }, /Invalid block class token/],
    [{ name: 'hero', variants: ['Wide'], cells: [['a']] }, /Invalid block class token "Wide"/],
    [{ name: 'cards', cells: [] }, /Block "cards" has no rows/],
    [{ name: 'cards', cells: [['a', 'b', 'c', 'd', 'e']] }, /at most 4/],
  ];
  for (const [spec, message] of bad) {
    assert.throws(() => Blocks.createBlock(document, spec), message);
  }
});

test('Blocks.getMetadataBlock lowercases keys, keeps nodes and skips empty values', () => {
  const { document } = load();
  const image = document.createElement('img');
  image.setAttribute('src', `${UPLOADS}/og.png`);
  image.setAttribute('alt', '');
  const block = Blocks.getMetadataBlock(document, {
    Title: 'Acme Flight School',
    description: '   ',
    image,
    canonical: 'https://www.example.com/case-study/acme-flight-school/',
    robots: null,
  });
  assert.equal(block.className, 'metadata');
  assert.equal(block.children.length, 3);
  assert.equal(block.children[0].children[0].textContent, 'title');
  assert.equal(block.children[0].children[1].textContent, 'Acme Flight School');
  assert.equal(block.children[1].children[0].textContent, 'image');
  assert.equal(block.children[1].children[1].firstElementChild.tagName, 'IMG');
  assert.equal(block.children[2].children[0].textContent, 'canonical');
  assert.throws(() => Blocks.getMetadataBlock(document, { title: '' }), /at least one key/);
});

test('sectionMetadata joins string lists and titles the Style key', () => {
  const { document } = load();
  const block = sectionMetadata(document, {
    style: ['dark', 'center'],
    Background: `${UPLOADS}/bg.jpg`,
    empty: '',
  });
  assert.equal(block.className, 'section-metadata');
  assert.equal(block.children.length, 2);
  assert.equal(block.children[0].children[0].textContent, 'Style');
  assert.equal(block.children[0].children[1].textContent, 'dark, center');
  assert.equal(block.children[1].children[0].textContent, 'background');
  assert.equal(block.children[1].children[1].textContent, `${UPLOADS}/bg.jpg`);
  assert.throws(() => sectionMetadata(document, { style: '' }), /at least one property/);
});

test('splitSections opens a section at every break selector and drops hr and comments', () => {
  const { main } = load();
  const sections = splitSections(main, ['.wp-block-cover', '.wp-block-columns']);
  assert.equal(sections.length, 3);
  assert.equal(main.children.length, 3);
  assert.ok([...main.children].every((div) => div.tagName === 'DIV' && div.className === ''));
  assert.deepEqual([...sections[0].children].map((c) => c.tagName), ['DIV', 'H2', 'P']);
  assert.deepEqual(
    [...sections[1].children].map((c) => c.className),
    ['wp-block-columns', 'recent-posts'],
  );
  assert.equal(sections[2].children.length, 1);
  assert.equal(main.querySelector('hr'), null);
  assert.ok(!main.innerHTML.includes('a comment'));
});

test('splitSections keeps a single section when nothing breaks', () => {
  const { main } = load('<html><body><main><h1>a</h1><p>b</p></main></body></html>');
  const sections = splitSections(main, ['.never-matches']);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].children.length, 2);
  const empty = load('<html><body><main>  <hr>  </main></body></html>');
  assert.deepEqual(splitSections(empty.main, []), []);
  assert.equal(empty.main.children.length, 0);
});

test('the emitted document is what the content gate parser sees', () => {
  const { document } = load('<!doctype html><html><body><main></main></body></html>');
  const main = document.querySelector('main');
  const h1 = document.createElement('h1');
  h1.textContent = 'Acme Flight School';
  main.append(Blocks.createBlock(document, {
    name: 'columns', variants: ['hero'], cells: [[h1]],
  }));
  const p = document.createElement('p');
  p.textContent = 'Paper forms everywhere.';
  main.append(p);
  main.append(Blocks.getMetadataBlock(document, { title: 'Acme Flight School' }));
  const [hero] = splitSections(main, ['.columns']);
  hero.append(sectionMetadata(document, { style: 'hero' }));
  document.body.insertAdjacentHTML('afterbegin', '<header></header>');
  document.body.insertAdjacentHTML('beforeend', '<footer></footer>');
  const root = parseHtml(document.body.outerHTML);
  assert.equal(sectionsOf(root).length, 1);
  assert.deepEqual(
    blocksOf(root).map((block) => block.attrs.class),
    ['columns hero', 'metadata', 'section-metadata'],
  );
});

test('pickImageSrc keeps the largest srcset candidate within the width cap', () => {
  const { document } = load('<html><body><main></main></body></html>');
  const img = document.createElement('img');
  img.setAttribute('src', `${UPLOADS}/hero.jpg`);
  img.setAttribute('srcset', [
    `${UPLOADS}/hero-1024x683.jpg 1024w`,
    `${UPLOADS}/hero-1536x1024.jpg 1536w`,
    `${UPLOADS}/hero-2048x1365.jpg 2048w`,
    `${UPLOADS}/hero-scaled.jpg 4000w`,
  ].join(', '));
  assert.equal(pickImageSrc(img), `${UPLOADS}/hero-2048x1365.jpg`);
  assert.equal(pickImageSrc(img, { maxWidth: 1200 }), `${UPLOADS}/hero-1024x683.jpg`);
});

test('pickImageSrc falls back to the smallest candidate, then to src', () => {
  const { document } = load('<html><body><main></main></body></html>');
  const only = document.createElement('img');
  only.setAttribute('src', `${UPLOADS}/hero.jpg`);
  only.setAttribute('srcset', `${UPLOADS}/hero-scaled.jpg 4000w`);
  assert.equal(pickImageSrc(only), `${UPLOADS}/hero-scaled.jpg`, 'nothing fits: take the smallest');
  const two = document.createElement('img');
  two.setAttribute('srcset', `${UPLOADS}/a-4000.jpg 4000w, ${UPLOADS}/b-3000.jpg 3000w`);
  assert.equal(pickImageSrc(two), `${UPLOADS}/b-3000.jpg`);
  const bare = document.createElement('img');
  bare.setAttribute('src', `${UPLOADS}/plain.jpg`);
  assert.equal(pickImageSrc(bare), `${UPLOADS}/plain.jpg`, 'no srcset: keep src');
  const density = document.createElement('img');
  density.setAttribute('src', `${UPLOADS}/plain.jpg`);
  density.setAttribute('srcset', `${UPLOADS}/plain-2x.jpg 2x`);
  assert.equal(pickImageSrc(density), `${UPLOADS}/plain.jpg`, 'x descriptors carry no width');
});
