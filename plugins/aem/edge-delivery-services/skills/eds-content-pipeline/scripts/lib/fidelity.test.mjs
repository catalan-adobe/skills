import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { contentSet, compare, checkBlockShape } from './fidelity.mjs';

const execFileP = promisify(execFile);
const fidelityCli = fileURLToPath(new URL('./fidelity.mjs', import.meta.url));

const SRC = '<main><h1>Alpha Grinder</h1><p class="price">€ 89</p><nav>Home › Alpha</nav>'
  + '<table><tr><th>Weight</th><td>1.2 kg</td></tr></table><img src="/img/alpha.jpg">'
  + '<a href="/about.html">About us</a></main>';
const OUT = '<main><div><h1>Alpha Grinder</h1><p>€ 89</p><img src="/img/alpha.jpg"></div>'
  + '<div><div class="specifications"><div><div>Weight</div><div>1.2 kg</div></div></div>'
  + '<div class="section-metadata"><div><div>Style</div><div>dark</div></div></div>'
  + '<div class="metadata"><div><div>title</div><div>Alpha Grinder | Shop</div></div>'
  + '<div><div>image</div><div><img src="/og/alpha-social.jpg"></div></div></div>'
  + '</div></main>';

test('contentSet tokenises text at element boundaries plus images and links', () => {
  const s = contentSet(SRC, 'main');
  assert.ok(s.has('alpha grinder') && s.has('weight') && s.has('1.2 kg'));
  assert.ok(s.has('img:alpha.jpg') && s.has('link:/about.html'));
  assert.ok(!s.has('›'));
});

test('contentSet drops elements the template declares not migrated', () => {
  const s = contentSet(SRC, 'main', ['nav']);
  assert.ok(!s.has('home › alpha') && s.has('alpha grinder'));
});

test('compare reports recall/precision and the diffs', () => {
  const r = compare(contentSet(SRC, 'main'), contentSet(OUT, 'main'));
  assert.ok(r.recall > 0.6 && r.recall < 1);
  assert.equal(r.precision, 1);
  assert.ok(r.missing.includes('about us'));
  assert.deepEqual(r.invented, [], 'metadata and section-metadata rows are not content');
});

test('checkBlockShape validates column counts against the model', () => {
  const blocks = [
    { name: 'specifications', model: { columns: [{}, {}] } },
    { name: 'ghost', model: { columns: [{}] } },
  ];
  const res = checkBlockShape(OUT, blocks);
  assert.deepEqual(
    res.find((b) => b.name === 'specifications'),
    { name: 'specifications', ok: true, reason: '' },
  );
  assert.equal(res.find((b) => b.name === 'ghost').ok, false);
});

test('checkBlockShape with a template checks only that template\'s blocks', () => {
  const blocks = [
    { name: 'specifications', model: { columns: [{}, {}] }, templates: { product: 1 } },
    { name: 'ghost', model: { columns: [{}] }, templates: { article: 1 } },
  ];
  const res = checkBlockShape(OUT, blocks, { template: 'product' });
  assert.deepEqual(res.map((b) => b.name), ['specifications']);
  assert.equal(res[0].ok, true);
});

test('CLI with no arguments exits 1 and shows usage', async () => {
  const result = await execFileP(process.execPath, [fidelityCli], {})
    .catch((e) => e);
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /Usage: fidelity\.mjs <source\.html> <out\.html>/,
  );
});

test('contentSet reads lazy images by data-src and compares links by path', () => {
  const lazy = '<main><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" '
    + 'data-src="/media/spec-sheet.png?v=3" alt=""></main>';
  assert.deepEqual([...contentSet(lazy)], ['img:spec-sheet.png']);
  const eager = '<main><img src="/img/alpha.jpg"></main>';
  assert.deepEqual([...contentSet(eager)], ['img:alpha.jpg']);
  const absolute = contentSet('<main><a href="https://www.example.com/en/x.html?q=1">Read more</a>'
    + '<a href="//cdn.other.net/file.pdf">Download</a><a href="#top">Top</a>'
    + '<a href="mailto:a@b.c">Mail</a><a href="tel:+41">Call</a></main>');
  const relative = contentSet('<main><a href="/en/x.html?q=1">Read more</a>'
    + '<a href="//cdn.other.net/file.pdf">Download</a><a href="#top">Top</a>'
    + '<a href="mailto:a@b.c">Mail</a><a href="tel:+41">Call</a></main>');
  assert.deepEqual(compare(absolute, relative), {
    recall: 1, precision: 1, missing: [], invented: [],
  });
  assert.ok(absolute.has('link:/en/x.html?q=1'));
  assert.ok(absolute.has('link:/file.pdf'), 'protocol-relative links compare by path too');
  assert.ok(!absolute.has('link:#top') && !absolute.has('link:mailto:a@b.c'));
});

test('contentSet counts title-attribute text as content an output may carry as prose', () => {
  const source = contentSet('<main><p>See the <span class="tip" title="A long definition">'
    + 'term</span> here.</p></main>');
  const asGlossary = contentSet('<main><p>See the <span>term</span> here.</p>'
    + '<div class="glossary"><div><div>term</div><div>A long definition</div></div></div></main>');
  const dropped = contentSet('<main><p>See the <span>term</span> here.</p></main>');
  assert.ok(source.has('a long definition'));
  assert.equal(compare(source, asGlossary).precision, 1, 'preserving the tooltip is not invented');
  assert.ok(compare(source, dropped).recall < 1, 'dropping the tooltip is lost content');
  const linkTitle = contentSet('<main><a href="/x" title="Opens x">go</a>'
    + '<img src="/i.png" title="decorative"></main>');
  assert.ok(!linkTitle.has('opens x') && !linkTitle.has('decorative'), 'a/img titles are chrome');
});
