# elements

Purpose: the **elements inventory** — every captured page decomposed into its sections,
each resolved to an element type of the source markup, with coverage per page and the
compositions pages share — so the experts who convert content know which elements exist,
how often, and where. Decomposition only; naming or mapping a type to an EDS block is the
mapping expert's work. Tier: medium (a script decomposes; you read).

Everything here comes from the visual-tree store, never the site: `references/local-cache.md`.

## Inputs

- `migration/capture/` (the store), `chrome/chrome.json` (members to strip), `urls/urls.json`
  (groups), `elements/rules.json` (the site's rules, when there is one) — read by the script.

## Method

1. Start the run — it returns at once:

   ```bash
   node <skill>/scripts/elements.mjs
   ```

   One detached worker decomposes every capture (seconds), appends a run to the previous
   file (type ids are stable, so a run is a delta: new and removed types, new compositions,
   "rules changed"), crops the evidence for every recurring type through the offline cache
   server (minutes; only the crops not on disk yet) and writes `elements/elements.json`,
   `elements.md`, `evaluation.md` and the `## elements` section of `REPORT.md`.
2. Do not wait for it or poll it in a loop. `status.mjs` shows `elements` as `running` with
   `crops 63/180 pages`; `elements.mjs status` has the details; `elements.mjs stop` ends it.
   When done, read `elements/evaluation.md`: the flags first, then the crops of each type —
   do the three instances look like one element? do two types look alike? — then
   `elements.md` for the groups table (compositions per group, dominant share, saturated),
   the runs, the unique tail, what was rejected, the warnings.
3. After a new cache phase run `capture.mjs` first (the check names a store behind the
   cache), then `elements.mjs` again; the runs table shows what the new pages added.
4. Never read the captures, never name types, never edit `elements.json`. Add what you saw
   with `status.mjs section elements` when it differs from the script's summary.

## Outputs

- `migration/elements/elements.json`: the deliverable — `types` (id, identity, pages,
  support, instances, variants, sample, groups), `pages` (sections, coverage, composition,
  rejected), `compositions`, `groups` (with `saturated`), `groupsWithoutPages`, `runs`,
  `warnings`, `limits`.
- `migration/elements/elements.md`: the same for the operator; `REPORT.md` `## elements`.
- `migration/elements/evaluation.md` + `screenshots/`: the evidence for the eye — crops per
  type and variant, flags, the unique tail.

## Done

Fails while the run is open — not an error to fix. Once done, it fails on a store behind
the cache (`capture.mjs`, then `elements.mjs`), an `elements.json` older than the store or
than `rules.json` or disagreeing with it (rerun `elements.mjs`), a type whose sample
selector is not in its capture, a recurring type without its crops, or a missing
`elements.md`, `evaluation.md` or report section.

```bash
node <skill>/scripts/status.mjs check elements
```
