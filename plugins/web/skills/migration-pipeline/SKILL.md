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
so. The process is the model's: `discover`, `access`, `cache` (gated), `chrome`, `triage`,
`elements` (gated), `blocks`, `report`. Each step has a brief in `steps/<id>.md`: hand that
one file to whoever runs the step.

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
| `access` | medium | `website/access.json`: how to open a page, verified on three |
| `cache` | low | page records' `cache`, `http`, `kind`, verdicts; `migration/cache/` |
| `chrome` | medium | visual trees, `website/fragments.json`, compositions' template fragments |
| `triage` | low | `pages/<id>/triage.json`, `triage` flags: the odd pages parked |
| `elements` | medium | `elements/types.json`, compositions' sections — coming |
| `blocks` | medium | `elements/elements.json` decisions, `elements/inventory.json` — coming |
| `report` | low | `views/report.md`, `views/report.html` |

Not a step: `pipeline sample --count 10 --write <name>` takes normal pages, one per group
in turn, as a selection to judge or to measure a method on; `migration.mjs annotate
<name>` renders the sheet a person judges them on.

## Look, then act

The commands do the mechanical work on every page; the agent's work is to look at what
they left — the screenshots, the crops, the notes, the summaries — and to act on what is
particular to this site, before reporting. Every step leaves artefacts a reader can
judge, and the data has a place for the reaction:

- an element the recipe should have hidden (a chat widget, a late banner):
  `migration.mjs access overlay <selector> hide --note "…"`, then capture again;
- a page that is not what its record says (a cookie wall, an empty template):
  `migration.mjs decide-page <url> out <why>`;
- a fact about the site the next step needs (assets on another host, a second design,
  a group that is a different product): `migration.mjs note <step> agent "…"`, and the
  setting or decision it calls for;
- what `structure` reads and how far to trust it: `references/structure-method.md` —
  level 1 measured, level 2 built and not settled, the contract proposed for it;
- a page whose picture disagrees with its reading (`misread`): `references/misread-pages.md`
  says what each detail is and the act it calls for — an asset origin to name, a reveal
  to hold open (`access rendering`), an embed to write down;
- a doubt about the method's finding: say so in the note; never edit a derived file.

What is site-specific is for the agent to notice and name; what is the same on every
site is in the commands. A step is not done because its command ran: it is done when
the artefacts were looked at and nothing seen was left unsaid.

## Rules

- Never write under `migration/` except through the two CLIs; never edit a JSON by hand.
- Never fetch pages with an HTTP client; the browser, through the recipe, is the only
  reader of the site, and only the cache step reads it.
- The operator decides at the gates and about single pages; record their words as notes.
