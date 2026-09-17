// Evidence for the eye: crops of element instances through the offline server. Which
// instances is decided by a hash, not by chance, so a rerun wants the same files and takes
// only the missing ones.
import { createHash } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { proxiedUrl } from './cache-server.mjs';

export const shotsDir = (project) => path.join(project.step('elements'), 'screenshots');
export const INSTANCES_PER_TYPE = 3;
// ponytail: the five largest variants get a crop; the rest are listed. All of them if a
// reviewer asks.
export const VARIANTS_PER_TYPE = 5;

const rank = (typeId, url) => createHash('sha1').update(`${typeId} ${url}`).digest('hex');

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
 * The crops a type should have: INSTANCES_PER_TYPE instances on distinct pages (chosen by
 * hash rank) and the sample of each of its VARIANTS_PER_TYPE largest variants.
 * @returns {{file: string, url: string, selector: string, kind: 'instance'|'variant',
 *   index: number}[]}
 */
export function plannedShots(type, pages) {
  const instances = pages.flatMap((p) => p.sections
    .filter((s) => s.type === type.id).slice(0, 1)
    .map((s) => ({ url: p.url, selector: s.selector, rank: rank(type.id, p.url) })));
  instances.sort((a, b) => a.rank.localeCompare(b.rank));
  const shots = instances.slice(0, INSTANCES_PER_TYPE).map((s, i) => ({
    file: `screenshots/type-${type.id}-${i + 1}.png`, url: s.url, selector: s.selector,
    kind: 'instance', index: i,
  }));
  type.variants.slice(0, VARIANTS_PER_TYPE).forEach((v, i) => shots.push({
    file: `screenshots/type-${type.id}-v${i + 1}.png`, url: v.sample.url,
    selector: v.sample.selector, kind: 'variant', index: i,
  }));
  return shots;
}

const exists = (file) => access(file).then(() => true, () => false);

/**
 * Takes every planned crop of the recurring types that is not on disk yet, page by page,
 * and returns the types with `screenshots` (instances, variants) and `screenshotError`.
 * `onProgress(done, total)` is called after every page.
 */
export async function screenshotTypes(project, result,
  { browser, origin, port, prepare = null, hide = [], onProgress = () => {} }) {
  await mkdir(shotsDir(project), { recursive: true });
  const dir = project.step('elements');
  const plans = new Map(result.types.filter((t) => t.recurring)
    .map((t) => [t.id, plannedShots(t, result.pages)]));
  const todo = [];
  for (const [typeId, shots] of plans) {
    for (const s of shots) {
      if (!(await exists(path.join(dir, s.file)))) todo.push({ typeId, ...s });
    }
  }
  const errors = new Map();
  const byPage = Map.groupBy(todo, (s) => s.url);
  let done = 0;
  for (const [url, shots] of byPage) {
    try {
      await browser.goto(proxiedUrl(origin, url, port));
      if (prepare) await browser.eval(`${prepare}, window.scrollTo(0, 0)`);
      await browser.eval(prepareExpression(hide));
    } catch (err) {
      for (const s of shots) {
        errors.set(s.typeId, [...(errors.get(s.typeId) ?? []), `${url}: ${err.message}`]);
      }
      continue;
    }
    for (const s of shots) {
      try {
        await browser.screenshot(path.join(dir, s.file), s.selector);
      } catch (err) {
        const line = `${s.selector} on ${url}: ${String(err.message).split('\n')[0]}`;
        errors.set(s.typeId, [...(errors.get(s.typeId) ?? []), line]);
      }
    }
    done += 1;
    onProgress(done, byPage.size);
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
