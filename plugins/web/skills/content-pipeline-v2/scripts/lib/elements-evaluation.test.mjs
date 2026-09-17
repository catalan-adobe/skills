import test from 'node:test';
import assert from 'node:assert/strict';
import { flags, lookAlikes, positionHabit, renderEvaluationMd } from './elements-evaluation.mjs';

const t = (id, identity, extra = {}) => ({
  id, identity, recurring: true, pages: 10, support: 0.5, instances: 10, heightRange: [100, 200],
  medianHeight: 150, variants: [{ instances: 10, pages: 10, children: ['DIV#.x'] }],
  sample: { url: 'u', selector: 's' }, ...extra,
});
const page = (url, types, height = 100) => ({
  url, sections: types.map((type) => ({ type, height })),
});

test('positionHabit: the share of instances first and last, and the height quantiles', () => {
  const pages = [page('a', ['t-1', 't-2']), page('b', ['t-1', 't-3', 't-2']), page('c', ['t-2'])];
  assert.deepEqual(positionHabit({ id: 't-1' }, pages),
    { first: 1, last: 0, instances: 2, p10: 100, p90: 100 });
  assert.equal(positionHabit({ id: 't-2' }, pages).last, 1);
  const tall = Array.from({ length: 10 }, (_, i) => ({
    url: `p${i}`, sections: [{ type: 't', height: i === 9 ? 5000 : 100 + i }],
  }));
  const h = positionHabit({ id: 't' }, tall);
  assert.deepEqual([h.p10, h.p90], [101, 5000]);
});

test('lookAlikes: one class more, attributed to the base; no class, no part', () => {
  const types = [t('t-1', 'DIV#.banner.image'), t('t-2', 'DIV#.banner'), t('t-3', 'DIV#.text'),
    t('t-4', 'SECTION#.banner.image'), t('t-5', 'DIV#.'), t('t-6', 'DIV#.banner.dark')];
  assert.deepEqual(lookAlikes(types), [['t-2', ['t-1', 't-6']]],
    'banner is the base of banner.image and banner.dark; another tag or no class does not count');
});

test('flags: height spread on quantiles, leaks without a support gate, base classes, pages',
  () => {
    const many = Array.from({ length: 6 }, (_, i) => page(`p${i}`, ['t-lead', 't-1', 't-2']));
    const pages = [...many, page('c', ['t-1']), page('d', []),
      { url: 'e', sections: [{ type: 't-1', height: 5000 }] }];
    const result = {
      types: [
        t('t-lead', 'DIV#.lead', { pages: 6, instances: 6, support: 0.3 }),
        t('t-1', 'DIV#.wide', { support: 0.3 }),
        t('t-2', 'DIV#.wide.dark',
          { screenshotError: ['x on b: gone'], support: 0.3, instances: 12 }),
        t('t-3', 'DIV#.wide.blue', { support: 0.2 }), t('t-4', 'DIV#.wide.red', { support: 0.2 }),
        t('t-u', 'DIV#.once', { recurring: false }),
      ],
      pages,
    };
    const got = flags(result);
    assert.deepEqual(got.map((f) => [f.type, f.flag]), [
      ['t-lead', 'chrome leak?'], ['t-1', 'height spread'], ['t-2', 'crop failed'],
      ['t-1', 'base class'], [undefined, 'one-section pages'], [undefined, 'empty pages'],
    ]);
    assert.match(got[4].detail, /2 pages have a single section \(t-1 ×2\)/);
    assert.match(got[5].detail, /1 pages have no section: their capture holds nothing/);
    const few = flags({ ...result, types: [t('t-lead', 'DIV#.lead', { pages: 3, instances: 3 })],
      pages: many.slice(0, 3) });
    assert.deepEqual(few, [], 'a habit on three pages is not a flag');
  });

test('renderEvaluationMd lists crops, variants and flags', () => {
  const result = {
    types: [t('t-1', 'DIV#.cards', {
      screenshots: {
        instances: ['screenshots/type-t-1-abcdef01.png'],
        variants: ['screenshots/type-t-1-vab.png'],
      },
    }), t('t-u', 'DIV#.once', { recurring: false })],
    pages: [page('u', ['t-1', 't-u'])],
    runs: [{ covered: { full: 1, partial: 0, none: 0 } }],
    compositions: [{ pages: 1 }],
    groups: [{ saturated: false }],
  };
  const md = renderEvaluationMd(result);
  assert.match(md, /### t-1 — `DIV#.cards`/);
  assert.match(md, /!\[instance 1\]\(screenshots\/type-t-1-abcdef01.png\)/);
  assert.match(md, /- v\d: 10 instances on 10 pages — children `DIV#.x`\n {2}!\[v\d\]/);
  assert.match(md, /## Unique types\n\n- t-u `DIV#.once` on u/);
  assert.match(md, /Groups: 0 of 1 saturated/);
  assert.match(md, /runs table in `elements.md`/);
});
