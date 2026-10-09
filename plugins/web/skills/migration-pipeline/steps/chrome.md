# chrome

Purpose: the shared documents the site's template places on every page — header and
footer — found from the rendered pages, written as fragments and placed on every page's
composition; and the capture itself checked against its pictures. Offline. Tier: medium.

## Inputs

- Cached pages still in the migration (`kind: page`, a `cache`, verdict not `out`);
  `website/access.json` (overlay rules); `migration/.work/setup.json` (the tools).

## Method

1. Start the worker — the command returns at once: `node <skill>/scripts/pipeline.mjs
   chrome`. **Capture**: every readable page without a current visual tree is rendered
   offline from the cache, page-tree bundle injected, overlay rules applied; its tree,
   band capture, height and full-page screenshot are stored under the page — none above
   16 384 px (a browser's picture breaks there): such a page is `too-tall` and parked.
   **Detect**: elements recurring across the trees at a stable place at the top or bottom
   are the chrome, in EDS terms: `website/fragments.json` by part (one header is one
   document, however many bands), each fragment's and each page's composition (sections
   stay empty — `elements` fills them), `no-header` / `no-footer` flags, crops, the body
   crop per page, a note. Then **the picture checks the reading**: the screenshot against
   what the DOM claims is painted; where they disagree the page is `misread`, told why.
2. Do not wait or poll in a loop. `pipeline state --text` shows the step's progress,
   `pipeline chrome status` the run, `stop` ends it. A rerun does only what is stale.
3. Look before you report. Read the note (`migration.mjs notes chrome`), each fragment's
   `page.png` (every band outlined), three or four pages' `shots/page.jpg` from different
   groups, and every `misread` page (the report's "Picture"): that is where the capture
   is wrong on this site — a broken image (its host named), an embed not rendered
   offline, a body revealed on scroll. Tell the operator what the site's chrome is —
   designs, pages each, pages with none and why — and what the pictures show about the
   capture. What the recipe can fix, fix and capture again: an overlay (`access
   overlay`), an asset origin (`assets`, then `cache fill`), a reveal held closed
   (`access rendering "<css>"`); what it cannot, write down for the next level.
4. The rules propose; you choose. `website/chrome-candidates.json` (the report's "Chrome
   candidates") lists what recurs across the pages with a crop, the numbers the rules
   read — support, width, text stability, height — and their verdict. Read the crops as
   a person would: is that the site's header, the whole of it, nothing more? Two designs
   of one part are usually one header at two DOM positions; a band of stable text
   touching the footer (a "latest news", a feedback box) is content. When the rules are
   wrong, say so with the ids: `pipeline chrome choose header <id> [<id>…] --by <your
   model> --note "…"` (`footer`; `none` for a site without), then `pipeline chrome` again:
   the choice is an input of the detection. Never edit `fragments.json`.

## Outputs

- Per readable page: `visual-tree.json`, `band-capture.json`, `pixel-check.json`,
  `composition.json` (template fragments), `shots/page.jpg`, `shots/body.jpg`;
  `website/fragments.json`, `website/chrome-candidates.json` (+ crops); `fragments/<id>/`;
  `chrome` and `pixels` reasons; a run; a note.

## Done

Fails while a run is alive, while a readable page has no current tree (how many), or while
the detection or a picture check is older than its inputs.

```bash
node <skill>/scripts/pipeline.mjs state --text
```
