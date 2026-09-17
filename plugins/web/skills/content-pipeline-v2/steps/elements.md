# elements

Purpose: the **elements inventory** — every captured page decomposed into its sections,
each resolved to an element type of the source markup, with coverage per page and the
compositions pages share. Decomposition only; naming or mapping a type to an EDS block is
the mapping expert's work. Tier: medium (a script decomposes; you read and adapt rules).

## Inputs

- `migration/capture/` (the store, never the site: `references/local-cache.md`),
  `chrome/chrome.json`, `urls/urls.json`, `elements/rules.json` — read by the script.

## Method

1. Start the run — it returns at once:

   ```bash
   node <skill>/scripts/elements.mjs
   ```

   One detached worker decomposes every capture (seconds), appends a run to the previous
   file (type ids are stable, so a run is a delta), crops the evidence for every recurring
   type through the offline cache server (minutes; only the crops not on disk yet) and
   writes `elements/elements.json`, `elements.md`, `evaluation.md`, the report section.
2. Do not wait for it or poll it in a loop. `status.mjs` shows `elements` as `running` with
   `crops 63/180 pages`; `elements.mjs status` has the details; `elements.mjs stop` ends it.
   When done, read `elements/evaluation.md`: the flags first, then the crops of each type —
   do the three instances look like one element? do two types look alike?
3. Adapt through `elements/rules.json` only (the first run wrote it, with the vocabulary
   under `_example`): a type whose instances are whole page columns is a **container**
   (`containers`); a wrapper that delivers another document's content is a **fragment**
   (`fragments`); two identities of one element → `merge`; a chrome leak → `chrome`; noise →
   `reject`. Run `elements.mjs` again and read the runs table in `elements.md`: the run says
   "rules changed" with the types added and removed. Two or three iterations is normal.
   A wish the vocabulary cannot express is an engine gap: name it in the report section,
   do not work around it. Never edit the scripts.
4. After a new cache phase run `capture.mjs` first (the check names a store behind the
   cache), then `elements.mjs` again; the runs table shows what the new pages added.
5. Never read the captures, never name types, never edit `elements.json`. Write what you
   changed and why with `status.mjs section elements`.

## Outputs

- `migration/elements/elements.json`: the deliverable — `types`, `pages` (sections with
  `within`, coverage, composition, rejected), `compositions`, `fragments` (distinct contents
  per fragment: the reuse), `groups` (with `saturated`), `groupsWithoutPages`, `runs`,
  `warnings`, `limits`. `rules.json`: the site's rules, a deliverable too.
- `migration/elements/elements.md`: for the operator; `migration/elements/evaluation.md` +
  `screenshots/`: the evidence — crops per type and variant, flags; `REPORT.md` `## elements`.

## Done

Fails while the run is open — not an error to fix. Once done, it fails on a store behind
the cache (`capture.mjs`, then `elements.mjs`), an `elements.json` older than the store or
`rules.json` or disagreeing with it (rerun), a sample selector not in its capture, a
recurring type without its crops, or a missing `elements.md`, `evaluation.md` or section.

```bash
node <skill>/scripts/status.mjs check elements
```
