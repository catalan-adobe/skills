import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates } from './chrome-candidates.mjs';
import { chosenPart, detectChrome, place, rejectionReason } from './chrome-detect.mjs';

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
        ? el('DIV', 'experiencefragment', box(53, 80),
          [el('DIV', 'blog-nav', box(53, 80)), el('DIV', 'blog-search', box(53, 80))])
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

test('a fixed layer taller than a band is a curtain, not chrome', () => {
  const curtain = { tags: ['DIV'], bounds: { y: 0, height: 720, width: 1280, bottomOffset: 2000 },
    sample: { selector: 'div.gnav-curtain', node: { className: 'gnav-curtain', fixed: true },
      text: '' } };
  assert.match(rejectionReason(curtain, [], 3000), /fixed layer 720 px tall/);
  const sticky = { ...curtain, bounds: { ...curtain.bounds, height: 65 } };
  assert.equal(rejectionReason(sticky, [], 3000), null, 'a sticky header is a band');
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
  assert.equal(out.header.length, 1, 'one header element; the blog pages a structural variant');
  const [main] = out.header;
  assert.deepEqual([main.pages.length, main.support, main.group], [9, 0.9, 'p']);
  assert.deepEqual(main.members.map((m) => [m.selector, m.variants]).sort(),
    [['div.experiencefragment', 2], ['div.utility', 1]]);
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

test('the generic rules: narrow goes unplaced, tall is content, changing text is template', () => {
  // Ten pages: a full-width header, a narrow side nav at a stable place, a title band
  // under the header whose text differs per page, a main area covering most of the page.
  const pages = Array.from({ length: 10 }, (_, i) => {
    const n = i + 1;
    const height = 3000 + n * 50;
    return {
      url: `https://site.example/docs/${n}.html`,
      tree: el('BODY', 'page', box(0, height), [
        el('HEADER', 'top', box(0, 80),
          [el('NAV', 'nav', box(0, 80), [], { text: 'Home Docs Blog' })]),
        el('DIV', 'title', box(80, 120), [], { text: `Page number ${n} of the docs` }),
        el('ASIDE', 'side', box(200, 900, 240), [], { text: 'Intro Setup Usage FAQ' }),
        el('MAIN', 'content', box(200, height - 800, 1000, 280), [], { text: `Body ${n}` }),
        el('FOOTER', 'bottom', box(height - 600, 600), [], { text: 'Legal Privacy Contact' }),
      ]),
    };
  });
  const all = candidates(pages, { groupOf: () => 'docs' });
  const out = detectChrome(all, {
    pages: pages.map((p) => p.url), pageHeights: pages.map((p) => p.tree.bounds.height),
  });
  assert.deepEqual(out.header.map((v) => v.members.map((m) => m.selector)), [['header.top']],
    'the title band under the header is not absorbed: its text changes with the page');
  assert.deepEqual(out.footer.map((v) => v.members.map((m) => m.selector)), [['footer.bottom']]);
  assert.ok(out.unplaced.some((m) => m.selector === 'aside.side'), 'narrow: another part');
  const title = out.rejected.find((r) => r.selector === 'div.title');
  assert.match(title.reason, /text differs across pages/);
  const main = out.rejected.find((r) => r.selector === 'main.content');
  assert.match(main.reason, /text differs|covers \d+ % of the page/);
});

test('text stability is judged within groups; small groups are pooled', async () => {
  const { textStabilityOf } = await import('./chrome-candidates.mjs');
  const occ = (url, text) => ({ url, text });
  const locales = [...Array.from({ length: 5 }, (_, i) => occ(`/en/${i}`, 'home docs')),
    ...Array.from({ length: 5 }, (_, i) => occ(`/fr/${i}`, 'accueil docs'))];
  const byLocale = (u) => u.split('/')[1];
  assert.equal(textStabilityOf(locales, byLocale), 1, 'one header, two languages');
  assert.equal(textStabilityOf(locales, () => ''), 0.5, 'the same, judged site-wide');
  const titles = Array.from({ length: 6 }, (_, i) => occ(`/g${i}/p`, `title ${i}`));
  assert.ok(textStabilityOf(titles, byLocale) < 0.2, 'six groups of one: pooled, not stable');
  const silent = [...titles, ...Array.from({ length: 6 }, (_, i) => occ(`/s${i}/p`, ''))];
  assert.ok(textStabilityOf(silent, byLocale) < 0.2, 'empty text is no evidence of stability');
  assert.equal(textStabilityOf(silent.filter((o) => !o.text), byLocale), 1, 'no text at all');
});

test('a choice of one part at two DOM positions: two variants, every page carrying one',
  () => {
    const pages = ['a', 'b', 'c', 'd', 'e'];
    const cand = (key, on) => ({ key, anchored: 'top', fp: key, sample: { selector: `#${key}`,
      url: on[0], text: key }, selectors: [`#${key}`], tags: ['DIV'],
      bounds: { y: 0, height: 30 }, support: on.length / pages.length, pages: on });
    const part = chosenPart([cand('lang1', ['a', 'b', 'c']), cand('menu1', ['a', 'b', 'c']),
      cand('lang2', ['d']), cand('menu2', ['d']), cand('promo', ['a'])], pages, () => null);
    assert.deepEqual(part.variants.map((v) => [v.id, v.pages, v.members.map((m) => m.selector),
      v.optional.map((m) => m.selector)]), [
      ['1', ['a', 'b', 'c'], ['#lang1', '#menu1'], ['#promo']],
      ['2', ['d'], ['#lang2', '#menu2'], []],
    ]);
    assert.deepEqual(part.without, ['e']);
  });
