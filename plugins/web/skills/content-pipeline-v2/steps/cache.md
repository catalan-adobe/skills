# cache

Run only after `status.mjs approve cache <subset>...|all`: `status.mjs` must show `cache` as
`ready`, not `waiting-operator`. Purpose: store the selected pages and their same-origin
assets on disk so later analysis works offline, in the background. Tier: low.

## Inputs

- `migration/project.json` (`cacheSelection`), `urls/urls.json` or `urls/subsets/<name>.txt`,
  `probe/*.json`, `prep/page-prep.json`, `setup.json` — all read by the driver, none by you.
- Sibling `.agents/skills/page-cache/SKILL.md`: the proxy; read only if a job `failed`.
## Method

1. If the operator asked for a number of pages rather than a subset, build the subset first:
   `node <skill>/scripts/status.mjs pick --count <n> --write <name>` (reachable HTML pages,
   round-robin over the URL groups, one page shape at a time; once an elements inventory
   exists, saturated groups are skipped — `--audit 5` adds a few pages from any group as a
   check), then `status.mjs approve cache <name>`.
2. Queue the job — the command returns at once:

   ```bash
   node <skill>/scripts/warm.mjs [--pace 1500]
   ```

   It records a job for the approved selection under `migration/.work/warm/` and starts one
   detached worker unless one is running; a second selection queues behind the first. The
   worker visits every URL through the page-cache proxy in one browser session, verifies each
   from the cache, records it in `urls/urls.json`, then writes `cache/cache.md` and the section.
3. Do not wait for it, poll it in a loop, or run the worker yourself. Tell the operator the
   job is queued and stop, or continue with another `ready` step. `status.mjs` shows `cache`
   as `running` with `12/50 (blogs) · queued: ja-jp`; `warm.mjs status` lists the jobs;
   `warm.mjs stop` ends the worker after its current URL. `report` waits for the queue.
4. The next phase is the same two commands: `status.mjs approve cache <subset>` then
   `warm.mjs`. A rerun of a `stopped`, `interrupted` or `failed` selection visits only what
   is not cached yet (`--force` visits all). Every visited URL's record carries `http`,
   `redirect`, `finalUrl`, `kind` (page, binary, redirect, error, unreachable), `migrate` and
   `cache`. A source 404 is a stored response of kind `error`, not a failure; `failed` means
   no response — say so; do not retry by other means. Never fetch pages with `curl` or any
   HTTP client to "warm" the cache: only a browser requests the CSS, scripts and images.
5. Never delete anything under `migration/cache/`; the proxy fetches only what is missing.
   The cached HTML is the raw response; consumers apply the recipe at render time.

## Outputs
- `migration/cache/.page-cache/`: the proxy's cache directory (gitignored).
- `migration/cache/cache.md`: every visited URL across all selections with `cached` or
  `failed`, its `kind` and selection, the proxy status and the settings.
- `migration/urls/urls.json`: the visited records augmented; `urls/urls.md` refreshed.
- `REPORT.md` `## cache`: written by the worker after each job; add with
  `status.mjs section cache` only if the operator needs more.

## Done

Fails with the progress label while a job is open — not an error to fix. Once the queue is
empty, a missing body or asset means the worker did not finish: rerun `warm.mjs`, read
`warm.mjs status`; never edit `cache.md` by hand. From here on the site is read from the
cache, never from the origin: `references/local-cache.md` (`status.mjs cache ls|get|url`).

```bash
node <skill>/scripts/status.mjs check cache
```
