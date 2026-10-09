import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { write as writeComposition } from './composition.mjs';
import { init } from './migration.mjs';
import { add as addNote } from './notes.mjs';
import { pageId, upsert } from './pages.mjs';
import { esc, markdown, renderHtml } from './report-html.mjs';
import { finish, start } from './runs.mjs';
import { create as createSelection } from './selections.mjs';
import { write as writeState } from './state.mjs';
import { writeReport } from './views.mjs';
import { refresh, writeFragments } from './website.mjs';

const ORIGIN = 'https://a.example/';
const AT = '2026-09-22T10:00:00.000Z';

test('markdown subset and escaping', () => {
  assert.equal(esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  const html = markdown('# T\n\nSome `code` and **bold** at https://x.example/p\n\n- one\n- two\n\n'
    + '| a | b |\n|---|---|\n| 1 | `2` |\n');
  assert.match(html, /<h1>T<\/h1>/);
  assert.match(html, /<code>code<\/code> and <b>bold<\/b> at <a href="https:\/\/x.example\/p">/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<th>a<\/th><th>b<\/th>.*<td>1<\/td><td><code>2<\/code><\/td>/s);
  assert.equal(markdown('<script>x</script>').includes('<script>'), false);
});

test('the HTML report shows every unit, says what is absent, opens from disk', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mdata-html-'));
  await init(cwd, { origin: ORIGIN });
  let html = await renderHtml(cwd);
  assert.match(html, /<h1>https:\/\/a.example\/<\/h1>/);
  assert.match(html, /No pages discovered yet/);
  assert.match(html, /None found yet: the chrome step has not run/);
  assert.match(html, /No decomposition yet/);
  await upsert(cwd, [
    { url: `${ORIGIN}`, discovered: { from: 'sitemap', source: 's.xml', at: AT }, kind: 'page',
      http: { status: 200, contentType: 'text/html', bytes: 9 },
      cache: { at: AT, path: 'a/index.html', selection: 'all' } },
    { url: `${ORIGIN}old`, discovered: { from: 'sitemap', source: 's.xml', at: AT },
      kind: 'redirect', redirect: { status: 301, target: `${ORIGIN}` },
      http: { status: 301, contentType: null, bytes: 0 } },
    { url: `${ORIGIN}blogs/x`, discovered: { from: 'crawl', at: AT } },
  ]);
  await createSelection(cwd, 'all', [pageId(`${ORIGIN}`)], { criteria: { count: 1 } });
  const header = await writeFragments(cwd, { method: { name: 'visual-tree', at: AT },
    fragments: [{ placement: 'template', part: 'header', selectors: ['#u', '#nav'],
      optional: ['.promo'], pages: 1, evidence: ['fragments/frg-x/shots/page.png'] }],
    rejected: [{ selector: '.crumb', reason: 'breadcrumb' }] });
  await writeComposition(cwd, pageId(`${ORIGIN}`), { method: { name: 'visual-tree', at: AT },
    fragments: [{ ref: header.fragments[0].id, selector: '#u' }], sections: [], omitted: [] });
  await refresh(cwd);
  const run = await start(cwd, 'cache', { selection: 'all' });
  await finish(cwd, run.id, { state: 'failed', error: 'the proxy died', summary: 'see error' });
  await addNote(cwd, { step: 'cache', author: 'operator', body: '# Why\n\n- because `x`\n' });
  await writeState(cwd, { discover: async () => ({ pass: true }) });
  html = await renderHtml(cwd, { now: new Date(AT) });
  assert.match(html, /<td>discover<\/td><td><span class="tag ok">done<\/span>/);
  assert.match(html, /<b>3<\/b><span>URLs known<\/span>/);
  assert.match(html, /<td>all<\/td><td class="num">1<\/td><td><code>\{&quot;count&quot;:1\}/);
  assert.match(html, /<span class="tag ">redirect<\/span> 1/);
  assert.match(html, /redirect \(cache: https:\/\/a.example\/\)/, 'the reason, by whom, detail');
  assert.match(html, /<a href="https:\/\/a.example\/old">\/old<\/a>/, 'the URL linked');
  assert.match(html, /<th>shot<\/th>/);
  assert.match(html, /<h2 id="bodies">Bodies<\/h2>\n<p>No body crops yet/);
  assert.equal((html.match(/shots\/page.jpg/g) ?? []).length, 0, 'no screenshot taken yet');
  assert.match(html, /<h3>header <span class="tag ">template<\/span>/);
  assert.match(html, /<img src="\.\.\/fragments\/frg-x\/shots\/page.png"/, 'relative to views/');
  assert.match(html, /Optional: <code class="sel">\.promo<\/code>/);
  assert.match(html, /<summary>1 candidates not taken<\/summary>/);
  assert.match(html, /<span class="tag bad">failed<\/span>.*the proxy died/s);
  assert.match(html, /<div class="note">.*operator.*<h1>Why<\/h1>.*<li>because <code>x<\/code>/s);
  assert.equal(/<script/i.test(html), false);
  const entry = await writeReport(cwd, { html: true });
  assert.equal(entry.file, 'views/report.html');
  const onDisk = await readFile(path.join(cwd, 'migration', entry.file), 'utf8');
  const sansFooter = (t) => t.replace(/<footer>.*<\/footer>/s, '');
  assert.equal(sansFooter(onDisk), sansFooter(html));
  const md = await writeReport(cwd);
  assert.equal(md.file, 'views/report.md');
});
