# mapping

Purpose: the **block inventory** — every recurring element type decided as a **block**
(with its EDS name), **default content**, or **skip**: what each type is in EDS terms.
Sections and fragments were decided by rules, header and footer by the chrome step. Tier: medium.

## Inputs

- `migration/elements/elements.json`, `elements/evaluation.md` + `screenshots/` (the crops
  are the evidence), `elements/elements.md` (the type table) — read by you.

## Method

1. Run `node <skill>/scripts/mapping.mjs`. The first run seeds `mapping/mapping.json`
   with every recurring type outside a fragment as `{ "kind": null }` and writes
   `mapping/mapping.md`, whose `## Undecided` lists them by identity. A container whose
   instances have no children (`## Container leaves`) is not seeded: the capture could not
   see inside; nothing to decide, and its pages stay open in `## Coverage`.
2. For each undecided type, look at its crops in `evaluation.md` and apply the typing
   test — *could an author make this in a document?* A heading, paragraphs, a list, one
   image, a link, a bare quotation: **`default-content`**. Anything with a layout of its
   own, repetition, behaviour, or a box of its own (columns of items, a carousel, tabs, a
   form, a hero, a boxed testimonial with name and logo): **`block`**, with a `block` name
   — lowercase, dashes, what the component *is*, not its class (`hero`, `cards`, `tabs`,
   `accordion`, `form`, `quote`), never `header`, `footer`, `section`, `fragment`. Two
   identities that are one component take the same name; a type that is *one item* of a
   repeated group (one card, one link) takes the group's name, note "one item — group
   consecutive siblings". Variants are the block's options; two different components
   under one type: name what the *source element is* (raw HTML: `embed`), note the
   outlier, name the engine gap in the report. Page-frame elements (a breadcrumb, a page
   title) are default content unless the site styles them as a component. **`skip`**: what
   should not be migrated as such — a tree artefact, a one-off tool — with a `notes` line
   saying why. Counts come from `elements.json` and the type table, not from three crops.
3. A type whose crops show *unrelated things stacked* is a **section**, not a block: add its
   identity to `containers` in `elements/rules.json`, rerun `elements.mjs`, then
   `mapping.mjs` (the decisions already taken are kept).
4. Edit `mapping/mapping.json` only; `notes` where a transformer author would want a word
   ("CTA optional", "3 or 4 columns"). Rerun `mapping.mjs` after every edit: it validates,
   rewrites `mapping.md`, `mapping/inventory.json` and the report section. `## Coverage`:
   the pages whose every section is mapped are what a migration can budget on.
5. Done when `## Undecided` says none and every block is named. `status.mjs section
   mapping`: what you decided and what the vocabulary could not say (an engine gap: name
   it). Never edit `elements.json`, `inventory.json` or the scripts.

## Outputs

- `migration/mapping/mapping.json`: the decisions — a deliverable; `mapping/inventory.json`:
  the block inventory (blocks with types, instances, pages, variants, sample, crops;
  default content; skipped; container leaves; coverage; undecided; orphaned);
  `mapping/mapping.md`: the same for the operator; `REPORT.md` `## mapping`.

## Done

Fails while a recurring type is undecided, a block name is invalid, the inventory was not
derived from the current `mapping.json` and `elements.json` (rerun `mapping.mjs`), or the
elements check fails (a mapping over a stale inventory maps the wrong thing).

```bash
node <skill>/scripts/status.mjs check mapping
```
