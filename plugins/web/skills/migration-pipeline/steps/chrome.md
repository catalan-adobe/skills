# chrome

Purpose: the shared documents the site's template places on every page — header and
footer — found from the rendered pages, written as fragments and placed on every page's
composition. Nothing leaves the machine: the pages come from the cache. Tier: medium.

## Inputs

- Cached pages still in the migration (`kind: page`, a `cache`, verdict not `out`),
  `website/access.json` (the overlay rules the capture applies), `migration/.work/
  setup.json` (the proxy, the page-tree bundle, `playwright-cli`).

## Method

1. Start the worker — the command returns at once: `node <skill>/scripts/pipeline.mjs
   chrome`. Two phases, one offline browser session. **Capture**: every readable page
   without a visual tree is rendered from the cache with the page-tree bundle injected, the
   overlay rules applied, a scroll through the page and a bounded wait for it to settle;
   its tree is stored under the page with the page's height and a full-page screenshot —
   none above 16 384 px, where a browser's picture repeats the top and loses the bottom:
   such a page is flagged `too-tall` and parked. **Detect**: elements recurring across the
   trees at a stable position at the top or bottom are the chrome; the finding is written
   in EDS terms: `website/fragments.json` grouped by part (one header is one document,
   however many bands; a second design only with a label), each fragment's composition
   (its bands as sections), every page's composition with the fragments it carries and
   where (sections stay empty — `elements` fills them), a `no-header` / `no-footer` flag
   on pages without, crops under `fragments/<id>/shots/`, and a runner note with the
   detection in words.
2. Do not wait or poll in a loop. `pipeline state --text` shows the step's progress;
   `pipeline chrome status` the run; `pipeline chrome stop` ends it. A rerun captures only
   what is missing and detects again when the trees changed.
3. Read the note (`migration.mjs notes chrome`) and look at each fragment's `page.png`
   (every band outlined) before telling the operator what the site's chrome is: which
   designs, how many pages each, which pages have none and why that may be (a campaign
   template, a page the capture misread). A header drawn over a hero image can be folded
   into the hero by the capture; a hover-only mega-menu is not in a plain render. Say what
   the note's limits say when they apply.
4. The step decides nothing: the fragments are the method's finding. An operator who
   disagrees says so in a note; the next method or an edit of `fragments.json` follows.

## Outputs

- `pages/<id>/visual-tree.json` and `shots/page.jpg` per readable page;
  `website/fragments.json`;
  `fragments/<id>/composition.json` and `shots/`; `pages/<id>/composition.json` with
  template fragments; `chrome` reasons on the table; a run; a runner note.

## Done

Fails while a run is alive, while a readable page has no tree (how many), or while the
detection is older than the trees.

```bash
node <skill>/scripts/pipeline.mjs state --text
```
