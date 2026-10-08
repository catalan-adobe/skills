# triage

Purpose: the first look at every captured page, by a System 1 model on its screenshot —
four questions and no more: a site header at the top, a site footer at the bottom, a
broken page (an error, a blank, a login or cookie wall, a bot check), an empty page
(nothing where the content should be). Beside what `chrome` found in the structure, the
answers sort the pages: the normal ones go on to be read, the odd ones are parked until
someone looks. Tier: low.

## Inputs

- `pages/<id>/shots/page.jpg` from the chrome step (a page too tall for one is already
  parked as `too-tall`); `S1_URL` and `S1_MODEL` in the environment, usually an env file:
  `node --env-file=<file> <skill>/scripts/pipeline.mjs triage` — the worker inherits it.
  `S1_API_KEY` when the deployment wants one. Never read the env file.

## Method

1. Start the worker: `node --env-file=<file> <skill>/scripts/pipeline.mjs triage`. Each
   screenshot is cut into at most four slices of 1280 × 768 (1:1 up to 3 072 px, scaled
   down above) and asked the four questions in one request; the answers are stored
   under the page with how the picture was given. Then every page's flags are set from
   its answers — `no-header`, `no-footer`, `broken`, `empty` by `triage` — beside
   `chrome`'s, and a note sorts the triaged pages into five buckets. Do not poll in a loop:
   `pipeline state --text`, `pipeline triage status`, `pipeline triage stop`.
2. Read the note (`migration.mjs notes triage`). The buckets:
   - **normal** — header and footer in the structure and in the picture, nothing broken.
   - **odd** — both say a header or a footer is missing: a page of its own kind (a
     campaign template, a landing page, a tool). Parked; say what kind it looks like.
   - **review** — structure and picture disagree. One of them is wrong about this page:
     a header drawn over a hero that the capture folded into it, a header in the DOM but
     not drawn, a footer the picture missed on a scaled-down page. Look at the
     screenshot, say which, and what follows (nothing, a page decision, a note).
   - **broken** — the picture shows an error, a blank, a wall or a bot check. Look: a
     capture defect (a cookie dialog the recipe missed, a page that needed longer) is
     fixed with `access overlay` and captured again; a real error page or a wall the site
     puts up is decided out (`decide-page <url> out <why>`).
   - **empty** — header, footer, and nothing where the content should be. Look: a listing
     a script fills from an endpoint the cache has not got, a form from another origin
     (`assets`, then `cache fill`), or a page that really is a shell (decide it).
3. The flags park; they never exclude. The operator's word on a page wins over both.
4. Look before you report, as always: three or four screenshots from the normal bucket
   too — the model is not the only reader of the page.

## Outputs

- `pages/<id>/triage.json` per page with a screenshot; `triage` reasons on the table;
  `website/website.json` refreshed; a run; a runner note with the buckets.

## Done

Fails while a run is alive, while a page with a screenshot has no triage of that picture
with these questions (a recapture, or a change to the questions, makes the old one
stale), or — with that said — while the environment names no model.

```bash
node <skill>/scripts/pipeline.mjs state --text
```
