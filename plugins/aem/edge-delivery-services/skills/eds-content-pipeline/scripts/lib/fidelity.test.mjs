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
