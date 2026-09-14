# cache

Run only after `status.mjs approve cache [<subset>...]`: `status.mjs` must show `cache` as
`ready`, not `waiting-operator`. Purpose: store the selected pages and their same-origin
assets on disk so later analysis works offline. Tier: low; medium for the coverage read.

## Inputs
- `migration/project.json`: `cacheSelection` (`"all"` or subset names).
- `migration/urls/urls.json`, or `urls/subsets/<name>.txt` for each selected subset.
- `migration/probe/playwright-config.json`, `probe/browser-recipe.json` (`persistent`).
- `migration/prep/page-prep.json`: `overlays[].hide` and `scroll_fix`.
- `migration/setup.json`: `playwrightCli.path`, `skills["page-cache"].path`.

## Sibling skill
Read and follow `.agents/skills/page-cache/SKILL.md` (or the path `setup.json` gives).

## Method

1. Resolve the selection to a URL list. `"all"` means every `url` in `urls.json`;
   otherwise the union of the named subset files, one URL per line.
2. Start the proxy on a free port: `PORT=$(node <skill>/scripts/status.mjs free-port | jq
   .port)`, then `--port $PORT --cache migration/cache/.page-cache`.
3. Open the first URL through the proxy with `playwright-cli open --config
   migration/probe/playwright-config.json` (add `--persistent` when the recipe says so).
   Then `goto` each remaining URL through the proxy in the same session.
4. On every page: inject the `hide` rules and `scroll_fix` from `page-prep.json` in one
   `eval` (an expression), scroll to the bottom and back for lazy content. The proxy stores
   the raw responses, so the cached HTML still holds the overlay markup; the injection only
   makes the page load what a reader would see. Stay at the skill's pace.
5. Verify rather than trust the warm-up: close the browser, restart the proxy with
   `--offline`, request every selected URL through it and record `cached` on 2xx, `failed`
   with the status otherwise; `skipped` for URLs you deliberately left out (say why). Read
   `/__status`, stop the proxy.

## Outputs

- `migration/cache/.page-cache/`: the proxy's cache directory (gitignored).
- `migration/cache/cache.md`: a table with one row per selected URL, first column the
  URL exactly as in the selection, second column `cached`, `failed` or `skipped`:
  ```markdown
  | url | status | note |
  | --- | --- | --- |
  | <url> | cached | |
  ```
  followed by the `/__status` counts and the settings that held (port, pace, session).

## REPORT.md

Write the `## cache` section (replace it when a previous attempt left one): selection
cached, counts by status, failures and their causes, the port and pace that held, and how
to serve the cache offline for the analysis steps that follow.

## Done

```bash
node <skill>/scripts/status.mjs check cache
```

If it fails, fix the artefact: every selected URL needs a row with a status. Do not edit
the check and do not change the selection to make it pass.
