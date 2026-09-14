# cache

Run only after `status.mjs approve cache <subset>...|all`: `status.mjs` must show `cache` as
`ready`, not `waiting-operator`. Purpose: store the selected pages and their same-origin
assets on disk so later analysis works offline. Tier: low.

## Inputs
- `migration/project.json` (`cacheSelection`), `urls/urls.json` or `urls/subsets/<name>.txt`,
  `probe/playwright-config.json`, `probe/browser-recipe.json`, `prep/page-prep.json`,
  `setup.json` — all read by the driver, none by you.
- Sibling skill `.agents/skills/page-cache/SKILL.md`: the proxy the driver starts; read it
  only when the driver fails and its message points there.

## Method

1. If the operator asked for a number of pages rather than a subset, build the subset first:
   `node <skill>/scripts/status.mjs pick --count <n> --write <name>` (reachable HTML pages,
   round-robin over the URL groups, no duplicates), then `status.mjs approve cache <name>`.
2. Run the driver from the project root, in the foreground, and wait for it:

   ```bash
   node <skill>/scripts/warm.mjs [--pace 1500]
   ```

   It starts the page-cache proxy on a free port, opens the first URL with the probe
   configuration and visits every selected URL through the proxy in one browser session,
   injecting the overlay hide rules and scrolling for lazy content; then it restarts the
   proxy offline, requests every URL from the cache, writes `cache/cache.md` and the
   `## cache` report section, and exits 1 when a URL failed or no asset was stored.
3. Read its JSON: `cached`, `failed`, `assets`. A failed URL is a source problem (404,
   blocked) — say so; do not retry by other means. Never fetch pages with `curl` or any HTTP
   client to "warm" the cache: only a browser requests the CSS, scripts and images, and the
   check rejects a cache without them.
4. Never delete anything under `migration/cache/`; a second run of the driver is idempotent
   (the proxy serves stored files and fetches only what is missing).

The cached HTML is the raw response: overlay markup is still in it. The hide rules only make
the browser load what a reader sees; consumers apply the recipe at render time.

## Outputs

- `migration/cache/.page-cache/`: the proxy's cache directory (gitignored).
- `migration/cache/cache.md`: written by the driver — one row per selected URL with
  `cached`, `failed` or `skipped`, the proxy status and the settings that held.
- `REPORT.md` `## cache`: written by the driver; add a sentence with
  `status.mjs section cache` only if the operator needs more (e.g. a failed URL's cause).

## Done

```bash
node <skill>/scripts/status.mjs check cache
```

If it fails, fix the artefact: a missing body or asset means the driver did not finish —
run it again and read its message; do not edit `cache.md` by hand.
