// discover: every URL of the site into the page table — from the sitemaps, from a crawl,
// or from a list the operator gives — then the website summary and the proposal of what
// to cache, as a note. The crawler is franklin-bulk-shared, installed by setup under
// migration/.work; nothing of the site is fetched beyond the sitemaps or the crawl.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { data } from './data.mjs';

export const STRATEGIES = ['sitemaps', 'http', 'list'];
export const CRAWL_LIMIT = 5000;

/** The crawler module from the project-scoped install. */
async function crawler(cwd) {
  const pkg = path.join(cwd, 'migration', '.work', 'node_modules', 'franklin-bulk-shared');
  const meta = await readFile(path.join(pkg, 'package.json'), 'utf8').then(JSON.parse, () => null);
  if (!meta) throw new Error('franklin-bulk-shared is not installed; run pipeline setup --install');
  const entry = meta.exports?.['.']?.import ?? meta.exports?.['.'] ?? meta.module ?? meta.main;
  return import(pathToFileURL(path.join(pkg, entry)).href);
}

/**
 * Collects the URLs with a strategy — `sitemaps` (the default; from the origin's sitemaps),
 * `http` (a crawl from the scope, bounded), `list` (the operator's file, one URL a line) —
 * through an injectable `crawl` for tests.
 */
export async function collect(cwd, { strategy = 'sitemaps', list, crawl } = {}) {
  const { migration } = await data(cwd);
  const m = await migration.open(cwd);
  if (strategy === 'list') {
    if (!list) throw new Error('--list <file> is needed with the list strategy');
    const text = await readFile(list, 'utf8');
    const urls = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    return { urls: urls.map((url) => ({ url })), from: 'list', source: path.basename(list),
      errors: [] };
  }
  if (!STRATEGIES.includes(strategy)) throw new Error(`strategy must be one of ${STRATEGIES}`);
  const run = crawl ?? (await crawler(cwd)).Web.crawl;
  const site = new URL(m.source.origin);
  const scopePath = new URL(m.source.scope).pathname.replace(/\/$/, '');
  const urls = [];
  const result = await run(strategy === 'sitemaps' ? site.origin : m.source.scope, {
    strategy, timeout: 15000, sameDomain: true,
    limit: strategy === 'http' ? CRAWL_LIMIT : undefined, httpHeaders: {},
    inclusionPatterns: scopePath ? [`${scopePath}*`] : [],
    urlStreamFn: async (batch) => {
      for (const e of batch) {
        if (e.status === 'valid') urls.push({ url: e.url, source: e.origin });
      }
    },
  });
  if (!urls.length) throw new Error(`no valid URLs with strategy ${strategy}`);
  return { urls, from: strategy === 'sitemaps' ? 'sitemap' : 'crawl',
    source: result?.sitemaps?.[0], errors: result?.errors ?? [] };
}

/** The proposal in words: cache all under the threshold, else the largest groups. */
export function proposal(site, cacheAllUpTo) {
  const n = site.counts.inScope;
  if (n <= cacheAllUpTo) {
    return `${n} URLs in scope, under the threshold of ${cacheAllUpTo}: cache all.`;
  }
  let covered = 0;
  const chosen = [];
  for (const g of site.groups) {
    chosen.push(g);
    covered += g.urls;
    if (covered >= n * 0.8) break;
  }
  const share = Math.round((100 * covered) / n);
  const named = chosen.map((g) => `${g.name || '(root)'} (${g.urls})`).join(', ');
  return `${n} URLs in scope exceed the threshold of ${cacheAllUpTo}: cache the ${chosen.length}`
    + ` largest groups covering ${share} % — ${named} — or a sample with pipeline pick.`;
}

/** The step: collect, upsert, refresh the website, note the proposal; one run. */
export async function discover(cwd, options = {}) {
  const { migration, runs, pages, website, notes } = await data(cwd);
  const m = await migration.open(cwd);
  const run = await runs.start(cwd, 'discover', { strategy: options.strategy ?? 'sitemaps' });
  await runs.update(cwd, run.id, { state: 'running' });
  try {
    const { urls, from, source, errors } = await collect(cwd, options);
    const at = new Date().toISOString();
    await pages.upsert(cwd, urls.map((u) => ({
      url: u.url, discovered: { from, at, ...(source ? { source } : {}) },
    })));
    const site = await website.refresh(cwd);
    const words = proposal(site, m.settings.cacheAllUpTo);
    await notes.add(cwd, { step: 'discover', author: 'runner', summary: 'proposal: what to cache',
      body: `# Discover\n\n${site.summary}\n\n${words}\n` });
    const summary = `${urls.length} URLs from ${from}${source ? ` (${source})` : ''}; `
      + `${site.counts.inScope} in scope in ${site.groups.length} groups; ${errors.length} errors.`;
    await runs.finish(cwd, run.id, { state: 'done', summary });
    return { run: run.id, urls: urls.length, inScope: site.counts.inScope,
      groups: site.groups.length, proposal: words };
  } catch (err) {
    await runs.finish(cwd, run.id, { state: 'failed', error: err.message });
    throw err;
  }
}
