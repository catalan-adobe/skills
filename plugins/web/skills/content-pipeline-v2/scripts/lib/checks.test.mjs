import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cacheRelativePath, checkCache, checkChrome, checkPrep, checkPrepVerify, checkProbe, checkReport,
  checkScan,
} from './checks.mjs';

test('checkProbe passes when the recipe parses and probe.md is non-empty', () => {
  const files = {
    'probe/browser-recipe.json': '{"engine":"chromium"}',
    'probe/probe.md': '# probe notes\n\nMain content in initial HTML: yes.',
  };
  assert.deepEqual(checkProbe(files), { pass: true, reasons: [] });
});

test('checkProbe lists every missing or broken probe artefact', () => {
  assert.deepEqual(checkProbe({}), {
    pass: false,
    reasons: [
      'missing migration/probe/browser-recipe.json',
      'missing migration/probe/probe.md',
    ],
  });
  const bad = checkProbe({
    'probe/browser-recipe.json': 'not json',
    'probe/probe.md': '   ',
  });
  assert.deepEqual(bad, {
    pass: false,
    reasons: [
      'migration/probe/browser-recipe.json is not valid JSON',
      'migration/probe/probe.md is empty',
    ],
  });
});

const manifest = (checked, overlays = []) => ({
  'prep/page-prep.json': JSON.stringify({ checked, overlays }),
});

test('checkPrep passes with >= 1 checked URL and every overlay has a selector', () => {
  const files = manifest(['https://example.com/'], [{ selector: '.cookies', hide: true }]);
  assert.deepEqual(checkPrep(files, ['prep/home.png']), { pass: true, reasons: [] });
});

test('checkPrep lists missing/invalid/empty/no-selector reasons', () => {
  assert.deepEqual(checkPrep({}, ['prep/home.png']), {
    pass: false,
    reasons: ['missing migration/prep/page-prep.json'],
  });
  assert.deepEqual(checkPrep({ 'prep/page-prep.json': 'not json' }, ['prep/home.png']), {
    pass: false,
    reasons: ['migration/prep/page-prep.json is not valid JSON'],
  });
  assert.deepEqual(checkPrep(manifest([]), ['prep/home.png']), {
    pass: false,
    reasons: [
      'migration/prep/page-prep.json has 0 checked URL(s), needs >= 1',
    ],
  });
  const bare = manifest(['https://example.com/'], [{ hide: true }]);
  const noSelector = checkPrep(bare, ['prep/h.png']);
  assert.deepEqual(noSelector, {
    pass: false,
    reasons: ['migration/prep/page-prep.json overlay 0 has no selector'],
  });
});

test('checkPrepVerify passes with >= 3 checked URLs from >= 2 first path segments', () => {
  const files = manifest([
    'https://example.com/',
    'https://example.com/blog/a',
    'https://example.com/docs/b',
  ]);
  const shots = ['prep/home.png', 'prep/a.png'];
  assert.deepEqual(checkPrepVerify(files, shots), { pass: true, reasons: [] });
});

test('checkPrepVerify lists too few checked URLs and too few path prefixes', () => {
  const two = ['prep/1.png', 'prep/2.png'];
  assert.deepEqual(checkPrepVerify(manifest(['https://example.com/']), two), {
    pass: false,
    reasons: [
      'migration/prep/page-prep.json has 1 checked URL(s), needs >= 3',
      'migration/prep/page-prep.json checked URLs cover 1 path prefix(es), needs >= 2',
    ],
  });
  const sameSegment = checkPrepVerify(manifest([
    'https://example.com/blog/a',
    'https://example.com/blog/b',
    'https://example.com/blog/c',
  ]), ['prep/1.png', 'prep/2.png']);
  assert.deepEqual(sameSegment, {
    pass: false,
    reasons: [
      'migration/prep/page-prep.json checked URLs cover 1 path prefix(es), needs >= 2',
    ],
  });
});

test('checkScan passes with a non-empty URLExtended array and urls.md present', () => {
  const files = {
    'urls/urls.json': JSON.stringify([{ url: 'https://example.com/' }]),
    'urls/urls.md': '# urls',
  };
  assert.deepEqual(checkScan(files), { pass: true, reasons: [] });
});

test('checkScan lists missing files, invalid JSON, an empty array, an entry without a url', () => {
  assert.deepEqual(checkScan({}), {
    pass: false,
    reasons: ['missing migration/urls/urls.json', 'missing migration/urls/urls.md'],
  });
  assert.deepEqual(checkScan({ 'urls/urls.json': 'not json', 'urls/urls.md': 'x' }), {
    pass: false,
    reasons: ['migration/urls/urls.json is not valid JSON'],
  });
  assert.deepEqual(checkScan({ 'urls/urls.json': '[]', 'urls/urls.md': 'x' }), {
    pass: false,
    reasons: ['migration/urls/urls.json has no URLs'],
  });
  const noUrlField = checkScan({
    'urls/urls.json': JSON.stringify([{ lang: 'en' }]),
    'urls/urls.md': 'x',
  });
  assert.deepEqual(noUrlField, {
    pass: false,
    reasons: ['migration/urls/urls.json has an entry without a "url"'],
  });
});

/** Bodies for the given URLs plus one stylesheet, as the proxy would have stored them. */
const stored = (...urls) => [
  ...urls.flatMap((u) => [cacheRelativePath(u), `${cacheRelativePath(u)}.json`]),
  'example.com_x/site.css',
];
const AB = stored('https://example.com/a', 'https://example.com/b');

const withCache = (rows, extra = {}) => ({
  'project.json': JSON.stringify({ approved: { cache: true } }),
  'urls/urls.json': JSON.stringify([
    { url: 'https://example.com/a', kind: 'page' },
    { url: 'https://example.com/b', kind: 'page' },
  ]),
  'cache/cache.md': rows,
  ...extra,
});

test('checkCache passes when every selected URL is cached, failed or skipped', () => {
  const rows = '| url | status |\n'
    + '| --- | --- |\n'
    + '| https://example.com/a | cached |\n'
    + '| https://example.com/b | skipped |\n';
  assert.deepEqual(checkCache(withCache(rows), AB), { pass: true, reasons: [] });
});

test('checkCache lists a missing cache.md, no selection, a missing row, an unstatused row', () => {
  assert.deepEqual(checkCache({}), {
    pass: false,
    reasons: [
      'missing migration/cache/cache.md',
      'cache was not approved; run status.mjs approve cache [<subset>...]',
      'migration/urls/urls.json has no URLs to select',
    ],
  });
  const noRow = checkCache(withCache('| url | status |\n| --- | --- |\n'), AB);
  assert.deepEqual(noRow, {
    pass: false,
    reasons: [
      'migration/cache/cache.md has no row for https://example.com/a',
      'migration/cache/cache.md has no row for https://example.com/b',
    ],
  });
  const noStatus = checkCache(withCache(
    '| https://example.com/a |\n| https://example.com/b | cached |\n',
  ), AB);
  assert.deepEqual(noStatus, {
    pass: false,
    reasons: [
      'migration/cache/cache.md row for https://example.com/a has no cached|failed|skipped status',
    ],
  });
});

test('checkCache reports invalid project.json JSON instead of ignoring it', () => {
  const files = {
    'project.json': 'not json',
    'cache/cache.md': 'x',
  };
  assert.deepEqual(checkCache(files, AB), {
    pass: false,
    reasons: ['migration/project.json is not valid JSON'],
  });
});

test('checkCache rejects a cacheSelection that is neither "all" nor subset names', () => {
  const files = {
    'project.json': JSON.stringify({ approved: { cache: true }, cacheSelection: 123 }),
    'cache/cache.md': 'x',
  };
  assert.deepEqual(checkCache(files, AB), {
    pass: false,
    reasons: ['project.json.cacheSelection must be "all" or subset names'],
  });
});

test('checkCache follows named subsets when project.json.cacheSelection lists them', () => {
  const files = {
    'project.json': JSON.stringify({ approved: { cache: true }, cacheSelection: ['blog'] }),
    'urls/subsets/blog.txt': 'https://example.com/blog/a\nhttps://example.com/blog/b\n',
    'urls/urls.json': JSON.stringify([{ url: 'https://example.com/blog/a', kind: 'page' }]),
    'cache/cache.md': '| https://example.com/blog/a | cached |\n'
      + '| https://example.com/blog/b | failed |\n',
  };
  const bodies = stored('https://example.com/blog/a');
  assert.deepEqual(checkCache(files, bodies), { pass: true, reasons: [] });
});

test('checkCache reports a missing named subset file', () => {
  const files = {
    'project.json': JSON.stringify({ approved: { cache: true }, cacheSelection: ['blog'] }),
    'cache/cache.md': 'x',
  };
  assert.deepEqual(checkCache(files, AB), {
    pass: false,
    reasons: ['missing migration/urls/subsets/blog.txt'],
  });
});

test('checkCache reports an empty named subset instead of passing vacuously', () => {
  const files = {
    'project.json': JSON.stringify({ approved: { cache: true }, cacheSelection: ['blog'] }),
    'urls/subsets/blog.txt': '\n   \n',
    'cache/cache.md': 'x',
  };
  assert.deepEqual(checkCache(files, AB), {
    pass: false,
    reasons: ['migration/project.json.cacheSelection resolves to no URLs'],
  });
});

test('checkCache matches the URL cell exactly, not as a substring of another row', () => {
  const files = {
    'project.json': JSON.stringify({ approved: { cache: true } }),
    'urls/urls.json': JSON.stringify([
      { url: 'https://example.com/', kind: 'page' },
      { url: 'https://example.com/a', kind: 'page' },
    ]),
    'cache/cache.md': '| https://example.com/a | cached |\n',
  };
  assert.deepEqual(checkCache(files, AB), {
    pass: false,
    reasons: ['migration/cache/cache.md has no row for https://example.com/'],
  });
});

test('checkCache requires the status cell, not just the word appearing in the URL', () => {
  const files = {
    'project.json': JSON.stringify({ approved: { cache: true } }),
    'urls/urls.json': JSON.stringify([
      { url: 'https://example.com/failed-logins', kind: 'page' },
    ]),
    'cache/cache.md': '| https://example.com/failed-logins | |\n',
  };
  assert.deepEqual(checkCache(files, AB), {
    pass: false,
    reasons: [
      'migration/cache/cache.md row for https://example.com/failed-logins '
      + 'has no cached|failed|skipped status',
    ],
  });
});

test('checkReport passes when REPORT.md has a section for every step whose files exist', () => {
  const files = {
    'REPORT.md': '## probe\n\ndone\n\n## scan\n\ndone\n\n## next\n\ncache waits\n',
    'probe/browser-recipe.json': '{}',
    'probe/probe.md': 'main content: yes',
    'urls/urls.json': '[]',
    'urls/urls.md': 'x',
  };
  assert.deepEqual(checkReport(files), { pass: true, reasons: [] });
});

test('checkReport lists a missing REPORT.md and a missing section for a ran step', () => {
  assert.deepEqual(checkReport({}), { pass: false, reasons: ['missing migration/REPORT.md'] });
  const files = {
    'REPORT.md': '## probe\n\ndone\n\n## next\n\ncache waits\n',
    'probe/browser-recipe.json': '{}',
    'probe/probe.md': 'main content: yes',
    'urls/urls.json': '[]',
    'urls/urls.md': 'x',
  };
  assert.deepEqual(checkReport(files), {
    pass: false,
    reasons: ['migration/REPORT.md has no "## scan" section'],
  });
});

test('checkReport does not demand a prep-verify section from prep artefacts alone', () => {
  const files = {
    'REPORT.md': '## prep\n\ndone\n\n## next\n\ncache waits\n',
    'prep/page-prep.json': '{}',
    'prep/prep.md': 'x',
  };
  assert.deepEqual(checkReport(files), { pass: true, reasons: [] });
});

test('checkReport does not accept a "## prep-verify" header as the "## prep" section', () => {
  const files = {
    'REPORT.md': '## prep-verify\n\ndone\n\n## next\n\ncache waits\n',
    'prep/page-prep.json': '{}',
    'prep/prep.md': 'x',
  };
  assert.deepEqual(checkReport(files), {
    pass: false,
    reasons: ['migration/REPORT.md has no "## prep" section'],
  });
});

test('checks never throw on JSON that parses to null or a scalar', () => {
  const nullRecipe = { 'probe/browser-recipe.json': 'null', 'probe/probe.md': 'main content ok' };
  assert.equal(checkProbe(nullRecipe).pass, false);
  assert.match(checkProbe({ 'probe/browser-recipe.json': '"x"', 'probe/probe.md': 'main content' })
    .reasons.join(' '), /not a JSON object/);
  const prep = checkPrep({ 'prep/page-prep.json': 'null' }, ['prep/home.png']);
  assert.equal(prep.pass, false);
  assert.match(prep.reasons.join(' '), /not a JSON object/);
  const cache = checkCache({
    'project.json': 'null', 'cache/cache.md': '| u | cached |', 'urls/urls.json': '[]',
  });
  assert.equal(cache.pass, false);
  assert.match(cache.reasons.join(' '), /not a JSON object/);
});

test('cache is not done without the recorded approval, and the status cell is exact', () => {
  const urls = JSON.stringify([{ url: 'https://example.com/a', kind: 'page' }]);
  const base = {
    'urls/urls.json': urls,
    'cache/cache.md': '| URL | status |\n| https://example.com/a | cached |',
  };
  const unapproved = checkCache({ ...base, 'project.json': '{}' });
  assert.equal(unapproved.pass, false);
  assert.match(unapproved.reasons.join(' '), /not approved; run status\.mjs approve cache/);
  const approved = { 'project.json': JSON.stringify({ approved: { cache: true } }) };
  assert.equal(checkCache({ ...base, ...approved }, stored('https://example.com/a')).pass, true);
  const loose = checkCache({
    ...base, ...approved, 'cache/cache.md': '| https://example.com/a | not cached |',
  }, stored('https://example.com/a'));
  assert.equal(loose.pass, false);
  assert.match(loose.reasons.join(' '), /no cached\|failed\|skipped status/);
});

test('report requires a prep-verify section only once prep-verify itself passed', () => {
  const onePage = JSON.stringify({ checked: ['https://example.com/'], overlays: [] });
  const files = {
    'probe/browser-recipe.json': '{}', 'probe/probe.md': 'main content: yes',
    'prep/page-prep.json': onePage, 'prep/prep.md': 'ok',
    'urls/urls.json': '[{"url":"https://example.com/"}]', 'urls/urls.md': 'ok',
    'REPORT.md': '## probe\n## prep\n## scan\n\n## next\n\ncache waits\n',
  };
  assert.equal(checkReport(files).pass, true, JSON.stringify(checkReport(files)));
  const three = JSON.stringify({
    checked: ['https://example.com/', 'https://example.com/a/1', 'https://example.com/b/2'],
    overlays: [],
  });
  const verified = checkReport({ ...files, 'prep/page-prep.json': three });
  assert.equal(verified.pass, false);
  assert.match(verified.reasons.join(' '), /"## prep-verify"/);
});

test('prep-verify counts path prefixes below the scope every URL in urls.json shares', () => {
  const urls = JSON.stringify([
    { url: 'https://x.example/en/section.html' },
    { url: 'https://x.example/en/section/diseases/asthma.html' },
    { url: 'https://x.example/en/section/clinics/one.html' },
  ]);
  const manifest = (checked) => JSON.stringify({ checked, overlays: [] });
  const scopedPass = checkPrepVerify({
    'urls/urls.json': urls,
    'prep/page-prep.json': manifest([
      'https://x.example/en/section.html',
      'https://x.example/en/section/diseases/asthma.html',
      'https://x.example/en/section/clinics/one.html',
    ]),
  }, ['prep/home.png', 'prep/a.png']);
  assert.equal(scopedPass.pass, true, JSON.stringify(scopedPass));
  const samePrefix = checkPrepVerify({
    'urls/urls.json': urls,
    'prep/page-prep.json': manifest([
      'https://x.example/en/section/diseases/a.html',
      'https://x.example/en/section/diseases/b.html',
      'https://x.example/en/section/diseases/c.html',
    ]),
  }, ['prep/home.png', 'prep/a.png']);
  assert.equal(samePrefix.pass, false);
  assert.match(samePrefix.reasons.join(' '), /cover 1 path prefix/);
});

test('checkCache accepts URL cells wrapped as <url> by a markdown autofix', () => {
  const files = withCache('| url | status |\n| --- | --- |\n'
    + '| <https://example.com/a> | cached |\n| https://example.com/b | failed |\n');
  assert.deepEqual(checkCache(files, AB), { pass: true, reasons: [] });
});

test('checkReport rejects a step section that appears twice', () => {
  const files = {
    'probe/browser-recipe.json': '{}', 'probe/probe.md': 'main content: yes',
    'REPORT.md': '## probe\n\nfirst\n\n## probe\n\nsecond\n\n## next\n\ncache waits\n',
  };
  const result = checkReport(files);
  assert.equal(result.pass, false);
  assert.deepEqual(result.reasons, ['migration/REPORT.md has 2 "## probe" sections; keep one']);
});

test('cacheRelativePath mirrors the proxy layout', () => {
  const origin = 'https://example.com';
  const dir = `example.com_${createHash('sha256').update(origin).digest('hex').slice(0, 8)}`;
  assert.equal(cacheRelativePath('https://example.com/'), `${dir}/index.html`);
  assert.equal(cacheRelativePath('https://example.com/a/b.html'), `${dir}/a/b.html`);
  assert.equal(cacheRelativePath('https://example.com/docs'), `${dir}/docs/index.html`);
  assert.equal(cacheRelativePath('https://example.com/docs/'), `${dir}/docs/index.html`);
  assert.equal(cacheRelativePath('https://example.com/p.php?x=1'), `${dir}/p!x=1.php`);
});

test('checkCache needs a stored body per cached row and at least one asset', () => {
  const files = withCache('| url | status |\n| --- | --- |\n'
    + '| https://example.com/a | cached |\n| https://example.com/b | cached |\n');
  const a = cacheRelativePath('https://example.com/a');
  const b = cacheRelativePath('https://example.com/b');
  const htmlOnly = checkCache(files, [a, `${a}.json`, b, `${b}.json`]);
  assert.equal(htmlOnly.pass, false);
  assert.match(htmlOnly.reasons.join(' '), /no CSS, JS, image or font.*warmed without a browser/);
  const missingBody = checkCache(files, [a, `${a}.json`, 'example.com_x/site.css']);
  assert.equal(missingBody.pass, false);
  assert.match(missingBody.reasons.join(' '), /no stored body for https:\/\/example\.com\/b/);
  const good = checkCache(files, [a, `${a}.json`, b, `${b}.json`, 'example.com_x/site.css']);
  assert.deepEqual(good, { pass: true, reasons: [] });
  const failedRow = withCache(
    '| https://example.com/a | failed |\n| https://example.com/b | skipped |\n',
  );
  assert.equal(checkCache(failedRow, []).pass, true, 'failed/skipped rows need no body');
});

test('report is done only once its own "## next" section exists', () => {
  const files = { 'REPORT.md': '# Migration report\n\n## setup\n\nok\n' };
  const before = checkReport(files);
  assert.equal(before.pass, false);
  assert.match(before.reasons.join(' '), /no "## next" section/);
  const withNext = { 'REPORT.md': `${files['REPORT.md']}\n## next\n\ncache pending\n` };
  assert.equal(checkReport(withNext).pass, true);
});

test('prep needs one screenshot, prep-verify two', () => {
  const one = JSON.stringify({ checked: ['https://x.example/'], overlays: [] });
  const three = JSON.stringify({
    checked: ['https://x.example/', 'https://x.example/a/1', 'https://x.example/b/2'], overlays: [],
  });
  const noShot = checkPrep({ 'prep/page-prep.json': one, 'prep/prep.md': 'ok' }, []);
  assert.equal(noShot.pass, false);
  assert.match(noShot.reasons.join(' '), /no screenshot .* migration\/prep\//);
  const onePage = { 'prep/page-prep.json': one, 'prep/prep.md': 'ok' };
  const withShot = checkPrep(onePage, ['prep/home.png']);
  assert.equal(withShot.pass, true);
  const verifyOne = checkPrepVerify({ 'prep/page-prep.json': three, 'prep/prep.md': 'ok' },
    ['prep/home.png']);
  assert.equal(verifyOne.pass, false);
  assert.match(verifyOne.reasons.join(' '), /1 screenshot.*needs >= 2/);
  assert.equal(checkPrepVerify({ 'prep/page-prep.json': three, 'prep/prep.md': 'ok' },
    ['prep/home.png', 'prep/a.png']).pass, true);
});

test('report rejects unexpanded shell variables and a "## next" that names no step', () => {
  const base = '# Migration report\n\n## setup\n\nok\n\n';
  const literal = checkReport({ 'REPORT.md': `${base}## next\n\n$STATUS_OUT\n\ncache waits\n` });
  assert.equal(literal.pass, false);
  assert.match(literal.reasons.join(' '), /unexpanded shell variable \$STATUS_OUT/);
  const vague = checkReport({ 'REPORT.md': `${base}## next\n\nAll good.\n` });
  assert.equal(vague.pass, false);
  assert.match(vague.reasons.join(' '), /"## next" names no step/);
  const good = checkReport({ 'REPORT.md': `${base}## next\n\ncache waits for approval.\n` });
  assert.deepEqual(good, { pass: true, reasons: [] });
});

test('probe.md must say whether the main content is in the initial HTML', () => {
  const files = { 'probe/browser-recipe.json': '{}', 'probe/probe.md': 'default config works' };
  const silent = checkProbe(files);
  assert.equal(silent.pass, false);
  assert.match(silent.reasons.join(' '), /main content/);
  const note = 'Main content in initial HTML: no (JS-rendered).';
  const said = checkProbe({ ...files, 'probe/probe.md': note });
  assert.equal(said.pass, true);
});

test('checkReport rejects a "## " heading that is no section', () => {
  const files = {
    'REPORT.md': '## probe\n\ndone\n\n## next\n\n## Struggles\n\ncache done\n',
    'probe/browser-recipe.json': '{}',
    'probe/probe.md': 'main content: yes',
  };
  const { pass, reasons } = checkReport(files);
  assert.equal(pass, false);
  assert.match(reasons.join('\n'), /"## Struggles" heading that is no section; use "### "/);
  const ok = {
    ...files, 'REPORT.md': '## probe\n\ndone\n\n## next\n\n### Struggles\n\ncache done\n',
  };
  assert.deepEqual(checkReport(ok), { pass: true, reasons: [] });
});

test('checkChrome: variants, selectors against captures, screenshots, defects', () => {
  const variant = (id, members, rep = 'https://x.example/') => ({
    id, representative: rep, members: members.map((s) => ({ selector: s })),
    screenshots: {
      full: `screenshots/header-${id}.png`,
      members: members.map((s, i) => (
        { selector: s, file: `screenshots/header-${id}-m${i + 1}.png` })),
    },
  });
  const chrome = {
    capturedPages: 9, header: [variant('1', ['#u', 'div.nav'])], footer: [variant('1', ['div.f'])],
  };
  const files = { 'chrome/chrome.json': JSON.stringify(chrome), 'chrome/chrome.md': '# Chrome' };
  const shots = [
    'screenshots/header-1.png', 'screenshots/header-1-m1.png', 'screenshots/header-1-m2.png',
  ];
  const selectors = { 'https://x.example/': new Set(['#u', 'div.nav', 'div.f']) };
  assert.deepEqual(checkChrome(files, { screenshots: shots, selectors }),
    { pass: true, reasons: [] });

  const noFooter = checkChrome(
    { ...files, 'chrome/chrome.json': JSON.stringify({ ...chrome, footer: [] }) },
    { screenshots: shots, selectors },
  );
  assert.match(noFooter.reasons.join('\n'), /no footer recurs on enough pages/);

  const badSel = checkChrome(files,
    { screenshots: shots, selectors: { 'https://x.example/': new Set(['#u']) } });
  assert.match(badSel.reasons.join('\n'),
    /header 1: div\.nav is not in the capture of https:\/\/x\.example\//);

  const missingShot = checkChrome(files, { screenshots: shots.slice(0, 2), selectors });
  assert.match(missingShot.reasons.join('\n'), /header 1: missing screenshots\/header-1-m2\.png/);

  const defect = {
    ...chrome, header: [{ ...chrome.header[0], screenshotError: ['x resolves to nothing'] }],
  };
  const withDefect = checkChrome({ ...files, 'chrome/chrome.json': JSON.stringify(defect) },
    { screenshots: shots, selectors });
  assert.match(withDefect.reasons.join('\n'), /header 1: x resolves to nothing/);

  assert.match(checkChrome({}).reasons[0], /missing migration\/chrome\/chrome\.json/);
  assert.match(checkChrome({ 'chrome/chrome.json': '{' }).reasons[0], /not valid JSON/);
});
