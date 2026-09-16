import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates } from './chrome.mjs';
import { detectChrome, place, rejectionReason } from './chrome-regions.mjs';

const box = (y, height, width = 1280, x = 0) => ({ x, y, width, height });
const el = (tag, className, bounds, children = [], extra = {}) => ({
  tag, className, selector: `${tag.toLowerCase()}.${className.split(' ')[0]}`, bounds,
  children, ...extra,
});

// Ten pages: 7 main, 2 with the blog header (same slot, other structure), 1 landing page
// without any chrome. A CTA band sits above the footer on 5 pages; a breadcrumb on 6.
function site() {
  const pages = [];
  for (let n = 1; n <= 10; n += 1) {
    const height = 3000 + n * 131;
    const children = [];
    const landing = n === 10;
    const blog = n === 8 || n === 9;
    if (!landing) {
      children.push(el('DIV', 'utility', box(0, 53), [], { id: 'utility-nav-bar' }));
      children.push(blog
        ? el('DIV', 'experiencefragment', box(53, 80), [el('DIV', 'blog-nav', box(53, 80))])
        : el('DIV', 'experiencefragment', box(53, 80), [el('DIV', 'main-nav', box(53, 80))]));
    }
    if (n <= 6) children.push(el('DIV', 'breadcrumb', box(133, 41)));
    children.push(el('DIV', 'content', box(200 + n * 70, 900)));
    if (!landing && n <= 5) children.push(el('DIV', 'cta banner', box(height - 900, 300)));
    if (!landing) {
      children.push(el('DIV', 'experiencefragment', box(height - 600, 600), [
        el('DIV', 'siteFooter row', box(height - 600, 500), [], { id: `xf-${n}abcdef` }),
      ]));
    }
    pages.push({
      url: `https://site.example/${blog ? 'blog' : landing ? 'campaign' : 'p'}/${n}.html`,
      tree: el('BODY', 'page', box(0, height), children),
    });
  }
  return pages;
}

const groupOf = (url) => new URL(url).pathname.split('/')[1];

test('place puts top-anchored candidates in the header band and bottom ones in the footer', () => {
  const top = { anchored: 'top', bounds: { y: 53, bottomOffset: 3000 } };
  const bottom = { anchored: 'bottom', bounds: { y: 3000, bottomOffset: 0 } };
  const middle = { anchored: 'top', bounds: { y: 900, bottomOffset: 2000 } };
  assert.equal(place(top, 3500), 'header');
  assert.equal(place(bottom, 3500), 'footer');
  assert.equal(place(middle, 3500), 'unplaced');
});

test('rejectionReason names skip links, breadcrumbs and consent overlays', () => {
  const c = (tag, className, extra = {}) => ({
    tags: [tag],
    sample: { selector: `${tag}.${className}`, node: { className, ...extra }, text: '' },
  });
  assert.equal(rejectionReason(c('A', 'skip-link')), 'skip link');
  assert.match(rejectionReason(c('DIV', 'breadcrumb')), /breadcrumb/);
  assert.match(rejectionReason(c('DIV', 'x', { id: 'onetrust' }), ['#onetrust']), /consent/);
  assert.equal(rejectionReason(c('DIV', 'nav')), null);
});

test('detectChrome: variants from core members, slot alternatives, optional CTA', () => {
  const pages = site();
  const out = detectChrome(candidates(pages), {
    pages: pages.map((p) => p.url), pageHeights: pages.map((p) => p.tree.bounds.height), groupOf,
  });
  assert.equal(out.capturedPages, 10);
  assert.equal(out.header.length, 2, 'main header and blog header');
  const [main, blog] = out.header;
  assert.deepEqual([main.pages.length, main.support, main.group], [7, 0.7, 'p']);
  assert.deepEqual(main.members.map((m) => m.selector).sort(),
    ['div.experiencefragment', 'div.utility']);
  assert.deepEqual([blog.pages.length, blog.group], [2, 'blog']);
  assert.equal(blog.members.length, 2, 'the blog header keeps the shared utility bar');
  assert.equal(main.representative, 'https://site.example/p/1.html');

  assert.equal(out.footer.length, 1);
  const [footer] = out.footer;
  assert.equal(footer.pages.length, 9);
  assert.deepEqual(footer.members.map((m) => m.selector), ['div.experiencefragment'],
    'the outermost element is the member; its inner row is not a second member');
  assert.deepEqual(footer.optional.map((m) => [m.selector, m.onPages]), [['div.cta', 5]],
    'the CTA band is optional, not a second footer variant');
  assert.equal(footer.group, 'p', '7 of 9 footer pages are group p');

  assert.deepEqual(out.without, {
    header: ['https://site.example/campaign/10.html'],
    footer: ['https://site.example/campaign/10.html'],
  });
  const breadcrumb = out.rejected.find((r) => r.selector === 'div.breadcrumb');
  assert.match(breadcrumb.reason, /breadcrumb/);
  assert.deepEqual(out.unplaced, []);
  assert.ok(out.limits.length >= 1);
});

test('detectChrome with no recurring chrome reports every page as without', () => {
  const pages = [1, 2, 3].map((n) => ({
    url: `https://site.example/${n}`,
    tree: el('BODY', 'page', box(0, 2000), [el('DIV', 'content', box(100 * n, 900))]),
  }));
  const out = detectChrome(candidates(pages), {
    pages: pages.map((p) => p.url), pageHeights: [2000, 2000, 2000],
  });
  assert.deepEqual([out.header, out.footer], [[], []]);
  assert.equal(out.without.header.length, 3);
});
