# mapping

Purpose: the **block inventory** — every recurring element type decided as a **block**
(with its EDS name), **default content**, or **skip**. The elements step decomposed; this
step says what each type is in EDS terms. Sections and fragments were decided there, by
rules; header and footer by the chrome step. Tier: medium (you decide from crops).

## Inputs

- `migration/elements/elements.json`, `elements/evaluation.md` and its `screenshots/`
  (the crops are the evidence), `elements/elements.md` (the type table) — read by you.

## Method

1. Run `node <skill>/scripts/mapping.mjs`. The first run seeds `mapping/mapping.json`
   with every recurring type outside a fragment as `{ "kind": null }` and writes
   `mapping/mapping.md`, whose `## Undecided` lists them by identity.
2. For each undecided type, look at its crops in `evaluation.md` and apply the typing
   test — *could an author make this in a document?* A heading, paragraphs, a list, one
   image, a link, a quote: **`default-content`**. Anything with a layout of its own,
   repetition, or behaviour (columns of items, a carousel, tabs, a form, a hero with an
   image and text side by side): **`block`**, with a `block` name — lowercase, dashes,
   what the component *is* (`hero`, `cards`, `tabs`, `accordion`, `form`), never
   `header`, `footer`, `section`, `fragment`. Two identities that are one component take
   the same name. A type's variants are that block's options unless the crops show two
   different components. Page-frame elements (a breadcrumb, a page title) are default
   content unless the site styles them as a component. **`skip`** is for what should not
   be migrated as such — a tree artefact, a one-off tool — with a `notes` line saying why.
3. A type whose crops show *unrelated things stacked* is a **section**, not a block: do not
   map it; add its identity to `containers` in `elements/rules.json`, rerun
   `elements.mjs`, then `mapping.mjs` again (the decisions already taken are kept).
4. Edit `mapping/mapping.json` only; write `notes` where a later transformer author would
   want a word (e.g. "CTA optional", "3 or 4 columns"). Rerun `mapping.mjs` after every
   edit: it validates, rewrites `mapping.md` and `mapping/inventory.json`, and the report
   section. Read `## Coverage`: the pages whose every section is mapped are the pages a
   migration can budget on; the table names what keeps the others open.
5. Done when `## Undecided` says none and every block is named. Write what you decided
   and what you could not express with `status.mjs section mapping` — a type that is
   two blocks, or one block that the vocabulary cannot say, is an engine gap: name it.
   Never edit `elements.json`, `inventory.json` or the scripts.

## Outputs

- `migration/mapping/mapping.json`: the decisions — a deliverable; `mapping/inventory.json`:
  the block inventory (blocks with types, instances, pages, variants, sample, crops;
  default content; skipped; coverage; undecided; orphaned); `mapping/mapping.md`: the
  same for the operator; `REPORT.md` `## mapping`.

## Done

Fails while a recurring type is undecided, a block name is invalid, or the inventory was
not derived from the current `mapping.json` and `elements.json` (rerun `mapping.mjs`); and
while the elements check fails (a mapping over a stale inventory maps the wrong thing).

```bash
node <skill>/scripts/status.mjs check mapping
```
