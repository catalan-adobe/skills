# elements

Purpose: the **elements inventory** — every captured page decomposed into its sections,
each section resolved to an element type of the source markup, with coverage per page and
the compositions pages share — so the experts who convert content know which elements
exist, how often, and which pages they cover. Decomposition only; naming or mapping a type
to an EDS block is the mapping expert's work. Tier: medium (a script decomposes; you read).

Everything here comes from the visual-tree store, never the site: `references/local-cache.md`.

## Inputs

- `migration/capture/` (the store), `chrome/chrome.json` (members to strip),
  `urls/urls.json` (groups), `elements/rules.json` (the site's rules, when there is one) —
  all read by the script.

## Method

1. Run it — seconds, in the foreground:

   ```bash
   node <skill>/scripts/elements.mjs
   ```

   It decomposes every capture, appends a run to the previous file (type ids are stable, so
   a run is a delta: new and removed types, new compositions, "rules changed") and writes
   `elements/elements.json`, `elements/elements.md` and the `## elements` section of
   `REPORT.md`.
2. Open `elements/elements.md`: the recurring types by support, the groups table (how many
   compositions a group has, the share of its dominant one, whether it is saturated), the
   runs, the unique tail, what was rejected, the warnings.
3. After a new cache phase run `capture.mjs` first (the check names a store behind the
   cache), then `elements.mjs` again; the runs table shows what the new pages added.
4. Never read the captures, never name types, never edit `elements.json`. Add what you saw
   with `status.mjs section elements` only when it differs from the script's summary.

## Outputs

- `migration/elements/elements.json`: the deliverable — `types` (id, identity, pages,
  support, instances, variants, sample, groups), `pages` (sections, coverage, composition,
  rejected), `compositions`, `groups` (with `saturated`), `groupsWithoutPages`, `runs`,
  `warnings`, `limits`.
- `migration/elements/elements.md`: the same for the operator; `REPORT.md` `## elements`.

## Done

Fails on a store behind the cache (`capture.mjs`, then `elements.mjs`), an `elements.json`
older than the store or than `rules.json` or disagreeing with the store (rerun
`elements.mjs`), a type whose sample selector is not in its capture, or a missing
`elements.md` or report section.

```bash
node <skill>/scripts/status.mjs check elements
```
