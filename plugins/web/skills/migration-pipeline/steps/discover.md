# discover

Purpose: every URL of the site into the page table, with how it was found; the website
summary; the proposal of what to cache, for the operator. Tier: low (one command; medium
only when the site has no usable sitemap and the crawl must be judged).

## Inputs

- `migration/migration.json`: `source.origin` and `source.scope` (the URL prefix that
  bounds the website; URLs outside it are recorded and marked out of scope).
- The site's sitemaps, read by the crawler — nothing else is fetched. An operator's URL
  list, if given (`--list <file>`, one URL a line).

## Method

1. `node <skill>/scripts/pipeline.mjs discover` — from the sitemaps. Without a usable
   sitemap: `--strategy http` (a crawl from the scope, bounded at 5000 URLs; slow, judge
   its result); with a list from the operator: `--strategy list --list <file>`.
2. The command writes `pages/pages.json` (one record per URL, its id, its group below the
   scope, how and when it was discovered, and a verdict — out of scope pages are `out`,
   the rest `in`, or `undecided` while the plan names a page budget but no selection yet),
   refreshes `website/website.json`, records a run and a runner note with the proposal.
3. Put the proposal to the operator and wait: cache all (under the threshold), the
   largest groups it names, or a sample (`pipeline pick`, the cache brief). Record the
   operator's words: `node <migration-data>/scripts/migration.mjs note discover operator
   "<their words>"`. Never approve the cache yourself.
4. A rerun merges: known URLs keep their facts, new ones are added. Never edit
   `pages.json` by hand; a page the operator wants in or out is a decision:
   `migration.mjs decide-page <url> in|out <reason>`.

## Outputs

- `migration/pages/pages.json`, `migration/website/website.json`, a run under
  `migration/runs/`, a note under `migration/notes/`, `migration/state.json`.

## Done

Fails while no page is in scope, or while the website summary is behind the table.

```bash
node <skill>/scripts/pipeline.mjs state --text
```
