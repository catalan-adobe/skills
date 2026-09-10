# Blocks content model (`migration/data/blocks.json`)

One record per block the migration needs. `assertBlock` (scripts/lib/shapes.mjs)
validates `name`, `status`, `model`, `templates` and `evidence`; `canonical`,
`variants` and `decisions` are informational for downstream skills and are not
validated. `scaffold-block.mjs` reads `model`; `fidelity.mjs --blocks` reads
`model.columns` and `templates`; `state.mjs check-evidence` reads `evidence`.

## Record Schema

### `name` (string, required)

Kebab-case block identifier: must start with a lowercase letter, contain
only lowercase letters, digits, and hyphens, with hyphens separating segments.
Examples: `hero`, `card-section`, `feature-list-item`. Used as the directory
name and CSS/JS class prefix.

### `status` (enum: `scaffold` | `implemented`, required)

Indicates whether the block is auto-generated from the schema (scaffold) or
hand-written by a developer (implemented). The scaffold status allows
regeneration via `scaffold-block.mjs` without overwriting real code; see the
stub contract below.

### `model` (object, required)

Describes the grid structure and column semantics.

#### `model.rows` (enum: `fixed` | `repeat`, required)

`fixed`: exactly one row (e.g., hero, breadcrumb).
`repeat`: zero or more rows (e.g., specifications, comparison table).

#### `model.columns` (array, required, non-empty)

Array of column definitions. Each column object must have:
- `name` (string): kebab-case column identifier, e.g. `label`, `value`.
- `type` (string): semantic type for content writers. Common types:
  `text`, `image`, `link`, `date`, `enum`, `html-fragment`.

Example:
```json
[
  { "name": "label", "type": "text" },
  { "name": "value", "type": "text" }
]
```

#### `model.header` (boolean, required)

`true` if the first row is a header row (e.g., table headers).
`false` if all rows are data rows.

### `templates` (object, required)

Maps each template that uses the block to the share of that template's
representative pages carrying it (0–1). Example: `{ "product": 1, "category": 0.4 }`.
`fidelity.mjs --template <t>` checks only blocks whose `templates` include `<t>`.

### `canonical` (string | null, optional)

The canonical EDS block this one maps to (`table`, `cards`, `columns`, …) or
`null` when it is site-specific. A hint for downstream block authoring.

### `variants` (string[], optional)

Block variant class tokens seen on the site (`""` is the plain block).

### `decisions` (string[], optional)

Analyst decisions that shaped the model, e.g. `"reviews tab dropped: AJAX-only"`.

### `evidence` (array, required)

Array of objects linking the block to representative captured pages.
Each evidence object should have:
- `url` (string): the URL of a page where the block appears.
- `selector` (string): a CSS selector that matches the block's root element.

`state.mjs check-evidence <template>` requires at least one evidence entry per
block to resolve on that template's capture
(`data/captures/<template>/<slug>.html`); a block with no evidence, or none that
resolves, is reported as missing and the check fails.

## Stub Contract

Blocks with `status: "scaffold"` are auto-generated structural stubs from this
content model by `scaffold-block.mjs`. The generated JavaScript and CSS files
are marked with the `STUB` marker:

```
/* STUB — structural only, generated from migration/data/blocks.json. ...
```

The implementation guarantee:
- **Structural only**: classes map column names to cells; no brand tokens
  (colors, spacing variables). The CSS contains only `display: grid`,
  `grid-template-columns`, and basic layout properties.
- **Regenerable**: A file with the marker can be regenerated without loss.
  Running `scaffold-block.mjs --name <block>` again overwrites any changes.
- **Protected**: A file without the marker is considered "real" (hand-written);
  `scaffold-block.mjs` refuses to overwrite it unless `--force` is passed.

## Example

```json
{
  "name": "specifications",
  "canonical": "table",
  "status": "scaffold",
  "variants": [""],
  "model": {
    "rows": "repeat",
    "columns": [
      { "name": "label", "type": "text" },
      { "name": "value", "type": "text" }
    ],
    "header": false
  },
  "templates": {
    "product": 1
  },
  "evidence": [
    {
      "url": "https://example.com/products/widget",
      "selector": ".specifications"
    }
  ],
  "decisions": []
}
```
