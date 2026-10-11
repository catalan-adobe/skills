// triage: the first look at every captured page by a System 1 model, on its screenshot —
// four questions, frozen: a site header at the top, a site footer at the bottom, a broken
// page, an empty one. The answers become flags on the table beside what chrome found in
// the structure; a page flagged by either is parked — odd, specific — until someone looks.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sharpOf } from './browser.mjs';
import { readablePages } from './capture.mjs';
import { data } from './data.mjs';
import { ask, deployment } from './system1.mjs';

export const METHOD = 'system1';
export const WIDTH = 1280;
export const SLICE = 768;
export const MAX_SLICES = 4;
// A last slice thinner than this joins the one above: System 1 refuses a 1280 × 5 image (a
// 1541 px page had been cut 768 + 768 + 5, and failed every time).
export const MIN_TAIL = 128;
export const BODY_BUDGET = 500000;
export const QUALITIES = [80, 70, 60, 50, 40, 30, 20];
const LOOK = 'Judge by what is visible in the images, which are the page cut into slices from'
  + ' top to bottom.';

/** The four questions, frozen: answers shift when the set around them changes. */
export const QUESTIONS = {
  header: 'Does the page have a site header at the very top: a bar holding the logo and the'
    + ' main navigation menu, usually with language, search or sign-in links?',
  footer: 'Does the page have a site footer at the very bottom: groups of links, legal'
    + ' notices, copyright or social icons?',
  broken: 'Is the page broken or blocked: an error message, a blank page, a login wall, a'
    + ' cookie wall or a bot check instead of normal content?',
  empty: 'Between the header and the footer, is the page empty or nearly empty: a blank area,'
    + ' or only a heading, a breadcrumb, a side menu or a few links, where the main content'
    + ' (an article, a listing, images, a form) should be?',
};
/** What a triage is of: this picture, asked these questions. */
export const QUESTIONS_HASH = createHash('sha256').update(JSON.stringify(QUESTIONS))
  .digest('hex').slice(0, 8);
export const asked = () => Object.fromEntries(Object.entries(QUESTIONS)
  .map(([id, q]) => [id, `${q} ${LOOK}`]));

/**
 * The screenshot cut top to bottom into at most four slices of 1280 × 768 (one image is
 * about what the service keeps at full resolution), the last a little taller rather than a
 * sliver, 1:1 up to 3 072 px, scaled down above;
 * JPEG quality lowered in steps only while the request body would be refused.
 */
export async function slices(sharp, shot, { budget = BODY_BUDGET } = {}) {
  const meta = await sharp(shot).metadata();
  const scale = Math.min(1, (MAX_SLICES * SLICE) / meta.height, WIDTH / meta.width);
  const w = Math.round(meta.width * scale);
  const h = Math.round(meta.height * scale);
  const cut = Math.max(1, Math.ceil(h / SLICE));
  const n = cut > 1 && h - (cut - 1) * SLICE < MIN_TAIL ? cut - 1 : cut;
  for (const quality of QUALITIES) {
    const images = [];
    let bytes = 0;
    for (let i = 0; i < n; i += 1) {
      const top = i * SLICE;
      // eslint-disable-next-line no-await-in-loop
      const buf = await sharp(shot).resize(w, h, { fit: 'fill' })
        .extract({ left: 0, top, width: w, height: i === n - 1 ? h - top : SLICE })
        .jpeg({ quality }).toBuffer();
      bytes += buf.length;
      images.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
    }
    if (images.join('').length <= budget || quality === QUALITIES.at(-1)) {
      return { images, quality, scale, bytes };
    }
  }
  throw new Error('unreachable');
}

const sha = (buf) => `${createHash('sha256').update(buf).digest('hex').slice(0, 16)}`
  + `-${QUESTIONS_HASH}`;

/** A stored triage; one that no longer validates (older questions) is none. */
const stored = (triage, cwd, id) => triage.read(cwd, id).catch(() => null);

/**
 * The pages to triage: readable, with a screenshot, and without a triage of that very
 * picture (a recapture changes the picture; a triage of the old one is stale).
 */
export async function pending(cwd) {
  const { trees, triage } = await data(cwd);
  const readable = await readablePages(cwd);
  const out = [];
  for (const page of readable) {
    const shot = trees.shotFile(page.id);
    // eslint-disable-next-line no-await-in-loop
    const bytes = await readFile(path.join(cwd, 'migration', shot)).catch(() => null);
    if (!bytes) continue;
    const inputs = sha(bytes);
    // eslint-disable-next-line no-await-in-loop
    const seen = await stored(triage, cwd, page.id);
    if (seen?.method.inputs !== inputs) out.push({ page, shot, inputs });
  }
  return out;
}

/** What chrome and triage each say about a page, read off its reasons. */
export function opinions(page) {
  const by = (unit) => page.verdict.reasons.filter((r) => r.by === unit).map((r) => r.code);
  return { structure: by('chrome'), picture: by('triage') };
}

/**
 * The bucket a page lands in: `broken` (the picture says so), `empty` (the picture says
 * so), `odd` (both say chrome is missing), `review` (the two disagree), `normal`.
 */
export function bucketOf(page) {
  const { structure, picture } = opinions(page);
  if (picture.includes('broken')) return 'broken';
  if (picture.includes('empty')) return 'empty';
  const s = new Set(structure.filter((c) => c.startsWith('no-')));
  const p = new Set(picture.filter((c) => c.startsWith('no-')));
  if (!s.size && !p.size) return 'normal';
  const same = s.size === p.size && [...s].every((c) => p.has(c));
  return same ? 'odd' : 'review';
}

const firstLine = (text) => String(text ?? '').split('\n').find((l) => l.trim()) ?? '';

/**
 * The worker: every pending page's screenshot sliced and asked, the answers stored, then
 * the flags set from every triage on record, the website refreshed, a note with the
 * buckets. `io`: `ask(images, questions)`, `sharp`, injectable.
 */
export async function workerMain(cwd, { io: given } = {}) {
  const { runs, triage, notes } = await data(cwd);
  const io = given ?? realIo(cwd);
  const todo = await pending(cwd);
  const run = await runs.start(cwd, 'triage', { pages: todo.length, model: io.model },
    { pid: process.pid });
  await runs.update(cwd, run.id, { state: 'running', total: todo.length });
  const failures = [];
  let done = 0;
  let tokens = 0;
  try {
    for (const { page, shot, inputs } of todo) {
      // eslint-disable-next-line no-await-in-loop
      await runs.update(cwd, run.id, { current: page.id });
      try {
        // eslint-disable-next-line no-await-in-loop
        const cut = await slices(io.sharp, path.join(cwd, 'migration', shot));
        // eslint-disable-next-line no-await-in-loop
        const { answers, usage } = await io.ask(cut.images, asked());
        tokens += usage.inputTokens ?? 0;
        // eslint-disable-next-line no-await-in-loop
        await triage.write(cwd, page.id, {
          method: { name: METHOD, model: io.model, at: io.now().toISOString(), inputs },
          answers,
          images: { slices: cut.images.length, scale: Math.round(cut.scale * 1000) / 1000,
            quality: cut.quality, bytes: cut.bytes },
          usage,
        });
      } catch (err) {
        failures.push({ id: page.id, error: firstLine(err.message) });
        // eslint-disable-next-line no-await-in-loop
        await runs.update(cwd, run.id, { fail: failures.at(-1) });
        if (failures.length >= 5 && failures.length === done + 1) {
          throw new Error(`five pages failed in a row; last: ${firstLine(err.message)}`);
        }
      }
      done += 1;
      // eslint-disable-next-line no-await-in-loop
      await runs.update(cwd, run.id, { done, current: null });
    }
    const buckets = await flag(cwd);
    const counts = Object.entries(buckets).map(([b, list]) => `${list.length} ${b}`).join(', ');
    const summary = `${todo.length - failures.length} of ${todo.length} page(s) looked at`
      + ` (${failures.length} failed, ${tokens} input tokens); of all triaged: ${counts}.`;
    await notes.add(cwd, { step: 'triage', author: 'runner', summary,
      body: renderNote(buckets, summary, io.model) });
    await runs.finish(cwd, run.id, { state: 'done', summary });
    return { run: run.id, summary, buckets };
  } catch (err) {
    await runs.finish(cwd, run.id, { state: 'failed', error: firstLine(err.message),
      summary: `${done - failures.length} of ${todo.length} looked at before the failure` });
    throw err;
  }
}

/**
 * The pages System 1 could not answer on in the last two runs: the same failure twice is
 * not transient. They are flagged `unread`, parked until someone looks; the step can end.
 */
export async function stuck(cwd) {
  const { runs } = await data(cwd);
  const [a, b] = (await runs.list(cwd, { step: 'triage' })).slice(-2);
  if (!a || !b) return new Map();
  const before = new Set((a.failed ?? []).map((f) => f.id));
  return new Map((b.failed ?? []).filter((f) => before.has(f.id)).map((f) => [f.id, f.error]));
}

/** Sets the triage flags from every triage on record; returns the pages by bucket. */
export async function flag(cwd) {
  const { pages, triage, website } = await data(cwd);
  const flags = {};
  for (const [id, error] of await stuck(cwd)) {
    flags[id] = [{ code: 'unread', kind: 'flag', detail: `twice: ${error}`.slice(0, 200) }];
  }
  const triaged = new Set();
  for (const id of await triage.list(cwd)) {
    // eslint-disable-next-line no-await-in-loop
    const t = await stored(triage, cwd, id);
    if (!t) continue;
    triaged.add(id);
    const f = triage.flagsOf(t.answers);
    if (f.length) flags[id] = f;
  }
  await pages.setReasons(cwd, 'triage', flags);
  await website.refresh(cwd);
  const table = await pages.read(cwd);
  const buckets = { normal: [], odd: [], review: [], broken: [], empty: [] };
  for (const p of table.pages.filter((x) => triaged.has(x.id))) buckets[bucketOf(p)].push(p);
  return buckets;
}

function renderNote(buckets, summary, model) {
  const lines = [`# Triage: the first look, by ${model}`, '', summary, ''];
  const say = (p) => {
    const { structure, picture } = opinions(p);
    return `- ${p.url} — structure: ${structure.join(', ') || 'header and footer'};`
      + ` picture: ${picture.join(', ') || 'header and footer, content, not broken'}`;
  };
  for (const [bucket, words] of [
    ['broken', 'The picture shows an error, a blank, a wall or a bot check. Parked: look at the'
      + ' screenshot; a capture defect is fixed in access.json and captured again, a real'
      + ' error page is decided out.'],
    ['empty', 'The picture shows nothing where the content should be. Parked: a listing a'
      + ' script fills from an endpoint the cache has not got, a form from another origin,'
      + ' or a page that really is a shell. Look; name the origin or decide the page.'],
    ['review', 'Structure and picture disagree. Parked: one of them is wrong about this page —'
      + ' a header folded into a hero, a header in the DOM but not drawn. Look, then say which.'],
    ['odd', 'Both agree a header or a footer is missing. Parked as a page of its own kind:'
      + ' a campaign template, a landing page, a tool.'],
  ]) {
    lines.push(`## ${bucket}: ${buckets[bucket].length}`, '', words, '',
      ...buckets[bucket].slice(0, 40).map(say), '');
  }
  lines.push(`## normal: ${buckets.normal.length}`, '',
    'Header and footer in the structure and in the picture, content, nothing broken: read'
      + ' further.', '');
  return lines.join('\n');
}

/** Done when every page with a screenshot has a triage of that picture; needs a model. */
export async function check(cwd) {
  const { runs } = await data(cwd);
  const newest = await runs.newest(cwd, 'triage');
  if (newest && ['queued', 'running'].includes(runs.liveness(newest))) {
    return { pass: false, note: `looking at ${newest.current ?? 'pages'}` };
  }
  const readable = await readablePages(cwd);
  if (!readable.length) return { pass: false, note: 'no cached page to look at yet' };
  const { trees } = await data(cwd);
  const shots = await Promise.all(readable.map((p) => readFile(path.join(cwd, 'migration',
    trees.shotFile(p.id))).then(() => true, () => false)));
  // A page too tall for one picture has none, and is parked already.
  const unshot = readable.filter((p, i) => !shots[i]
    && !p.verdict.reasons.some((r) => r.code === 'too-tall')).length;
  if (unshot) return { pass: false, note: `${unshot} page(s) without a screenshot: chrome first` };
  const parked = await stuck(cwd);
  const todo = (await pending(cwd)).filter((t) => !parked.has(t.page.id));
  if (!todo.length) {
    return { pass: true, ...(parked.size ? { note: `${parked.size} page(s) unread by System 1`
      + ' twice: flagged unread, to look at' } : {}) };
  }
  try {
    deployment();
  } catch (err) {
    return { pass: false, note: `${todo.length} page(s) to look at; ${firstLine(err.message)}` };
  }
  return { pass: false, note: `${todo.length} page(s) to look at` };
}

/** The real io: the deployment from the environment, sharp from setup. */
export function realIo(cwd) {
  const dep = deployment();
  return {
    model: dep.model,
    sharp: sharpOf(cwd),
    ask: (images, questions) => ask(dep, images, questions),
    now: () => new Date(),
  };
}

/** What `pipeline triage` has to do: page ids, or an error naming the missing setting. */
export async function pendingIds(cwd) {
  deployment();
  return (await pending(cwd)).map((t) => t.page.id);
}
