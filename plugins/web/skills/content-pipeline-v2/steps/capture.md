# capture

Purpose: fill the project's **visual-tree store** — one page-tree capture per verified cached
page, rendered from the local cache — so every later analysis of page structure (chrome,
elements) reads the same captures instead of rendering again. A script does it all.
Tier: low (start it, glance at status).

Everything here comes from the local cache, never the site: `references/local-cache.md`.

## Inputs

- `migration/cache/` and `urls/urls.json` (verified pages), `prep/page-prep.json` (hide
  rules), `setup.json` (page-tree, page-cache, playwright-cli) — all read by the script.
- Sibling `.agents/skills/page-tree/SKILL.md`: the capture; read only if the run `failed`.

## Method

1. Start the run — it returns at once:

   ```bash
   node <skill>/scripts/capture.mjs
   ```

   One detached worker starts the offline cache server, renders every verified cached page
   in one browser session (proxy only, the prep step's hide rules applied) and stores its
   visual tree under `capture/` at min-width 300 px, then writes `capture/captures.md`.
   About one second per page.
2. Do not wait for it, poll it in a loop, or read the captures. Tell the operator the run
   is on and stop, or continue with another `ready` step. `status.mjs` shows `capture` as
   `running` with `37/97 pages captured`; `capture.mjs status` has the details;
   `capture.mjs stop` ends the worker after its current page.
3. After every cache phase the store is behind the cache: `status.mjs` shows `capture` as
   `ready` again with the number of pages without a capture. Run `capture.mjs` again — a
   rerun captures only those pages. `--force` recaptures all; `--min-width <px>` changes
   the resolution (captures at another width count as stale and are redone).

## Outputs

- `migration/capture/<sha8>.json`: the store, one capture per page (gitignored).
- `migration/capture/captures.md`: the store against the cache — verified, captured,
  missing, stale, failed pages.

## Done

Fails with the run's progress while it is open — not an error to fix. Once done, it fails
on verified pages without a capture (run `capture.mjs`), captures at another min-width
(same), a failed run (`capture.mjs status` says why) or a missing `captures.md`.

```bash
node <skill>/scripts/status.mjs check capture
```
