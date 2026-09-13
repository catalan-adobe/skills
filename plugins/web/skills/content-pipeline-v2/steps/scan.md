# scan

Purpose: collect every URL of the site and describe how they are distributed, so the
operator can decide what to cache. Tier: low; medium without a usable sitemap.
## Inputs
- `migration/project.json`: `origin` (a site root or a section page such as `/en/x.html`);
  `migration/setup.json`: `packages["franklin-bulk-shared"].path`, `skills["site-scan"].path`;
  `probe/probe.md` (blocked fetches predict a failed crawl); an operator's URL list, if any.

## Sibling skill
Read and follow `.agents/skills/site-scan/SKILL.md` (or the path `setup.json` gives). The
package is already under `migration/.work/node_modules`; do not install again.

## Method

Write this to `migration/.work/scan.mjs` and run it from the project root (crawl from the
site root, scoped to the origin's path — a section page is a scope, not a sitemap):

```js
import { Web } from 'franklin-bulk-shared';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const { origin } = JSON.parse(readFileSync('migration/project.json', 'utf8'));
const site = new URL(origin);
const scope = site.pathname.replace(/\.html$/, '').replace(/\/$/, '');
const strategy = process.argv[2] ?? 'sitemaps';
const urls = [];
const result = await Web.crawl(strategy === 'sitemaps' ? site.origin : origin, {
  strategy, timeout: 15000, sameDomain: true, limit: 2000, httpHeaders: {},
  inclusionPatterns: scope ? [`${scope}/**`, `${scope}.html`] : [],
  urlStreamFn: async (batch) => {
    for (const e of batch) if (e.status === 'valid') urls.push(e);
  },
});
if (urls.length === 0) throw new Error(`no valid URLs with strategy ${strategy}`);
mkdirSync('migration/urls', { recursive: true });
writeFileSync('migration/urls/urls.json', JSON.stringify(urls, null, 2));
console.log(`${urls.length} URLs, ${result.errors.length} errors`, result.sitemaps);
```

When sitemaps yield nothing (none, or on another host), rerun with `http` and note the
limit. Given an operator's list, convert each line to a `URLExtended` entry (`url`,
`origin`, `status: 'valid'`, `level1..3`, `filename`, `lang`, `message`) instead of crawling.
Then run `node <skill>/scripts/status.mjs urls`: it writes `urls/urls.md` (counts below the
path prefix every URL shares) and, over the threshold, `urls/subsets/<prefix>.txt`. Put the
last sentence of `urls.md` to the operator word for word; `cache` waits for `approve`.

## Outputs

`migration/urls/urls.json` (`URLExtended[]`, valid entries only); `urls/urls.md` and
`urls/subsets/*.txt` come from `status.mjs urls`. Append `## scan` to `REPORT.md`: total,
the strategy that worked (or the operator list), errors, largest groups, the proposal.

## Done

```bash
node <skill>/scripts/status.mjs check scan
```

If it fails, fix the artefact: every entry needs a `url`; `urls.md` comes from `status.mjs urls`.
