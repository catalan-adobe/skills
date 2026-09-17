import test from 'node:test';
import assert from 'node:assert/strict';
import { flags, lookAlikes, positionHabit, renderEvaluationMd } from './elements-evaluation.mjs';

const t = (id, identity, extra = {}) => ({
  id, identity, recurring: true, pages: 10, support: 0.5, instances: 10, heightRange: [100, 200],
  medianHeight: 150, variants: [{ instances: 10, pages: 10, children: ['DIV#.x'] }],
  sample: { url: 'u', selector: 's' }, ...extra,
});
const page = (url, types) => ({ url, sections: types.map((type) => ({ type })) });

test('positionHabit: the share of instances that open or close their page', () => {
  const pages = [page('a', ['t-1', 't-2']), page('b', ['t-1', 't-3', 't-2']), page('c', ['t-2'])];
  assert.deepEqual(positionHabit({ id: 't-1' }, pages), { first: 1, last: 0, instances: 2 });
  assert.deepEqual(positionHabit({ id: 't-2' }, pages), { first: 1 / 3, last: 1, instances: 3 });
});

test('lookAlikes: identities one class apart', () => {
  const types = [t('t-1', 'DIV#.banner.image'), t('t-2', 'DIV#.banner'), t('t-3', 'DIV#.text'),
    t('t-4', 'SECTION#.banner.image')];
  assert.deepEqual(lookAlikes(types), [['t-1', ['t-2']]], 'a different tag is not a look-alike');
  assert.deepEqual(lookAlikes([...types, t('t-5', 'DIV#.banner.image.dark')]),
    [['t-1', ['t-2', 't-5']]], 'one line per type');
});

test('flags: height spread, chrome leak, look-alike, crop failure, one-section and empty pages',
  () => {
    const pages = [page('a', ['t-lead', 't-1']), page('b', ['t-lead', 't-2']), page('c', ['t-1']),
      page('d', [])];
    const result = {
      types: [
        t('t-lead', 'DIV#.lead', { pages: 2, instances: 2, support: 0.5 }),
        t('t-1', 'DIV#.wide', { heightRange: [50, 900], support: 0.3 }),
        t('t-2', 'DIV#.wide.dark', { screenshotError: ['x on b: gone'], support: 0.3 }),
        t('t-u', 'DIV#.once', { recurring: false, heightRange: [1, 5000] }),
      ],
      pages,
    };
    assert.deepEqual(flags(result).map((f) => [f.type, f.flag]), [
      ['t-lead', 'chrome leak?'], ['t-1', 'height spread'], ['t-2', 'crop failed'],
      ['t-1', 'look-alike'], [undefined, 'one-section pages'], [undefined, 'empty pages'],
    ]);
  });

test('renderEvaluationMd lists crops, variants and flags', () => {
  const result = {
    types: [t('t-1', 'DIV#.cards', {
      screenshots: {
        instances: ['screenshots/type-t-1-1.png'], variants: [`screenshots/type-t-1-v${1}.png`],
      },
    }), t('t-u', 'DIV#.once', { recurring: false })],
    pages: [page('u', ['t-1', 't-u'])],
    runs: [{ covered: { full: 1, partial: 0, none: 0 } }],
    compositions: [{ pages: 1 }],
    groups: [{ saturated: false }],
  };
  const md = renderEvaluationMd(result);
  assert.match(md, /### t-1 — `DIV#.cards`/);
  assert.match(md, /!\[instance 1\]\(screenshots\/type-t-1-1.png\)/);
  assert.match(md, /- v\d: 10 instances on 10 pages — children `DIV#.x`\n {2}!\[v\d\]/);
  assert.match(md, /## Unique types\n\n- t-u `DIV#.once` on u/);
  assert.match(md, /Groups: 0 of 1 saturated/);
});
