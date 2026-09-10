import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSitemap,
  sitemapTypeFromUrl,
  collectSitemaps,
} from './sitemap.mjs';

const index = (
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
  `<sitemap><loc>https://x.test/post-sitemap.xml</loc>` +
  `<lastmod>2026-09-01T21:37:19+00:00</lastmod></sitemap>` +
  `<sitemap><loc>https://x.test/page-sitemap.xml</loc></sitemap>` +
  `</sitemapindex>`
);

const urlset = (
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
  `<url><loc>https://x.test/a?x=1&amp;y=2</loc>` +
  `<lastmod>2026-01-01</lastmod></url>` +
  `<url><loc> https://x.test/b </loc></url>` +
  `</urlset>`
);

test('parses a sitemap index', () => {
  const parsed = parseSitemap(index);
  assert.equal(parsed.kind, 'index');
  assert.deepEqual(parsed.entries, [
    { loc: 'https://x.test/post-sitemap.xml', lastmod: '2026-09-01T21:37:19+00:00' },
    { loc: 'https://x.test/page-sitemap.xml', lastmod: null },
  ]);
});

test('parses a urlset, trims whitespace and decodes entities', () => {
  const parsed = parseSitemap(urlset);
  assert.equal(parsed.kind, 'urlset');
  const locs = parsed.entries.map((e) => e.loc);
  assert.deepEqual(locs, [
    'https://x.test/a?x=1&y=2',
    'https://x.test/b',
  ]);
  assert.equal(parsed.entries[0].lastmod, '2026-01-01');
});

test('derives the sitemap type from the file name', () => {
  assert.equal(
    sitemapTypeFromUrl('https://x.test/post-sitemap.xml'),
    'post'
  );
  assert.equal(
    sitemapTypeFromUrl('https://x.test/post-sitemap2.xml'),
    'post'
  );
  assert.equal(
    sitemapTypeFromUrl('https://x.test/case-study-sitemap.xml'),
    'case-study'
  );
  assert.equal(
    sitemapTypeFromUrl('https://x.test/sitemap_index.xml'),
    'sitemap_index'
  );
});

test('sitemapTypeFromUrl handles dotted enterprise names', () => {
  const url1 = 'https://example.com/de/corporate.sitemap-doctors.xml';
  assert.equal(sitemapTypeFromUrl(url1), 'doctors');
  const url2 = 'https://example.com/de/corporate.sitemap.xml';
  assert.equal(sitemapTypeFromUrl(url2), 'corporate');
  const url3 = 'https://example.com/post-sitemap2.xml';
  assert.equal(sitemapTypeFromUrl(url3), 'post');
});

test('collectSitemaps recurses nested indexes and dedupes', async () => {
  const pages = {
    'https://example.com/root.xml':
      '<sitemapindex><sitemap>' +
      '<loc>https://example.com/a.xml</loc></sitemap>' +
      '<sitemap><loc>https://example.com/b.xml</loc>' +
      '</sitemap></sitemapindex>',
    'https://example.com/a.xml':
      '<sitemapindex><sitemap>' +
      '<loc>https://example.com/b.xml</loc></sitemap>' +
      '<sitemap><loc>https://example.com/c.xml</loc>' +
      '</sitemap></sitemapindex>',
    'https://example.com/b.xml':
      '<urlset><url><loc>https://example.com/x</loc>' +
      '</url></urlset>',
    'https://example.com/c.xml':
      '<urlset><url><loc>https://example.com/y</loc>' +
      '</url></urlset>',
  };
  const client = { text: async (url) => pages[url] };
  const found = await collectSitemaps(
    client,
    'https://example.com/root.xml'
  );
  const expected = [
    'https://example.com/b.xml',
    'https://example.com/c.xml',
  ];
  assert.deepEqual(found.sort(), expected);
});
