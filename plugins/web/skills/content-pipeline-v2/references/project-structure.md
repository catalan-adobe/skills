# Project structure

Everything lives under `migration/` in the folder where the agent runs. A step writes only
its own directory plus its `REPORT.md` section; re-running a step overwrites that directory
and nothing else. `status.mjs` recomputes every state from these files, so `project.json`
never records a step as done and can be deleted and recreated with `status.mjs init`;
approvals must be given again.

## Root

`project.json`
: Written by `status.mjs init` (`origin`, `created`, `cacheAllUpTo`) and by
  `status.mjs approve` (`approved`, `cacheSelection`).
: Read by every step for `origin`, by `status.mjs` for the cache gate and by
  `check cache` for the selection.

`.gitignore`
: Written by `status.mjs init` (`.work/`, `cache/.page-cache/`). Read by git.

`setup.json`
: Written by `status.mjs setup [--install]`: the resolved `playwrightCli.path`, package
  and skill paths.
: Read by every brief to locate the binary and the sibling skills. `check setup` ignores
  it and re-runs the detection.

`REPORT.md`
: Every step appends its `## <step>` section; `report` adds the header and `## next`.
: Read by `check report`, the operator and the analysis skills that follow.

## probe/

`probe/probe-report.json`
: Written by the browser-probe script during `probe`. Read by `probe`.

`probe/browser-recipe.json`
: Written by `probe`. Read by `check probe`; by `prep`, `prep-verify` and `cache` for
  `persistent`; by later skills.

`probe/playwright-config.json`, `probe/stealth-init.js`
: Written by `probe` (the script only when stealth was needed). Read by `prep`,
  `prep-verify` and `cache` through `playwright-cli open --config`.

`probe/probe.md`
: Written by `probe`. Read by `check probe`, by `scan` (blocked-fetch warning), by `report`.

## prep/

`prep/page-prep.json`
: Written by `prep`, extended by `prep-verify` (`checked`, `overlays`).
: Read by `check prep` and `check prep-verify`; by `cache` for `hide` and `scroll_fix`;
  by later skills.

`prep/prep.md`
: Written by `prep`; `prep-verify` adds a `## verify` section. Read by `report`.

## urls/

`urls/scan.json`
: Written by the scan snippet during `scan`: the crawler's raw `URLExtended[]`.
: Read by `status.mjs urls`, which merges it into the inventory.

`urls/urls.json`
: The URL inventory: one record per URL for the whole project. Written only by the runner
  (`status.mjs urls` merges crawls and operator lists; `warm.mjs` adds what the cache visit
  learned: `http`, `redirect`, `finalUrl`, `kind`, `migrate`, `cache`). Records are never
  deleted; a URL missing from the latest crawl carries `inLastScan: false`.
: Read by `check scan`, `status.mjs urls`/`pick`, `prep-verify`, `cache` and later skills.

`urls/urls.md`
: Written by `status.mjs urls`. Read by `check scan`, by the agent for the proposal
  sentence, by `report`.

`urls/subsets/<prefix>.txt`
: Written by `status.mjs urls`, only when the total exceeds `cacheAllUpTo`.
: Read by `status.mjs approve cache <name>`, `check cache` and `cache`.

## cache/

`cache/.page-cache/`
: Written by the page-cache proxy during `cache` (gitignored).
: Read by later skills through the proxy in offline mode.

`cache/cache.md`
: Written by `cache`: one row per selected URL with `cached`, `failed` or `skipped`.
: Read by `check cache` and `report`.

## .work/

`.work/node_modules/`
: Written by `status.mjs setup --install` (npm `--prefix`).
: Read by the `setup` detection, by `scan` for `franklin-bulk-shared`, and by every
  browser step for the `playwright-cli` binary when it is not on `PATH`.

`.work/scan.mjs`
: Written and run by `scan`.

`.work/` (anything else)
: Browser profiles and scratch from any step; read only by the step that wrote it.

## Outside migration/

`setup --install` places the sibling skills under `.agents/skills/<name>/` when they are
not already found there, under `.claude/skills/` or under `~/.agents/skills/`.
