import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { data } from './data.mjs';
import { ask } from './system1.mjs';
import {
  QUESTIONS, asked, bucketOf, check, flag, opinions, pending, slices, workerMain,
} from './triage.mjs';

const O = 'https://site.example/';
const AT = '2026-09-22T10:00:00.000Z';

/** A stand-in for sharp: a chain remembering the geometry, producing bytes of a size. */
function fakeSharp(height, { bytesPerSlice = 1000 } = {}) {
  const calls = [];
  const sharp = () => {
    const op = { resize: null, extract: null, quality: null };
    const chain = {
      metadata: async () => ({ width: 1280, height }),
      resize: (w, h) => { op.resize = [w, h]; return chain; },
      extract: (box) => { op.extract = box; return chain; },
      jpeg: ({ quality }) => { op.quality = quality; return chain; },
      toBuffer: async () => { calls.push(op); return Buffer.alloc(bytesPerSlice, 1); },
    };
    return chain;
  };
  sharp.calls = calls;
  return sharp;
}

async function project(pages) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'mpipe-triage-'));
  const { migration, pages: table, trees, website } = await data(cwd);
  await migration.init(cwd, { origin: O });
  await table.upsert(cwd, pages.map(({ path: p }) => ({ url: `${O}${p}`, kind: 'page',
    discovered: { from: 'list', at: AT }, cache: { at: AT, path: 'x', selection: 's' } })));
  await website.writeAccess(cwd, { browser: { engine: 'chromium' }, overlays: [], verifiedOn: [] });
  for (const { path: p, shot = true, height = 2000 } of pages) {
    const id = table.pageId(`${O}${p}`);
    const tree = { tag: 'BODY', bounds: { x: 0, y: 0, width: 1280, height }, children: [] };
    await trees.write(cwd, id, { minWidth: 250, url: `${O}${p}`, capturedAt: AT, tree,
      text: '', nodeMap: {}, page: { scrollHeight: height,
        shot: shot ? trees.shotFile(id) : null } });
    if (shot) {
      const file = path.join(cwd, 'migration', trees.shotFile(id));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `jpeg-of-${p}`);
    }
  }
  return cwd;
}

test('the questions are three and frozen; slices follow the height and the budget', async () => {
  assert.deepEqual(Object.keys(QUESTIONS), ['header', 'footer', 'broken', 'empty']);
  assert.match(asked().header, /site header at the very top.*cut into slices/s);
  const short = fakeSharp(2000);
  const a = await slices(short, '/s.jpg');
  assert.deepEqual([a.images.length, a.quality, a.scale], [3, 80, 1], '2000 px: three slices, 1:1');
  assert.deepEqual(short.calls.map((c) => c.extract.height), [768, 768, 464]);
  assert.deepEqual(short.calls[0].resize, [1280, 2000]);
  const tall = fakeSharp(6144);
  const b = await slices(tall, '/t.jpg');
  assert.deepEqual([b.images.length, b.scale], [4, 0.5], 'twice four slices: scaled by half');
  assert.deepEqual(tall.calls[0].resize, [640, 3072]);
  const heavy = fakeSharp(1000, { bytesPerSlice: 200000 });
  const c = await slices(heavy, '/h.jpg', { budget: 300000 });
  assert.equal(c.quality, 20, 'quality lowered to the floor when the body would be refused');
  assert.match(a.images[0], /^data:image\/jpeg;base64,/);
});

test('ask: one request, probabilities back, retries, errors named', async () => {
  const seen = [];
  const reply = (status, body, headers = {}) => ({
    status, ok: status < 300, headers: { get: (k) => headers[k] ?? null },
    json: async () => body, text: async () => JSON.stringify(body),
  });
  const replies = [reply(429, {}, { 'retry-after': '0' }),
    reply(200, { result: { model: 'clef', answers: { header: { noul: 0.9 }, footer: { noul: 0.1 },
      broken: { noul: 0.05 }, empty: { noul: 0.01 } }, usage: { input_tokens: 3000 } } })];
  const fetchImpl = async (url, init) => {
    seen.push([url, JSON.parse(init.body)]);
    return replies.shift();
  };
  const dep = { url: 'https://s1.example/run', model: 'clef', key: 'k' };
  const out = await ask(dep, ['data:image/jpeg;base64,AA'], asked(),
    { fetchImpl, sleep: async () => {} });
  assert.deepEqual(out.answers, { header: 0.9, footer: 0.1, broken: 0.05, empty: 0.01 });
  assert.equal(out.usage.inputTokens, 3000);
  assert.equal(seen.length, 2, 'retried once');
  assert.deepEqual(Object.keys(seen[1][1].questions), ['header', 'footer', 'broken', 'empty']);
  assert.equal(seen[1][1].questions.header.type, 'noul');
  assert.equal(seen[1][1].model, 'clef');
  await assert.rejects(ask(dep, [], {}, { fetchImpl: async () => reply(401, 'no') }),
    /System 1 401/);
  await assert.rejects(ask(dep, [], { x: 'q' }, { fetchImpl: async () => reply(200,
    { answers: {} }) }), /no probability for x/);
  await assert.rejects(ask(dep, [1, 2, 3, 4, 5], {}), /at most 4 images/);
});

test('the worker: every screenshot looked at once, flags beside chrome\'s, buckets', async () => {
  const cwd = await project([{ path: 'a' }, { path: 'b' }, { path: 'c' }, { path: 'd' },
    { path: 'e' }, { path: 'no-shot', shot: false }]);
  const { pages, triage, notes, runs } = await data(cwd);
  const id = (p) => pages.pageId(`${O}${p}`);
  // chrome's structural opinion: c has no footer, d has no header.
  await pages.setReasons(cwd, 'chrome', { [id('c')]: [{ code: 'no-footer', kind: 'flag' }],
    [id('d')]: [{ code: 'no-header', kind: 'flag' }] });
  assert.equal((await pending(cwd)).length, 5, 'the page without a screenshot is not looked at');
  assert.match((await check(cwd)).note, /5 page\(s\) to look at/);
  const answersFor = { a: [0.95, 0.9, 0.02, 0.1], b: [0.9, 0.9, 0.8, 0.1], c: [0.9, 0.2, 0.1, 0.1],
    d: [0.9, 0.9, 0.05, 0.1], e: [0.95, 0.95, 0.1, 0.85] };
  const askedFor = [];
  const io = {
    model: 'clef', sharp: fakeSharp(2000), now: () => new Date(AT),
    ask: async (images, questions) => {
      askedFor.push(images.length);
      const current = (await runs.newest(cwd, 'triage')).current;
      const p = Object.keys(answersFor).find((k) => id(k) === current);
      const [header, footer, broken, empty] = answersFor[p];
      return { answers: { header, footer, broken, empty }, usage: { inputTokens: 3000, ms: 10 } };
    },
  };
  const out = await workerMain(cwd, { io });
  assert.deepEqual(askedFor, [3, 3, 3, 3, 3]);
  assert.match(out.summary, /^5 page\(s\) looked at \(0 failed, 15000 input tokens\); of all/);
  assert.match(out.summary, /of all triaged: 1 normal, 1 odd, 1 review, 1 broken, 1 empty\./);
  const t = await triage.read(cwd, id('a'));
  assert.deepEqual([t.method.model, t.answers, t.images.slices],
    ['clef', { header: 0.95, footer: 0.9, broken: 0.02, empty: 0.1 }, 3]);
  assert.match(t.method.inputs, /^[0-9a-f]{16}-[0-9a-f]{8}$/, 'the picture and the questions');
  const by = Object.fromEntries((await pages.read(cwd)).pages
    .map((p) => [p.url.replace(O, ''), p]));
  assert.deepEqual(opinions(by.c), { structure: ['no-footer'], picture: ['no-footer'] });
  assert.equal(bucketOf(by.c), 'odd', 'both say no footer');
  assert.equal(bucketOf(by.d), 'review', 'the structure says no header, the picture sees one');
  assert.equal(bucketOf(by.b), 'broken');
  assert.equal(bucketOf(by.a), 'normal');
  assert.equal(bucketOf(by.e), 'empty');
  assert.deepEqual(by.e.verdict.reasons.map((r) => r.code), ['empty']);
  assert.equal(by.b.verdict.status, 'in', 'flags park, they do not exclude');
  assert.deepEqual(by.c.verdict.reasons.map((r) => `${r.code}@${r.by}`),
    ['no-footer@chrome', 'no-footer@triage']);
  const [note] = await notes.list(cwd, { step: 'triage' });
  const body = await notes.body(cwd, note.id);
  assert.match(body,
    /## review: 1\n[^#]*site.example\/d — structure: no-header; picture: header and footer/);
  assert.match(body, /## broken: 1/);
  assert.match(body, /## empty: 1\n\nThe picture shows nothing where the content should be/);
  assert.deepEqual(await pending(cwd), [], 'every picture looked at');
  assert.deepEqual(await check(cwd), { pass: true });
  // A triage that no longer validates (older questions) is none: asked again, not counted.
  const old = path.join(cwd, 'migration', 'pages', id('b'), 'triage.json');
  await writeFile(old, JSON.stringify({ schema: 'pages/triage@1', method: t.method,
    answers: { header: 1, footer: 1, broken: 1 }, images: t.images }));
  assert.deepEqual((await pending(cwd)).map((x) => x.page.url), [`${O}b`]);
  assert.equal((await flag(cwd)).broken.length, 0, 'the stale broken flag is gone');
  const [bPending] = await pending(cwd);
  await triage.write(cwd, id('b'), { ...t, method: { ...t.method, inputs: bPending.inputs },
    answers: { header: 0.9, footer: 0.9, broken: 0.8, empty: 0.1 } });
  await flag(cwd);
  assert.deepEqual(await pending(cwd), []);
  // The same picture again is not asked; a new picture is.
  await writeFile(path.join(cwd, 'migration', (await data(cwd)).trees.shotFile(id('a'))), 'new');
  assert.deepEqual((await pending(cwd)).map((t) => t.page.url), [`${O}a`]);
  // Flags are recomputed from every triage on record, chrome's untouched.
  await pages.setReasons(cwd, 'chrome', {});
  await flag(cwd);
  const c2 = (await pages.get(cwd, id('c')));
  assert.deepEqual(c2.verdict.reasons.map((r) => `${r.code}@${r.by}`), ['no-footer@triage']);
  assert.equal(bucketOf(c2), 'review');
});

test('failures: a page that fails is recorded; five in a row end the run', async () => {
  const cwd = await project(['a', 'b', 'c', 'd', 'e', 'f'].map((p) => ({ path: p })));
  const dead = { model: 'clef', sharp: fakeSharp(1000), now: () => new Date(AT),
    ask: async () => { throw new Error('System 1 502: gateway'); } };
  await assert.rejects(workerMain(cwd, { io: dead }), /five pages failed in a row/);
  const { runs } = await data(cwd);
  const [run] = await runs.list(cwd, { step: 'triage' });
  assert.equal(run.state, 'failed');
  assert.equal(run.failed.length, 5);
  assert.equal((await pending(cwd)).length, 6, 'nothing written: all still to look at');
});
