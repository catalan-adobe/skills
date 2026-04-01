---
name: brand-setup
description: >-
  Extract brand identity (fonts, colors, typography, spacing, favicons) from
  any URL and install fonts in an AEM Edge Delivery Services project via
  Adobe Fonts (Typekit) or Google Fonts. Detects fonts using 4 browser API
  layers (document.fonts, CSS import-rule walk, Performance API, computed style
  voting), then resolves via a 5-step cascade: system font, Typekit kit match,
  Adobe Fonts add-to-kit, Google Fonts fallback, or not-found. Updates
  head.html with font embed tags. Use when starting a site migration, setting
  up an EDS project, or extracting a site's visual identity. Triggers on:
  brand setup, brand extract, brand fonts, install fonts, configure brand.
---

# brand-setup

Extract brand identity from a URL. Detect and install fonts in an EDS
project via Adobe Fonts or Google Fonts. Extract colors, spacing, favicons.

## Script Location

Own scripts:
```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  BRAND_DIR="${CLAUDE_SKILL_DIR}/scripts"
else
  BRAND_DIR="$(dirname "$(find ~/.claude \
    -path "*/brand-setup/scripts/font-detect.js" \
    -type f 2>/dev/null | head -1)" 2>/dev/null)"
fi
```

Sibling css-query.js (from migrate-header):
```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  CSS_QUERY="$(dirname "$CLAUDE_SKILL_DIR")/migrate-header/scripts/css-query.js"
else
  CSS_QUERY="$(find ~/.claude \
    -path "*/migrate-header/scripts/css-query.js" \
    -type f 2>/dev/null | head -1)"
fi
```

Verify both paths exist before proceeding.

## Arguments

| Argument | Purpose |
|----------|---------|
| `<url>` | Target URL (required) |
| `--kit=<kitId>` | Typekit kit ID (default: detected from page, or `cwm0xxe`) |
| `--no-configure` | Extract only — skip EDS project configuration |
| `--only=fonts` | Detect and install fonts only, skip colors/spacing/favicons |
| `--browser-recipe=<path>` | Pass to css-query.js for bot-protected sites |
| `--output=<path>` | Output path for brand.json (default: `./brand.json`) |
| `--session=<name>` | Playwright session name (default: `brand-setup`) |
| `--dry-run` | Preview font resolution without mutations |

## Environment

| Variable | Purpose |
|----------|---------|
| `ADOBE_FONTS_API_TOKEN` | Typekit API token for adding fonts to kits. Get from [fonts.adobe.com/account/tokens](https://fonts.adobe.com/account/tokens). Without this, fonts found in Adobe Fonts cannot be auto-added — falls through to Google Fonts. |

## Workflow

Set `SESSION` from `--session` (default: `brand-setup`), `OUTPUT`
from `--output` (default: `./brand.json`).

### Step 1 — Open browser session

```bash
node "$CSS_QUERY" open "$URL" --session="$SESSION"
```

If `--browser-recipe` was provided, add the flag. If the open fails,
suggest running `browser-probe` first to detect CDN bot protection.

### Step 2 — Detect fonts

Run the 4-layer font detection IIFE. This awaits `document.fonts.ready`
internally, so no separate wait step is needed.

```bash
node "$BRAND_DIR/font-detect.js" --session="$SESSION" \
  --output=fonts-detected.json
```

Output: `fonts-detected.json` with body/heading fonts (by computed
style voting across all p/h1-h3 elements), loaded font families from
`document.fonts`, and source detection (Typekit kit ID via CSS import
rules, Google Fonts URLs, Performance API resource entries).

### Step 3 — Install fonts

Resolve detected fonts through the 5-step cascade and update head.html:

```bash
node "$BRAND_DIR/font-install.js" \
  --detected=fonts-detected.json \
  --kit="$KIT_ID" \
  --head-html=head.html
```

The `--kit` value comes from (in order of precedence):
1. User-provided `--kit` argument
2. Kit ID detected from the source page (`fonts-detected.json → sources.typekit.kitId`)
3. Default fallback kit `cwm0xxe`

If `ADOBE_FONTS_API_TOKEN` is set, fonts found in Adobe Fonts are
automatically added to the kit and published. Without the token, only
fonts already in the kit are used; others fall through to Google Fonts.

Add `--dry-run` to preview resolution without making changes.

If `--only=fonts` was passed, skip to Step 6 (close session) after
this step.

### Step 4 — Extract brand visuals

Run the DOM extraction for colors, spacing, heading sizes, and favicons:

```bash
node "$BRAND_DIR/brand-extract-dom.js" --session="$SESSION"
```

Output includes:
- `colors`: background, text, link, linkHover
- `spacing`: sectionPadding, contentMaxWidth, navHeight
- `headingSizes`: h1→xxl through h6→xs with desktop font-size
- `favicons`: all icon links with URLs, sizes, types

### Step 5 — Build brand.json

Merge font detection + installation results with visual extraction:

```json
{
  "url": "<source URL>",
  "fonts": {
    "body": { "family": "...", "stack": "...", "delivery": "typekit" },
    "heading": { "family": "...", "stack": "...", "delivery": "same-as-body" },
    "headingSizes": { "xxl": { "desktop": "44px" } },
    "sources": { "typekit": { "kitId": "...", "method": "css-import" } }
  },
  "colors": { "background": "...", "text": "...", "link": "...", "linkHover": "..." },
  "spacing": { "sectionPadding": "...", "contentMaxWidth": "...", "navHeight": "..." },
  "favicons": [{ "url": "...", "rel": "icon" }]
}
```

Write to `$OUTPUT`.

### Step 6 — Close session

```bash
node "$CSS_QUERY" close --session="$SESSION"
```

Always close, even if earlier steps fail.

### Step 7 — EDS configuration (optional)

**Skip** if `--no-configure` was passed.

Detect EDS project by checking for `fstab.yaml`, `scripts/aem.js`, or
`head.html` in cwd. If none found, skip and report brand.json only.

Note: head.html font links were already added in Step 3 by
font-install.js. This step handles the remaining configuration.

#### 7a. Download favicons

```bash
curl -sL "<favicon-url>" -o "<filename>"
```

#### 7b. Create styles/brand.css

```css
:root {
  --heading-font-family: "<heading stack>";
  --body-font-family: "<body stack>";
  --background-color: <background>;
  --text-color: <text>;
  --link-color: <link>;
  --link-hover-color: <linkHover>;
  --content-max-width: <contentMaxWidth>;
  --section-padding: <sectionPadding>;
  --nav-height: <navHeight>;
}
```

Only include properties with values.

#### 7c. Update styles/styles.css

Add `@import url('brand.css');` as the very first line.
Idempotent — check before adding.

### Step 8 — Report

```
Brand extracted from <url>
  Body font: <family> (<resolution>)
  Heading font: <family> (<resolution>)
  Typekit kit: <kitId> (published: yes/no)
  Colors: bg=<bg> text=<text> link=<link>
  Favicons: <count>
  Output: <brand.json path>
```

## Error Handling

- If css-query.js open fails → suggest `browser-probe` for recipe
- If font-detect.js returns empty fonts → warn, continue with visuals
- If font-install.js can't add to kit (no token) → warn, try Google Fonts
- If Google Fonts check fails → warn, font declared in CSS but not delivered
- Always close session in Step 6, even on failure
