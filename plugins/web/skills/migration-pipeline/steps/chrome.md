# chrome

Purpose: the shared documents the site's template places on every page — header and
footer — found from the rendered pages, written as fragments and placed on every page's
composition. Nothing leaves the machine: the pages come from the cache. Tier: medium.

## Inputs

- Cached pages still in the migration (`kind: page`, a `cache`, verdict not `out`);
  `website/access.json` (overlay rules); `migration/.work/setup.json` (the tools).

## Method

1. Start the worker — the command returns at once: `node <skill>/scripts/pipeline.mjs
   chrome`. Two phases, offline browser sessions. **Capture**: every readable page without
   a current visual tree is rendered from the cache with the page-tree bundle injected and
   the overlay rules applied; its tree is stored under the page with its height and a
   full-page screenshot — none above 16 384 px (a browser's picture breaks there): such a
   page is flagged `too-tall` and parked. **Detect**: elements recurring across the trees
   at a stable place at the top or bottom are the chrome; written in EDS terms:
   `website/fragments.json` by part (one header is one document, however many bands),
   each fragment's composition (bands as sections), every page's composition with the
   fragments it carries (sections stay empty — `elements` fills them), `no-header` /
   `no-footer` flags, crops under `fragments/<id>/shots/`, the body crop per page, a note.
2. Do not wait or poll in a loop. `pipeline state --text` shows the step's progress;
   `pipeline chrome status` the run; `pipeline chrome stop` ends it. A rerun captures only
   what is missing and detects again when the trees changed.
3. Look before you report. Read the note (`migration.mjs notes chrome`), each fragment's
   `page.png` (every band outlined) and three or four pages' `shots/page.jpg` from
   different groups. Tell the operator what the site's chrome is — designs, pages each,
   pages with none and why (a campaign template, a misread capture) — and what the
   pictures show about the capture: an element over the content the recipe should hide
   (`access overlay`, then capture again), images from an origin not yet named, a page
   that is not a page. A hover-only mega-menu is not in a plain render.
4. The rules propose; you choose. `website/chrome-candidates.json` (and the report's
   "Chrome candidates") lists what recurs across the pages with a crop and the numbers
   the rules read — support, width, text stability, height — and the rules' verdict. Read
   it as a person would the crops: is that the site's header, the whole of it, nothing
   more? Two or three designs of one part are usually one header at two DOM positions;
   a band of stable text touching the footer (a "latest news", a feedback box) is
   content, not footer. When the rules are wrong, say so with the ids: `pipeline chrome
   choose header <id> [<id>…] --by <your model> --note "…"` (`footer`; `none` when the
   site has no such part), then `pipeline chrome` again: the choice is part of what a
   detection is of. When they are right, say that too in your note. Never edit
   `fragments.json`: the choice is the decision, the fragments follow from it.

## Outputs

- `pages/<id>/visual-tree.json`, `shots/page.jpg`, `shots/body.jpg` per readable page;
  `website/fragments.json`, `website/chrome-candidates.json` (+ crops); `fragments/<id>/`;
  `pages/<id>/composition.json` with template fragments; `chrome` reasons; a run; a note.

## Done

Fails while a run is alive, while a readable page has no current tree (how many), or
while the detection is older than the trees, the method or the choice.

```bash
node <skill>/scripts/pipeline.mjs state --text
```
