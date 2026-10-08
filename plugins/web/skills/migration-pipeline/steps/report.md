# report

Purpose: the migration on one page for people — `views/report.md` in words and
`views/report.html` as one file that opens from disk: state, website, pages, shared
documents with their crops, elements, runs, every note. Rendered from the data; never
edited. Tier: low.

## Inputs

- Everything under `migration/`: the views are rendered from the data and the notes as
  they are. Nothing is required beyond `migration.json`; what is absent is said to be.

## Method

1. `node <skill>/scripts/pipeline.mjs report` — both views in well under a second.
2. Open `migration/views/report.html` in a browser (a file URL works: no server, no
   script). Images come from `fragments/<id>/shots/` by relative path.
3. The report is a view, not a place to write: say what you have to say as a note
   (`migration.mjs note <step> <author> …`) and render again.
4. Render again whenever a step wrote: the check turns the step stale as soon as the data
   is newer than the view.

## Outputs

- `views/report.md`, `views/report.html`, indexed in `views/views.json` with what they
  were rendered from and when.

## Done

Fails while no report exists, or while any file it was rendered from is newer than it.

```bash
node <skill>/scripts/pipeline.mjs state --text
```
