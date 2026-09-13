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
2. Start the proxy: `--port 3001 --cache migration/cache/.page-cache`.
3. Open the first URL through the proxy with `playwright-cli open --config
   migration/probe/playwright-config.json` (add `--persistent` when the recipe says so).
   Then `goto` each remaining URL through the proxy in the same session.
4. On every page: inject the `hide` rules and `scroll_fix` from `page-prep.json` in one
   `eval` before scrolling, scroll to the bottom and back for lazy content, then record
   `cached`; record `failed` with the reason on an error or a blocked page; record
   `skipped` for URLs you deliberately left out (say why). Stay at the skill's pace.
5. Read `/__status` at the end, close the browser, stop the proxy.

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

Append a `## cache` section: selection cached, counts by status, failures and their
causes, and how to serve the cache offline for the analysis steps that follow.

## Done

```bash
node <skill>/scripts/status.mjs check cache
```

If it fails, fix the artefact: every selected URL needs a row with a status. Do not edit
the check and do not change the selection to make it pass.
