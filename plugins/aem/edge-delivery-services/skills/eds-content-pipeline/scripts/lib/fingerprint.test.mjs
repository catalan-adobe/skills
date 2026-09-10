import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprintFromTree, similarity, clusterRecords, pickRepresentatives, nameCluster,
} from './fingerprint.mjs';

const box = (tag, height, extra = {}) => ({
  tag, bounds: { width: 1440, height }, children: [], ...extra,
});
const tree = (children) => ({
  data: { tag: 'body', bounds: { width: 1440, height: 5000 }, children },
  nodeMap: {},
});

test('fingerprintFromTree tokenises top-level boxes with height buckets', () => {
  const fp = fingerprintFromTree(tree([
    box('header', 60), box('section', 700, { layout: 'grid-3', className: 'hero wp-block' }),
    box('footer', 300),
  ]));
  assert.equal(fp.coarse, 'header[xs]|section[md]|footer[sm]');
  assert.equal(fp.sectionCount, 3);
  assert.deepEqual(fp.features, ['grid-3', 'hero']);
  assert.match(
    fp.fine,
    /^body\[xl\]\|header\[xs\]\|section\[grid-3\]\[hero\]\[md\]\|footer\[sm\]$/,
  );
});

test('overlay nodes are skipped and depth is bounded', () => {
  const t = tree([
    box('div', 900, { children: [box('p', 20, { children: [box('span', 20)] })] }),
    box('div', 400),
  ]);
  t.nodeMap.rc2 = { overlay: true };
  const fp = fingerprintFromTree(t, { maxDepth: 2 });
  assert.equal(fp.coarse, 'div[md]');
  assert.equal(fp.fine.split('|').length, 3); // body, div, p — span is beyond depth
});

test('two pages with the same boxes are similar, different ones are not', () => {
  const a = fingerprintFromTree(tree([
    box('header', 60), box('main', 2000), box('footer', 300),
  ])).fine;
  const b = fingerprintFromTree(tree([
    box('header', 60), box('main', 2200), box('footer', 300),
  ])).fine;
  const c = fingerprintFromTree(tree([
    box('header', 60), box('aside', 300), box('table', 100),
  ])).fine;
  assert.equal(similarity(a, b), 1);
  assert.ok(similarity(a, c) < 0.6);
  const clusters = clusterRecords([
    { url: 'u1', sitemapType: 'page', fingerprint: a },
    { url: 'u2', sitemapType: 'page', fingerprint: b },
    { url: 'u3', sitemapType: 'page', fingerprint: c },
  ]);
  assert.equal(clusters.length, 2);
});

test('similarity is 1 for identical sequences and proportional to shared order', () => {
  assert.equal(similarity('a|b|c', 'a|b|c'), 1);
  assert.equal(similarity('a|b|c', 'a|c'), 0.8);
  assert.equal(similarity('a|b', 'x|y'), 0);
  assert.equal(similarity('', ''), 1);
});

test('clusterRecords groups per sitemap type using the similarity threshold', () => {
  const records = [
    { url: 'u1', sitemapType: 'post', fingerprint: 'hero|body|related' },
    { url: 'u2', sitemapType: 'post', fingerprint: 'hero|body|related' },
    { url: 'u3', sitemapType: 'post', fingerprint: 'hero|body|table|related' },
    { url: 'u4', sitemapType: 'post', fingerprint: 'cards|cards|cards|cards|cards' },
    { url: 'u5', sitemapType: 'page', fingerprint: 'hero|body|related' },
  ];
  const clusters = clusterRecords(records, { threshold: 0.8 });
  assert.deepEqual(clusters.map((c) => [c.sitemapType, c.index, c.members]), [
    ['page', 0, ['u5']],
    ['post', 0, ['u1', 'u2', 'u3']],
    ['post', 1, ['u4']],
  ]);
  assert.equal(clusters[1].fingerprint, 'hero|body|related');
});

test('pickRepresentatives maximizes feature coverage', () => {
  const members = [
    { url: 'a', features: ['hero', 'cta'] },
    { url: 'b', features: ['hero', 'cta', 'video', 'faq'] },
    { url: 'c', features: ['table'] },
    { url: 'd', features: ['hero'] },
  ];
  assert.deepEqual(pickRepresentatives(members, 2), ['b', 'c']);
  assert.deepEqual(pickRepresentatives(members, 10), ['b', 'c', 'a', 'd']);
  assert.deepEqual(pickRepresentatives([], 3), []);
});

test('nameCluster keeps the seed for the first cluster and numbers the rest', () => {
  assert.equal(nameCluster('blog-post', 0), 'blog-post');
  assert.equal(nameCluster('blog-post', 1), 'blog-post-2');
});
