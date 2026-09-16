# chrome

Purpose: find the site's chrome — the parts of a page that stay the same from page to page
and frame the content: the header(s) and footer(s) — as a precise, evidenced list of DOM
regions, so the experts who convert content can strip them and build the EDS header and
footer documents from them. Detection only. Tier: medium (a script detects; you look).

Everything here comes from the local cache, never the site: `references/local-cache.md`.

## Inputs

- `migration/cache/` and `urls/urls.json` (verified pages), `prep/page-prep.json` (hide
  rules), `setup.json` (page-tree, page-cache, playwright-cli) — all read by the script.
- Sibling `.agents/skills/page-tree/SKILL.md`: the capture; read only if the run `failed`.

## Method

1. Start the run — it returns at once:

   ```bash
   node <skill>/scripts/chrome.mjs
   ```

   One detached worker starts the offline cache server, renders every verified cached page
   in one browser session (proxy only, the prep step's hide rules applied) and stores its
   visual tree under `chrome/.captures/`; then it detects the elements that recur at a
   stable position, groups them into header and footer variants, screenshots each variant
   on its representative page and writes `chrome/chrome.json`, `chrome/chrome.md` and the
   `## chrome` section of `REPORT.md`. About one second per page.
2. Do not wait for it, poll it in a loop, or read the captures. Tell the operator the run
   is on and stop, or continue with another `ready` step. `status.mjs` shows `chrome` as
   `running` with `37/97 pages captured` or `analysing captures`; `chrome.mjs status` has
   the details; `chrome.mjs stop` ends the worker after its current page; a rerun captures
   only the pages without a capture and refreshes the outputs. `--force` recaptures all.
3. When `status.mjs` shows `chrome` as `done`, open `chrome/chrome.md` and look at the
   **full screenshot of every variant** (members are outlined in red). Confirm that the
   outlined regions are the header or footer, or note what is wrong — a member that is
   content, a chrome element not outlined, a variant that is really the same as another.
   Never edit `chrome.json` by hand; never name variants ("main", "blog") or rank them.
4. Read `## chrome` in `REPORT.md` (the worker wrote it). Add what you saw with
   `status.mjs section chrome` only when it differs from the worker's summary.

## Outputs

- `migration/chrome/chrome.json`: the deliverable — per role the variants (members with
  selectors and positions, pages, support, representative, group label, optional members,
  screenshots), `unplaced`, `rejected` with reasons, `without`, `limits`.
- `migration/chrome/chrome.md`: the same for the operator, with the screenshot paths.
- `migration/chrome/screenshots/`: full page per variant, one crop per member;
  `REPORT.md` `## chrome`: written by the worker.

## Done

Fails with the run's phase while it is open — not an error to fix. Once done, it fails on a
member whose selector is not in its representative's capture, a missing screenshot, or a
screenshot defect: rerun `chrome.mjs`; if it fails again, `chrome.mjs status` says why.

```bash
node <skill>/scripts/status.mjs check chrome
```
