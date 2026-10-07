---
name: migration-data
license: Apache-2.0
compatibility: Requires Node >= 22. No runtime dependency.
description: >-
  The data layer of a website migration: the files under migration/ (the migration, its
  runs and state, the website, the pages and their compositions, the elements and
  blocks, notes and views), each with a schema and a class, read and written through one
  library and one CLI so that skills, scripts, dashboards and services share the same
  data. Triggers on: migration data, migration state, migration runs, migration.json,
  migration store, data layer.
---

# migration-data

The migration's data, first-class. Everything a migration knows, decides and produces
lives under `migration/` as JSON with a stated schema and a class; Markdown exists only
as a note or a view and is referenced from JSON. Skills are clients of this layer, as a
CLI or a service would be.

## Principles

- **One home per fact**; everything else that shows it is a view, regenerated.
- **Every file has a class**: *decision* (a person's, irreplaceable), *raw* (input, read
  once), *derived* (rebuilt from the cache and the decisions), *run* (one execution),
  *history* (append-only), *evidence*, *view*. The cache and the decisions are the
  migration; the rest is rebuilt.
- **Ids everywhere**: a three-letter prefix and twelve hex of a sha1 — `mig-`, `pag-`,
  `typ-`, `chr-`, `frg-`, `sel-`, `not-`; runs are `run-<time>-<step>`.
- **Every file states its schema** (`<name>@<version>`); reads and writes validate.
- **Every derived file has a `summary`** in words; a run's says what it did.
- **Process state is derived** from the data, the runs and the approvals.

## Files, so far

```text
migration/
  migration.json     source, target, plan, settings, approvals          decision
  state.json         every step's state, computed                      derived
  runs/<id>.json     one execution of a step, kept                      run → history
```

The process a migration goes through: `discover`, `access`, `cache` (gated), `chrome`,
`elements` (gated), `blocks`, `report`. A gated step waits for `migration approve`.

## CLI

```bash
node <skill>/scripts/migration.mjs init --origin <url> [--scope <url>] [--pages <n>]
node <skill>/scripts/migration.mjs show | plan [--pages n] [--selection name]
node <skill>/scripts/migration.mjs approve <step> [<selection>...]
node <skill>/scripts/migration.mjs runs [--step <id>] | state [--text]
```

JSON on stdout; `--text` for people; errors on stderr, exit 1. Run from the folder that
holds `migration/`.

## Library

`scripts/lib/`: `schema.mjs` (registry, validator), `store.mjs` (`openStore(cwd)`:
validated reads, atomic writes, ids), `migration.mjs` (`init`, `open`, `setting`, `plan`,
`approve`), `runs.mjs` (`start`, `update`, `finish`, `list`, `newest`, `liveness`),
`state.mjs` (`STEPS`, `compute(cwd, checks)`, `write`, `asText`). A client that owns a
step's data supplies its done-check: `checks[step] = async (cwd) => ({ pass, note })`.

## Status

Unit 2 of the model done: store, schemas, migration, runs, state, CLI. Next: pages,
website, elements, notes and views; then the pipeline skill as a client.
