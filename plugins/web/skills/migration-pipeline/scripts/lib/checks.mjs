// The done-checks this skill supplies to the layer's state: a step is done when its
// outcome is in the data. One function per step; each returns { pass, note? }.
import { check as access } from './access.mjs';
import { check as cache } from './cache.mjs';
import { check as chrome } from './chrome.mjs';
import { check as report } from './report.mjs';
import { data } from './data.mjs';

export async function discover(cwd) {
  const { pages, website } = await data(cwd);
  const table = await pages.read(cwd);
  const inScope = table.pages.filter((p) => p.group !== null);
  if (!inScope.length) return { pass: false, note: 'no page in scope yet' };
  const site = await website.readWebsite(cwd);
  if (!site || site.updatedAt < table.updatedAt) {
    return { pass: false, note: 'website summary behind the table; run pipeline website' };
  }
  return { pass: true };
}

/** The table of checks; steps without one are not done until their part lands. */
export const CHECKS = { discover, access, cache, chrome, report };
