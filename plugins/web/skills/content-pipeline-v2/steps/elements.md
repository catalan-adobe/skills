# elements

Purpose: the **elements inventory** — every captured page decomposed into its sections,
each resolved to an element type of the source markup, with coverage and compositions.
Decomposition only; mapping a type to an EDS block is the mapping expert's work. Tier: medium.

## Inputs

- `migration/capture/` (the store, never the site: `references/local-cache.md`),
  `chrome/chrome.json`, `urls/urls.json`, `elements/rules.json` — read by the script.

## Method

1. Start the run — it returns at once: `node <skill>/scripts/elements.mjs`. One detached
   worker decomposes every capture (seconds), appends a run to the previous file (type ids
   are stable, so a run is a delta), crops every recurring type offline (minutes; only the
   missing crops) and writes `elements/elements.json`, `elements.md`, `evaluation.md` and
   the report section.
2. Do not wait for it or poll it in a loop. `status.mjs` shows `elements` as `running` with
   `crops 63/180 pages`; `elements.mjs status` has the details; `elements.mjs stop` ends it.
   Then read `elements/evaluation.md`: `## Flags`, then the crops of the recurring types you
   judge; the type sections are reference, not reading.
3. Adapt through `elements/rules.json` only (the first run wrote it, with the vocabulary
   under `_example`). **Done when every recurring type's crops show one thing an author
   placed.** A type whose crops show unrelated things stacked — a column, a row, a grid, a
   background band — is a **container** (`containers`), whatever its class says; wrappers
   nest, each one peeled shows the next; peel until none is left (an AEM site: three to
   six). A wrapper that delivers another document's content — its class or id says
   fragment, xf, include, embed — is a **fragment** (`fragments`); two identities of one
   element → `merge` (type ids); a header or footer leak → `chrome`; noise → `reject`
   (the selector as printed in the check or type sample, a node under it counts; `reject`
   also takes an identity: generated noise has one identity and a selector per page).
   `containers` and `fragments` take the **identity** as printed in the type table of
   `elements.md`, never a selector; a rule that matches nothing is a warning next run. Rerun
   `elements.mjs` and read the runs table: it says how far a change reached (types added,
   removed), not whether you are done. A wish the vocabulary cannot express is an engine
   gap: name it in the report section, do not work around it. Never edit the scripts.
4. After a new cache phase: `capture.mjs`, then `elements.mjs`. Never read the captures,
   never name types, never edit `elements.json`. `status.mjs section elements`: what you
   changed and why.

## Outputs

- `migration/elements/elements.json`: the deliverable — `types`, `pages` (sections with
  `within`, coverage, composition, rejected), `compositions`, `fragments` (the reuse),
  `groups`, `runs`, `warnings`, `limits`; `rules.json`: the site's rules, a deliverable too.
- `elements/elements.md` for the operator; `evaluation.md` + `screenshots/`: crops per type and
  variant, flags; `REPORT.md` `## elements`.

## Done

Fails while the run is open — not an error to fix. Once done: a store behind the cache
(`capture.mjs`, then `elements.mjs`); an `elements.json` older than the store or `rules.json`
(rerun); a sample not in its capture; a recurring type without crops; a missing file.

```bash
node <skill>/scripts/status.mjs check elements
```
