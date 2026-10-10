// access: how to open a page of this site — the browser-probe sibling's recipe and the
// page-prep sibling's overlays, as the agent saved them under migration/.work/access/,
// folded into one decision file through the layer: website/access.json.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { data } from './data.mjs';

export const WORK = 'migration/.work/access';
export const RECIPE_FILE = 'browser-recipe.json';
export const PREP_FILE = 'page-prep.json';

const readJson = async (file) => {
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message})`);
  }
};

/** The probe's recipe as the layer's `browser`: engine first, the rest as it was found. */
export function browserOf(recipe) {
  const config = recipe.cliConfig ?? {};
  return {
    engine: config.browser?.browserName ?? 'chromium',
    ...(Object.keys(config).length ? { config } : {}),
    ...(recipe.stealthInitScript ? { stealthInitScript: recipe.stealthInitScript } : {}),
    ...(recipe.notes ? { notes: recipe.notes } : {}),
  };
}

/** The prep's overlays as the layer's: a hide rule per overlay, a click per dismissal. */
export function overlaysOf(prep) {
  return (prep.overlays ?? []).flatMap((o) => [
    ...(o.hide?.length ? [{ selector: o.selector, action: 'hide', css: o.hide,
      ...(o.type ? { note: o.type } : {}) }] : []),
    ...(o.dismiss ?? []).filter((d) => d.action === 'click')
      .map((d) => ({ selector: d.selector, action: 'click', note: `dismisses ${o.selector}` })),
  ]);
}

/**
 * Folds the probe's and the prep's findings into website/access.json. The pages the
 * recipe was verified on (the prep's `checked`) are made known to the table when they
 * are not, so `verifiedOn` holds page ids. What a reader added since through the layer —
 * overlay rules (`by: reader`) for selectors the prep does not name, rendering rules — is
 * kept: a rerun after an edit of the prep must not lose what was found in the captures.
 */
export async function writeAccess(cwd, { dir = path.join(cwd, WORK) } = {}) {
  const recipe = await readJson(path.join(dir, RECIPE_FILE));
  if (!recipe) {
    throw new Error(`no ${path.join(dir, RECIPE_FILE)}: run the browser-probe sibling first`);
  }
  const prep = await readJson(path.join(dir, PREP_FILE));
  if (!prep) throw new Error(`no ${path.join(dir, PREP_FILE)}: run the page-prep sibling first`);
  const { pages, website, runs, notes } = await data(cwd);
  const checked = [...new Set((prep.checked ?? []).map((u) => pages.canonical(u)))];
  const table = await pages.read(cwd);
  const known = new Set(table.pages.map((p) => p.url));
  const unknown = checked.filter((u) => !known.has(u));
  if (unknown.length) {
    const at = new Date().toISOString();
    await pages.upsert(cwd, unknown.map((url) => ({ url, discovered: { from: 'link', at } })));
    await website.refresh(cwd); // whoever changes the table refreshes the summary
  }
  const run = await runs.start(cwd, 'access', { recipe: RECIPE_FILE, prep: PREP_FILE });
  const before = await website.readAccess(cwd);
  const fromPrep = overlaysOf(prep);
  const named = new Set(fromPrep.map((o) => o.selector));
  const access = await website.writeAccess(cwd, {
    browser: browserOf(recipe),
    overlays: [...fromPrep, ...(before?.overlays ?? [])
      .filter((o) => o.by === 'reader' && !named.has(o.selector))],
    rendering: before?.rendering ?? [],
    ...(prep.scroll_fix ? { scrollFix: prep.scroll_fix } : {}),
    verifiedOn: checked.map((u) => pages.pageId(u)),
  });
  const residual = (prep.residual ?? []).length;
  const stealth = recipe.stealthInitScript ? ' with a stealth script' : '';
  const summary = `${access.browser.engine}${stealth};`
    + ` ${access.overlays.length} overlay rule(s); verified on ${access.verifiedOn.length} page(s)`
    + `${residual ? `; ${residual} residual element(s) left visible on purpose` : ''}.`;
  await notes.add(cwd, { step: 'access', author: 'runner', summary: 'how pages are opened',
    body: `# Access\n\n${summary}\n\n${recipe.notes ?? ''}\n` });
  await runs.finish(cwd, run.id, { state: 'done', summary });
  return { run: run.id, access, summary };
}

/** Done when the recipe exists and was verified on the home page and two more. */
export async function check(cwd) {
  const { website } = await data(cwd);
  const access = await website.readAccess(cwd);
  if (!access) return { pass: false, note: 'no website/access.json yet' };
  if (access.verifiedOn.length < 3) {
    return { pass: false, note: `recipe verified on ${access.verifiedOn.length} page(s); needs 3` };
  }
  return { pass: true };
}
