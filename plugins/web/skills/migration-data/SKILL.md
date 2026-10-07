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
lives under `migration/` as JSON with a stated schema and class; Markdown exists only as
a note or a view and is referenced from JSON. Skills are clients of this layer, as a CLI
or a service would be.

Model: `docs/superpowers/specs/2026-09-22-migration-data-model.md` in the worktree that
drives this work (to be moved into `references/` here when the layer is complete).

## Library

`scripts/lib/`:

- `schema.mjs` — the schema registry (`<name>@<version>`, a class per schema) and the
  validator; every read and write goes through it.
- `store.mjs` — `openStore(cwd)`: validated reads, validated atomic writes, ids.

## Status

Unit 2 in progress: store and schemas landed; migration, runs, state and the CLI follow.
