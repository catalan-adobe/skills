---
name: migration-pipeline
license: Apache-2.0
compatibility: Requires Node >= 22 and the migration-data skill beside it (setup installs the rest).
description: >-
  The analysis phase of a website migration to EDS, as a client of the migration-data
  layer: discover the site's URLs, learn how to open its pages, cache the selected pages,
  find the shared documents (header, footer, fragments), decompose pages into element
  types, decide what each is in EDS terms, report — every step a brief for an agent and a
  command that writes through the layer, every step done when its outcome is in the data.
  Triggers on: migration analysis, analyse a site for migration, migration pipeline,
  discover URLs, cache the site, block inventory, migration report.
---

# migration-pipeline

The pipeline is a client of `migration-data`: it reads and writes `migration/` only through
that layer, and a step is done when the layer's state says so — never when an agent says
so. The process is the model's: `discover`, `access`, `cache` (gated), `chrome`, `elements`
(gated), `blocks`, `report`. Each step has a brief in `steps/<id>.md`: hand that one file
to whoever runs the step.

## Quick start

```bash
D=<migration-data skill>/scripts/migration.mjs
P=<this skill>/scripts/pipeline.mjs
node $D init --origin <site root url> [--pages <n>] [--skills-ref <ref>]
node $P setup --install
node $P state --text
```

`setup --install` puts `playwright-cli`, the crawler and the sibling skills in project
scope (`migration/.work/`, `.agents/skills/`), from the source `migration.json` names,
and records what it installed and from where under `migration/.work/setup.json`. Then
follow `state --text`: run the first `ready` step's brief; a `waiting-operator` step
waits for `migration.mjs approve <step>`.

## Steps

| id | tier | what it writes |
| --- | --- | --- |
| `discover` | low | `pages/pages.json`, `website/website.json`, a note with the proposal |
| `access` | medium | `website/access.json` — coming |
| `cache` | low | page records' `cache`, through the page-cache proxy — coming |
| `chrome` | medium | `website/fragments.json`, compositions' template fragments — coming |
| `elements` | medium | `elements/types.json`, compositions' sections — coming |
| `blocks` | medium | `elements/elements.json` decisions, `elements/inventory.json` — coming |
| `report` | medium | `views/report.md` — coming |

## Rules

- Never write under `migration/` except through the two CLIs; never edit a JSON by hand.
- Never fetch pages with an HTTP client; the browser, through the recipe, is the only
  reader of the site, and only the cache step reads it.
- The operator decides at the gates and about single pages; record their words as notes.
