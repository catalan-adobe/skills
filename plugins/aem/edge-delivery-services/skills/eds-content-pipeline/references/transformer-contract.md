# Transformer Contract

A deterministic transformer is a module that matches source URLs, transforms their
DOM into EDS sections, and reports metadata for a single template. Transformers live
in `migration/transformers/` and are named after their template: `product.mjs`,
`case-study.mjs`, etc.

## Export Contract

Every transformer module must export these named exports:

### `match(url, document) → boolean`

Returns true when this transformer handles the URL. The `document` parameter is
the parsed jsdom DOM; check `document.querySelector()` or URL patterns via
`new URL(url).pathname`.

**Example:**
```javascript
export function match(url) {
  return /^\/product-[a-z]+\.html$/.test(new URL(url).pathname);
}
```

### `transformDOM({ document, url, html, params }) → Element | { element, metadata?, warnings? }`

Transforms the source DOM into a new tree of EDS sections. Returns either:
- A detached DOM element (usually `<main>` or a `<div>`).
- An object with:
  - `element`: required, the detached root element.
  - `metadata`: optional object, merged with auto-extracted head metadata
    (title, description, image, canonical, publication-date).
  - `warnings`: optional array of `{ code, message }` objects, appended to
    the document's warnings.

The returned `element`'s direct `<div>` children become sections. Each section's
`data-section-*` attributes become a `section-metadata` block's rows.

**Example:**
```javascript
export function transformDOM({ document }) {
  const main = document.createElement('main');
  const hero = document.createElement('div');
  hero.append(
    document.querySelector('h1'),
    document.querySelector('.hero-image'),
  );
  main.append(hero);

  const specs = document.createElement('div');
  specs.append(Blocks.createBlock(document, {
    name: 'specifications',
    cells: [
      ['Label', 'Value'],
      ['Weight', '5 kg'],
    ],
  }));
  main.append(specs);

  return { element: main, warnings: [] };
}
```

Parameters:
- `document`: jsdom Document object; the source page.
- `url`: string, the source URL (jsdom base URL for relative links).
- `html`: string, raw source HTML (for Wistia embeds, oembed calls, etc.).
- `params`: object, template configuration from `site.config.json`
  `templates[template-name]`; e.g. `{ sourceRoot: 'main', ... }`.

### `generateDocumentPath({ document, url }) → string`

Returns the EDS document path: lowercase, no trailing slash, e.g.
`/product/acme-flight` or `/blog/2024-09-10-release`. The harness uses
`FileUtils.sanitizePath()` to normalize it further.

**Example:**
```javascript
export function generateDocumentPath({ url }) {
  return new URL(url).pathname.replace(/\.html$/, '');
}
```

### `version` (string)

Semantic version of the transformer, e.g. `'1.0.0'`. Used to detect when a
transformer changes so content can be re-run.

```javascript
export const version = '1.0.0';
```

### `needsBrowser` (boolean, optional, default: false)

Set to `true` if the transformer requires a browser to run (e.g., JavaScript
rendering, video metadata fetching). The runner will pass a live jsdom window
with a stubbed navigation API. Async transformers are supported.

```javascript
export const needsBrowser = false;
```

## Harness Behavior

After the transformer returns:

1. **Section wrapping**: `transformDOM`'s root element's direct children are
   iterated:
   - If all are `<div>`, they become sections as-is.
   - Otherwise, all children are wrapped in a single `<div>` section; a
     warning is logged.

2. **Section metadata extraction**: Each section's `data-section-*`
   attributes (e.g. `data-section-style="dark"`) are removed and become
   rows in a `section-metadata` block appended to that section.

3. **Head metadata auto-extraction**: `extractMetadata(document)` pulls:
   - `title` from `<title>` or `og:title`
   - `description` from `meta[name="description"]` or `og:description`
   - `image` from `og:image`
   - `canonical` from `link[rel="canonical"]`
   - `publication-date` from `article:published_time` (first 10 chars: YYYY-MM-DD)

   These are merged with transformer-returned `metadata`, transformer wins.

4. **Metadata block**: A `metadata` block is appended to the last section
   with the merged metadata. If `title` or `description` is missing, a
   warning is logged.

5. **Serialization**: Sections are serialized to:
   ```html
   <body>
     <header></header>
     <main>
       <div><!-- section 1 --></div>
       <div><!-- section 2 --></div>
     </main>
     <footer></footer>
   </body>
   ```

## Importer Helpers

Import from `#lib/importer.mjs`:

### `Blocks.createBlock(document, { name, variants?, cells })`

Creates a canonical EDS block: `<div class="name variant ...">` with rows of
cells. Cells are strings (text), Nodes, or arrays of both. Strings never
parse as HTML (safe from scraped content).

```javascript
Blocks.createBlock(document, {
  name: 'specifications',
  variants: ['featured'],
  cells: [
    ['Label', 'Value'],
    ['Weight', document.createElement('strong')],
  ],
});
```

### `Blocks.getMetadataBlock(document, meta)`

Builds a `metadata` block from a key/value object or Map. Drops empty values.

```javascript
Blocks.getMetadataBlock(document, {
  title: 'Product Name',
  description: 'A great product',
});
```

### `DOMUtils.remove(root, selectors)`

Removes all descendants matching CSS selectors. Returns the count removed.

```javascript
DOMUtils.remove(root, ['script', 'style', 'nav']);
```

### `DOMUtils.replaceBackgroundByImg(root, document)`

Converts `background-image` inline styles to `<img>` elements. Keeps children
when present; replaces empty holders. Returns created images in document order.

```javascript
const images = DOMUtils.replaceBackgroundByImg(section, document);
```

### `FileUtils.sanitizePath(input)`

Normalizes a URL or pathname to an EDS document path: lowercase, hyphenated,
no trailing slash. `/example.html?foo` becomes `/example`; `/` becomes `/index`.

```javascript
FileUtils.sanitizePath('https://www.example.com/Case-Study/Acme-Inc/');
// → '/case-study/acme-inc'
```

### `pickImageSrc(img, { maxWidth = 2048 })`

Picks the best srcset candidate under `maxWidth`. Falls back to `src`. Prevents
overly large originals from being served.

```javascript
const src = pickImageSrc(img, { maxWidth: 1600 });
img.setAttribute('src', src);
```

### `sectionMetadata(document, props)`

Builds a `Section Metadata` block. `style` property becomes section classes;
others become `data-*` rows.

```javascript
sectionMetadata(document, { style: 'dark', align: 'center' });
```

### `splitSections(main, breakSelectors)`

Groups `main`'s children into section `<div>`s. Opens a new section at each
element matching `breakSelectors` or at every `<hr>`. Comments and blank text
are dropped.

```javascript
splitSections(main, ['h2', '.section-break']);
```

## CLI

```bash
node ./scripts/lib/transform.mjs <url|file.html> --template <name> \
  [--url <source-url>] [--out <file>] [--params <json>]
```

- `<url|file.html>`: Source URL or file path.
- `--template <name>`: Transformer name, e.g. `product`.
- `--url <source-url>`: Required when input is a file.
- `--out <file>`: Output file (default: `site/content/<path>.html`).
- `--params <json>`: Extra transformer parameters, e.g. `'{"sourceRoot":"main"}'`.

**Example:**

```bash
node ./scripts/lib/transform.mjs \
  https://www.example.com/product-acme.html \
  --template product \
  --out /tmp/product.html
```

Prints a JSON object with `path`, `html`, `metadata`, `hash`, `bytes`,
`warnings`, `transformerVersion`.

## Worked Example

The `fixtures/example-site/migration/transformers/product.mjs` transformer
shows a complete implementation:

```javascript
import { Blocks } from '#lib/importer.mjs';

export const version = '1.0.0';
export const needsBrowser = false;

export function match(url) {
  return /^\/product-[a-z]+\.html$/.test(new URL(url).pathname);
}

export function generateDocumentPath({ url }) {
  return new URL(url).pathname.replace(/\.html$/, '');
}

export function transformDOM({ document }) {
  const warnings = [];
  const main = document.createElement('main');
  const hero = document.createElement('div');
  const src = document.querySelector('.product-hero');
  if (!src) {
    warnings.push('Missing .product-hero section');
  } else {
    hero.append(
      src.querySelector('h1'),
      src.querySelector('img'),
      src.querySelector('.price'),
      src.querySelector('.lead'),
    );
  }
  main.append(hero);
  const specs = document.createElement('div');
  const specHead = document
    .querySelector('.product-specs h2');
  if (specHead) specs.append(specHead);
  const rows = [
    ...document.querySelectorAll('table.specs tr'),
  ].map((tr) => [
    tr.querySelector('th').textContent.trim(),
    tr.querySelector('td').textContent.trim(),
  ]);
  if (rows.length > 0) {
    specs.append(
      Blocks.createBlock(document, {
        name: 'specifications',
        cells: rows,
      }),
    );
  } else {
    warnings.push(
      'No specification rows found in table.specs',
    );
  }
  main.append(specs);
  return { element: main, metadata: {}, warnings };
}
```

This transformer:
- Matches product pages via pathname pattern.
- Builds a hero section with h1, img, price, lead.
- Builds a specs section with a structured block from an HTML table.
- Returns warnings when expected elements are missing.
- Uses `Blocks.createBlock()` to generate valid EDS block markup.
