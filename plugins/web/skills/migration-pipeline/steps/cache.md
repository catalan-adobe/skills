# cache

Run only after the operator approved a selection: `pipeline state --text` must show `cache`
as `ready`, not `waiting-operator`. Purpose: store the selected pages and their same-origin
assets on disk, through the page-cache proxy, so every later step works offline. Tier: low.

## Inputs

- `migration/migration.json` (`approvals.cache`: the selections), `pages/selections/`,
  `website/access.json` (the browser recipe and the overlay rules the worker applies),
  `migration/.work/setup.json` (the proxy script, `playwright-cli`).

## Method

1. The operator's words name what to cache. A group they named: `node <migration-data>/
   scripts/migration.mjs approve cache <group-selection>` once a selection of that group
   exists (`pipeline pick --exclude …` or a list). A number of pages: `node <skill>/scripts/
   pipeline.mjs pick --count <n> --write <name>` (uncached pages, one per largest group in
   turn, one URL shape at a time; `--audit 5` adds a few from the excluded groups), then
   `migration.mjs approve cache <name>`. Record the operator's words as a note. Never
   approve on your own.
2. Start the worker — the command returns at once:
   `node <skill>/scripts/pipeline.mjs cache`. It caches every approved selection not yet
   cached, one run each: visits every page through the proxy in one browser session with
   the access recipe applied (overlay rules, a scroll through the page so lazy images
   load), then verifies each from the cache and records it on the page table — what the
   site answered, redirects and where the browser landed, the kind (`page`, `binary`,
   `redirect`, `error`, `unreachable`), the cache location — and the verdicts follow.
3. Do not wait for it or poll in a loop. `pipeline state --text` shows `cache` as `running`
   with its progress; `pipeline cache status` the run; `pipeline cache stop` ends it after
   the current page. A stopped or failed run resumes where it left: run `pipeline cache`
   again; only uncached pages are visited.
4. A source 404 is a stored response of kind `error`, a redirect a stored response of kind
   `redirect`: both are facts on the record, not failures. `unreachable` means no response:
   say so; do not retry by other means. Never fetch pages with `curl` or any HTTP client:
   only the browser, through the recipe, reads the site.
5. Never delete anything under `migration/cache/`; the proxy fetches only what is missing.

## Outputs

- `migration/cache/` (the proxy's own layout, gitignored), page records with `cache`,
  `http`, `redirect`, `finalUrl`, `kind` and a verdict; `website/website.json` refreshed;
  one run per selection under `migration/runs/`; a runner note per selection.

## Done

Fails while no selection is approved, while a run is alive (with its progress), or while
a page of an approved selection has no cache yet (naming the selection).

```bash
node <skill>/scripts/pipeline.mjs state --text
```
