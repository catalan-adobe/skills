# brand-setup Skill

Extract brand identity from any URL and optionally configure an AEM Edge
Delivery Services project with the extracted brand (fonts, favicons,
colors, typography, spacing).

## Problem

The migrate-header polish loop compares rendered headers against source
screenshots via pixelmatch. Without the source site's actual fonts
installed in the EDS project, font rendering differences create permanent
pixel mismatches that no CSS adjustment can fix. On AstraZeneca, the
source uses Lexia (via Typekit) but the EDS project renders with
Helvetica Neue — 5 of 10 polish iterations were spent on values that
accurate brand extraction would have provided upfront.

## Approach

A standalone skill that:

1. Extracts brand data from a URL (favicons, font sources via DOM;
   colors, typography, spacing via CDP)
2. Resolves font delivery (Typekit → Google Fonts → fallback kit → lookup)
3. Optionally configures an EDS project (head.html, brand.css, styles.css)

The skill is independent — usable by migrate-header, migrate-page, or
any EDS migration task. The EDS configuration step is optional and
controlled by the caller.

## Extraction

Two extraction methods, combined into one `brand.json`:

### DOM extraction (browser IIFE: `brand-extract-dom.js`)

Ported from `/Users/catalan/repos/ai/aemcoder/skills/migration/migrate-page/scripts/brand-extract.js`.
Proven working in production. Extracts:

- **Favicons** — all `<link rel="icon">` tags, resolved to absolute URLs.
  Falls back to `/favicon.ico` if none found.
- **Font sources** — Typekit kit IDs from `use.typekit.net/{id}.css`
  stylesheet links; Google Fonts URLs from `fonts.googleapis.com` links.

### CDP extraction (via `css-query.js` from migrate-header)

Uses the on-demand CSS query tool for authored values with provenance:

- **Body font** — query `body` or `main p` for `font-family`
- **Heading font** — query `h1, h2, h3` for `font-family`
- **Base colors** — query `body` for `background-color`, `color`;
  walk ancestors if transparent
- **Link color** — query `main a` for `color`
- **Link hover color** — force `:hover` pseudo-state via CDP
- **Heading sizes** — query `h1` through `h6` for `font-size`
- **Section padding** — query `section` or `main` for `padding-top`
- **Content max-width** — query container elements for `max-width`
- **Nav height** — query `nav` or `header` for `height`

Wait for `document.fonts.ready` before querying `font-family` to catch
async-loaded typefaces (Typekit, Google Fonts).

## Font Resolution

Cascade (first match wins) for each detected font (body + heading):

1. **Source Typekit kit** — `brand.fonts.sources.typekit` has a kit ID →
   use `https://use.typekit.net/{id}.css`
2. **Source Google Fonts** — `brand.fonts.sources.googleFonts` has URLs →
   use them directly
3. **Fallback Typekit kit `cwm0xxe`** — check
   `https://typekit.com/api/v1/json/kits/cwm0xxe/published` (public API).
   If the font family appears → use `https://use.typekit.net/cwm0xxe.css`
4. **Google Fonts lookup** — fetch
   `https://fonts.googleapis.com/css2?family={FontName}:wght@400;700&display=swap`.
   If 200 OK → use that URL
5. **System fallback** — use extracted font name with generic fallback

Resolution result in `brand.json`:

```json
{
  "body": {
    "family": "Lexia",
    "stack": "lexia, serif",
    "delivery": "typekit",
    "url": "https://use.typekit.net/cwm0xxe.css"
  },
  "heading": {
    "family": "Lexia",
    "stack": "lexia, serif",
    "delivery": "same-as-body"
  }
}
```

## Output: `brand.json`

```json
{
  "url": "https://www.astrazeneca.com",
  "fonts": {
    "body": { "family": "Lexia", "stack": "lexia, serif" },
    "heading": { "family": "Lexia", "stack": "lexia, serif" },
    "headingSizes": {
      "xxl": { "desktop": "44px" },
      "xl": { "desktop": "36px" }
    },
    "sources": { "typekit": "abc123", "googleFonts": [] },
    "resolved": {
      "body": { "family": "Lexia", "stack": "lexia, serif", "delivery": "typekit", "url": "..." },
      "heading": { "delivery": "same-as-body" }
    }
  },
  "colors": {
    "background": "#ffffff",
    "text": "#3c4242",
    "link": "#e40046",
    "linkHover": "#c5003b"
  },
  "spacing": {
    "sectionPadding": "48px",
    "contentMaxWidth": "1200px",
    "navHeight": "94px"
  },
  "favicons": [
    { "url": "https://...", "rel": "icon", "sizes": "32x32" }
  ]
}
```

## EDS Configuration (Optional)

When EDS markers are detected (`fstab.yaml`, `scripts/aem.js`, or
`head.html`) and `--no-configure` is NOT set:

### Step 1: Update head.html

Add font `<link>` tags before existing `<script>` tags:

- Typekit: `<link rel="stylesheet" href="https://use.typekit.net/{id}.css">`
- Google Fonts: preconnect + `<link href="{url}" rel="stylesheet">`
- Skip if no external font delivery resolved

### Step 2: Download favicons

Download each favicon from `brand.favicons` to the project root.

### Step 3: Create styles/brand.css

```css
:root {
  --heading-font-family: "Lexia", serif;
  --body-font-family: "Lexia", serif;
  --background-color: #fff;
  --text-color: #3c4242;
  --link-color: #e40046;
  --link-hover-color: #c5003b;
  --section-padding: 48px;
  --nav-height: 94px;
}
```

### Step 4: Update styles/styles.css

Add `@import url('brand.css');` as the very first line. Update `:root`
variables to reference brand values.

### Idempotent

Running the skill twice won't duplicate font links or `@import`
statements — checks for existing entries before adding.

## Invocation

```
/brand-setup https://example.com
/brand-setup https://example.com --no-configure
/brand-setup https://example.com --only=fonts
/brand-setup https://example.com --browser-recipe=/path/to/recipe.json
/brand-setup https://example.com --output=/path/to/brand.json
```

**Modes:**

- Default: extract + configure (if EDS repo detected in cwd)
- `--no-configure`: extract only, output brand.json, touch nothing
- `--only=fonts`: extract all, but only configure fonts in head.html (skip brand.css, styles.css, favicons)
- `--browser-recipe`: pass through to css-query.js for bot-protected sites

## Integration with migrate-header

New Stage 6b between Extraction (Stage 6) and Scaffold (Stage 7):

```bash
/brand-setup "$URL" --browser-recipe="$BROWSER_RECIPE"
```

After this stage:

- Fonts installed in head.html — AEM dev server renders correct fonts
- brand.css exists with CSS custom properties
- Scaffold subagent reads brand.json alongside layout.json and styles.json
- Polish loop evaluator screenshots pages with correct fonts from
  iteration 1 — pixelmatch comparisons are font-accurate

Changes to existing stages:

- Stage 7 (Scaffold): prompt adds brand.json to input data. Font-family
  in header.css comes from brand.json resolved fonts.
- Stage 9 (Polish loop): no changes — benefits automatically from
  correct font rendering

## Skill Files

```
skills/brand-setup/
  SKILL.md                          Skill prompt
  scripts/
    brand-extract-dom.js            Browser IIFE (favicon + font sources)
    font-resolve.js                 Font resolution cascade
```

## Dependencies

- `css-query.js` from migrate-header (sibling skill) — CDP queries
- `playwright-cli` — browser session
- `browser-recipe` — for bot-protected sites (optional, passed through)

## What Stays Unchanged

- `css-query.js` — used as-is
- `extract-styles.js` — still produces styles.json for header CSS
- `extract-layout.js` — still produces layout.json
- Polish loop — benefits automatically
