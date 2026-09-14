# scan

Purpose: collect every URL of the site and describe their distribution so the operator can
decide what to cache. Tier: low; medium without a usable sitemap.
## Inputs
- `migration/project.json`: `origin` (a site root or a section page such as `/en/x.html`);
  `migration/setup.json`: `packages["franklin-bulk-shared"].path`, `skills["site-scan"].path`;
  `probe/probe.md` (blocked fetches predict a failed crawl); an operator's URL list, if any.
- Sibling skill `.agents/skills/site-scan/SKILL.md` (path in `setup.json`): the reference
  when the snippet below fails. The package is already under `migration/.work/node_modules`.

## Method
Write this to `migration/.work/scan.mjs` and run it in the foreground, from any directory
(it crawls from the site root, scoped to the origin's path); quote its last line in the report:

```js
import { Web } from 'franklin-bulk-shared';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const migration = path.resolve(import.meta.dirname, '..');
const { origin } = JSON.parse(readFileSync(path.join(migration, 'project.json'), 'utf8'));
const site = new URL(origin);
const scope = site.pathname.replace(/\.html$/, '').replace(/\/$/, '');
const strategy = process.argv[2] ?? 'sitemaps';
const limit = strategy === 'http' ? 5000 : undefined;
const urls = [];
const result = await Web.crawl(strategy === 'sitemaps' ? site.origin : origin, {
  strategy, timeout: 15000, sameDomain: true, limit, httpHeaders: {},
  inclusionPatterns: scope ? [`${scope}*`] : [],
  urlStreamFn: async (batch) => {
    for (const e of batch) if (e.status === 'valid') urls.push(e);
  },
});
if (urls.length === 0) throw new Error(`no valid URLs with strategy ${strategy}`);
if (limit && urls.length >= limit) console.warn(`hit the limit of ${limit}; raise it`);
mkdirSync(path.join(migration, 'urls'), { recursive: true });
writeFileSync(path.join(migration, 'urls/urls.json'), JSON.stringify(urls, null, 2));
console.log(`${urls.length} URLs, ${result.errors.length} errors`, result.sitemaps);
```

One inclusion pattern only (the library requires every pattern to match); a sitemap index on
another host is fine. When sitemaps yield nothing, rerun with `http`. Given an operator's
list, convert each line to a `URLExtended` (`url`, `origin`, `status: 'valid'`, `level1..3`,
`filename`, `lang`, `message`) instead. Any change to the snippet goes in `REPORT.md`.
Then run `node <skill>/scripts/status.mjs urls`: it writes `urls/urls.md` (counts below the
path prefix every URL shares) and, over the threshold, `urls/subsets/<prefix>.txt`. Put the
proposal sentence that opens `urls.md` to the operator word for word; `cache` waits for
`approve`.

## Outputs
`migration/urls/urls.json` (`URLExtended[]`, valid entries only); `urls/urls.md` and
`urls/subsets/*.txt` come from `status.mjs urls`. Append `## scan` to `REPORT.md`: total,
the strategy that worked (or the operator list), errors, largest groups, the proposal.

## Done
```bash
node <skill>/scripts/status.mjs check scan
```
If it fails, fix the artefact: every entry needs a `url`; `urls.md` comes from `status.mjs urls`.
