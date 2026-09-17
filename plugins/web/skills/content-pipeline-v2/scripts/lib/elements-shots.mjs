// Evidence for the eye: crops of element instances through the offline server. Which
// instances is decided by a hash, not by chance, and a crop's file name carries the hash of
// what it shows — so "on disk" means "this exact instance", a rerun takes only what is
// missing, and a crop nothing references any more is swept.
import { createHash } from 'node:crypto';
import { access, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { proxiedUrl } from './cache-server.mjs';
import { variantId } from './elements.mjs';

export const shotsDir = (project) => path.join(project.step('elements'), 'screenshots');
export const INSTANCES_PER_TYPE = 3;
// ponytail: the five largest variants get a crop; the rest are listed. All of them if a
// reviewer asks.
export const VARIANTS_PER_TYPE = 5;

const sha8 = (text) => createHash('sha1').update(text).digest('hex').slice(0, 8);

/**
 * One eval before the crops of a page: pause every animation and transition (an element
 * screenshot waits for the element to hold still; a carousel never does) and hide the
 * chrome members (a sticky header would sit inside a tall crop).
 */
export const prepareExpression = (hide = []) => {
  const rules = ['*, *::before, *::after { animation-play-state: paused !important;'
    + ' transition: none !important; }',
  ...(hide.length ? [`${hide.join(', ')} { display: none !important; }`] : [])];
  return '(() => { const s = document.createElement("style");'
    + ` s.textContent = ${JSON.stringify(rules.join(' '))}; document.head.appendChild(s);`
    + ' return 1; })()';
};

/**
 * The crops a type should have: INSTANCES_PER_TYPE instances on distinct pages (page and
 * instance chosen by hash rank) and the sample of each of its VARIANTS_PER_TYPE largest
 * variants. File names carry the rank or the variant id.
 * @returns {{file: string, url: string, selector: string, kind: 'instance'|'variant'}[]}
 */
export function plannedShots(type, pages) {
  const instances = pages.flatMap((p) => {
    const own = p.sections.filter((s) => s.type === type.id)
      .map((s) => ({
        url: p.url, selector: s.selector, rank: sha8(`${type.id} ${p.url} ${s.selector}`),
      }))
      .sort((a, b) => a.rank.localeCompare(b.rank));
    return own.slice(0, 1).map((s) => ({ ...s, rank: sha8(`${type.id} ${p.url}`) }));
  });
  instances.sort((a, b) => a.rank.localeCompare(b.rank));
  const shots = instances.slice(0, INSTANCES_PER_TYPE).map((s) => ({
    file: `screenshots/type-${type.id}-${s.rank}.png`, url: s.url, selector: s.selector,
    kind: 'instance',
  }));
  for (const v of type.variants.slice(0, VARIANTS_PER_TYPE)) {
    shots.push({
      file: `screenshots/type-${type.id}-v${variantId(v.children)}.png`, url: v.sample.url,
      selector: v.sample.selector, kind: 'variant',
    });
  }
  return shots;
}

const exists = (file) => access(file).then(() => true, () => false);

/**
 * Takes every planned crop of the recurring types that is not on disk yet, page by page,
 * sweeps the crops no plan references, and returns the types with `screenshots`
 * (instances, variants) and `screenshotError`. `onProgress(done, total)` is awaited after
 * every page, failed or not.
 */
export async function screenshotTypes(project, result,
  { browser, origin, port, prepare = null, hide = [], onProgress = async () => {} }) {
  await mkdir(shotsDir(project), { recursive: true });
  const dir = project.step('elements');
  const plans = new Map(result.types.filter((t) => t.recurring)
    .map((t) => [t.id, plannedShots(t, result.pages)]));
  const wanted = new Set([...plans.values()].flat().map((s) => path.basename(s.file)));
  for (const f of await readdir(shotsDir(project))) {
    if (!wanted.has(f)) await rm(path.join(shotsDir(project), f), { force: true });
  }
  const todo = [];
  for (const [typeId, shots] of plans) {
    for (const s of shots) {
      if (!(await exists(path.join(dir, s.file)))) todo.push({ typeId, ...s });
    }
  }
  const errors = new Map();
  const fail = (typeId, line) => errors.set(typeId, [...(errors.get(typeId) ?? []), line]);
  const firstLine = (err) => String(err.message).split('\n')[0];
  const byPage = Map.groupBy(todo, (s) => s.url);
  let done = 0;
  for (const [url, shots] of byPage) {
    try {
      await browser.goto(proxiedUrl(origin, url, port));
      if (prepare) await browser.eval(`${prepare}, window.scrollTo(0, 0)`);
      await browser.eval(prepareExpression(hide));
      for (const s of shots) {
        try {
          await browser.screenshot(path.join(dir, s.file), s.selector);
        } catch (err) {
          fail(s.typeId, `${s.selector} on ${url}: ${firstLine(err)}`);
        }
      }
    } catch (err) {
      for (const s of shots) fail(s.typeId, `${url}: ${firstLine(err)}`);
    }
    done += 1;
    await onProgress(done, byPage.size);
  }
  const types = [];
  for (const t of result.types) {
    const shots = plans.get(t.id);
    if (!shots) { types.push(t); continue; }
    const taken = [];
    for (const s of shots) if (await exists(path.join(dir, s.file))) taken.push(s);
    types.push({
      ...t,
      screenshots: {
        instances: taken.filter((s) => s.kind === 'instance').map((s) => s.file),
        variants: taken.filter((s) => s.kind === 'variant').map((s) => s.file),
      },
      ...(errors.has(t.id) ? { screenshotError: errors.get(t.id) } : {}),
    });
  }
  return { ...result, types };
}
