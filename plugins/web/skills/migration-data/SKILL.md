---
name: migration-data
license: Apache-2.0
compatibility: Requires Node >= 22. No runtime dependency.
description: >-
  The data layer of a website migration: the files under migration/ (the migration, its
  runs and state, the website and its shared documents, the pages with their verdicts and
  compositions, the element types and what they are in EDS terms, notes and views), each
  with a schema and a class, read and written through one library and one CLI so that
  skills, scripts, dashboards and services share the same data. Triggers on: migration
  data, migration state, migration runs, migration.json, migration store, data layer,
  page table, block inventory, fragments, element types.
---

# migration-data

The migration's data, first-class. Everything a migration knows, decides and produces
lives under `migration/` as JSON with a stated schema and a class; Markdown exists only
as a note or a view and is referenced from JSON. Skills are clients of this layer, as the
CLI is and a service would be. The model: `references/data-model.md`.

## Principles

- **One home per fact**; everything else that shows it is a view, regenerated.
- **Every file has a class**: *decision* (a person's, irreplaceable), *raw* (input, read
  once), *derived* (rebuilt from the cache and the decisions), *run*, *history*,
  *evidence*, *view*. The cache and the decisions are the migration; the rest is rebuilt.
- **Ids everywhere**: a three-letter prefix and twelve hex — `mig-`, `pag-`, `typ-`,
  `frg-`, `sel-`, `not-`; runs are `run-<time>-<step>`. References are by id.
- **Every file states its schema** (`<name>@<version>`); reads and writes validate.
- **Every derived file has a `summary`** in words.
- **Membership points from the page to the site**: a page lists the fragments it uses and
  the types on it; the site files define them. "Pages using X" is a query.
- **Compositions are documents in EDS shape**: template fragments, sections, items
  (content, block, fragment), omitted — one schema for any decomposition method.

## Files

```text
migration/
  migration.json                  source, target, plan, settings, approvals     decision
  state.json                      every step's state, summary                   derived
  runs/<id>.json                  one execution, kept                           run → history
  website/website.json            discovery, counts, groups                     derived
  website/access.json             how to open a page                            decision
  website/fragments.json          shared documents: header, footer, inline      derived
  pages/pages.json                one record per URL, verdict with reasons      derived+facts
  pages/decisions.json            the operator's word on pages                  decision
  pages/selections/<name>.json    frozen page ids + criteria                    decision
  pages/<id>/composition.json     the page in EDS shape                         derived
  fragments/<id>/composition.json a shared document in EDS shape                derived
  elements/types.json             the vocabulary a method found                 derived
  elements/elements.json          what each type is: six kinds                  decision
  elements/methods/<name>.json    a method's knobs                              decision
  elements/inventory.json         blocks, sections, fragments, …, coverage      derived
  notes/notes.json + <id>.md      every piece of prose                          history
  views/views.json + <name>.md    rendered documents                            derived
```

The process: `discover`, `access`, `cache` (gated), `chrome`, `elements` (gated),
`blocks`, `report`. A gated step waits for `migration approve <step>`.

## CLI

```bash
M=<skill>/scripts/migration.mjs
node $M init --origin <url> [--scope <url>] [--pages <n>] [--skills-ref <ref>]
node $M show | plan [--pages n] [--selection name] | approve <step> [<selection>...]
node $M runs [--step <id>] | state [--text]
node $M pages [--group g] [--status in|out|undecided] [--reason code] [--cached] [--text]
node $M page <id-or-url> | decide-page <id-or-url> in|out <reason...> | selections
node $M website | types [--undecided] | decide-type <typ-id> <kind> [<name>] | inventory
node $M note <step> <author> <text...> [--page <pag-id>] | notes [--step] | report
```

JSON on stdout, `--text` for people, errors on stderr with the usage, exit 1. Run from the
folder that holds `migration/`.

## Library

`scripts/lib/`, one module per unit; see `references/data-model.md` §4. A client that
owns a step's data supplies its done-check to `state.compute`:
`checks[step] = async (cwd) => ({ pass, note })`.
