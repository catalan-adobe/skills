# Font Detection & Installation — Design Spec

Replace the current `brand-extract-dom.js` + `font-resolve.js` with two
focused scripts: `font-detect.js` (browser-side detection) and
`font-install.js` (server-side resolution + Typekit kit management).

## Problem

The current brand-setup font handling has three gaps proven on
astrazeneca.com:

1. **Detection misses `@import`-loaded fonts** — AZ loads Typekit via
   `@import url("use.typekit.net/ddz3ptv.css")` inside `base.min.css`.
   Our `<link>` tag scanner returns `typekit: null`.
2. **Body font queries wrong element** — Querying `body` returns
   `"Helvetica Neue"` (generic fallback). The actual brand font `lexia`
   is applied to content elements via class selectors.
3. **No font installation** — Detecting fonts is useless without
   installing them in the EDS project. The current `font-resolve.js`
   identifies delivery method but never creates or updates a Typekit kit.

The vibemigration project solves all three (proven in production on 100+
sites). This spec ports that logic to standalone Node.js scripts.

## Scripts

```
skills/brand-setup/scripts/
  font-detect.js      Browser IIFE — runs in page via playwright-cli
  font-install.js     Node.js CLI  — Typekit API + Google Fonts fallback
```

### font-detect.js — What fonts does this page use?

**Execution:** `node font-detect.js --session=<name>`

Runs a browser IIFE via `playwright-cli run-code` + `page.evaluate()`
after `document.fonts.ready`. Combines 4 detection layers:

#### Layer 1: `document.fonts` (FontFaceSet API)

Enumerate all registered FontFace objects:

```js
document.fonts.forEach(f => {
  fonts.push({
    family: f.family.replace(/^["']|["']$/g, ''),
    weight: f.weight,
    style: f.style,
    status: f.status   // "loaded" | "unloaded" | "loading" | "error"
  });
});
```

Dedup by family name. Return unique families with their loaded variants.

#### Layer 2: CSS `@import` chain walk

Walk `CSSImportRule` entries on all same-origin stylesheets. Extract
Typekit kit IDs and Google Fonts URLs from import hrefs:

```js
for (const sheet of document.styleSheets) {
  try {
    for (const rule of sheet.cssRules) {
      if (rule instanceof CSSImportRule) {
        // match use.typekit.net/{kitId}.css
        // match fonts.googleapis.com/css2?...
      }
    }
  } catch(e) { /* cross-origin — skip rules, but href is readable */ }
}
```

The imported Typekit stylesheet is cross-origin (cssRules throws
SecurityError), but `CSSImportRule.href` on the parent sheet IS readable.
This is how we found `ddz3ptv` on AstraZeneca.

#### Layer 3: Performance API

```js
performance.getEntriesByType("resource")
  .filter(e => e.name.includes("typekit") ||
               e.name.includes("fonts.googleapis") ||
               /\.(woff2?|ttf|otf|eot)/.test(e.name))
```

Catches ALL font resources regardless of loading method. Resources from
`@import` show `initiatorType: "css"`. This is the most reliable layer
for detecting that a font service is in use.

#### Layer 4: Computed style voting

Port from vibemigration `fonts-metadata.ts` — vote across ALL `<p>`
elements for body font and ALL `<h1>,<h2>,<h3>` for heading font:

```js
function detectByVoting(selector) {
  var els = document.querySelectorAll(selector);
  var counts = {};
  els.forEach(el => {
    var ff = getComputedStyle(el).fontFamily;
    counts[ff] = (counts[ff] || 0) + 1;
  });
  // return most common
}
```

This is more robust than `main p` → `p` → `body` fallback. It handles
sites where different sections use different fonts.

#### Output: `fonts-detected.json`

```json
{
  "url": "https://www.astrazeneca.com",
  "fonts": {
    "body": {
      "family": "lexia",
      "stack": "lexia, Times, \"Times New Roman\", serif"
    },
    "heading": {
      "family": "lexia",
      "stack": "lexia, Times, \"Times New Roman\", serif"
    }
  },
  "loadedFonts": [
    { "family": "lexia", "weights": ["200","300","400","700"], "styles": ["normal","italic"] },
    { "family": "az-webfont", "weights": ["400"], "styles": ["normal"] }
  ],
  "sources": {
    "typekit": { "kitId": "ddz3ptv", "method": "css-import" },
    "googleFonts": []
  }
}
```

Key design choices:
- `loadedFonts` groups by family with all detected weights/styles
- `sources.typekit.method` records HOW the kit was detected (link-tag,
  css-import, script-tag, performance-api) for debugging
- The body/heading voting approach from vibemigration replaces the
  fragile `main p` → `p` → `body` fallback chain

---

### font-install.js — Install detected fonts in the EDS project

**Execution:**
```bash
node font-install.js \
  --detected=fonts-detected.json \
  --kit=<kitId> \
  --head-html=<path/to/head.html> \
  [--token=<typekitToken>] \
  [--dry-run]
```

Reads `fonts-detected.json`, resolves each font through the cascade,
manages the Typekit kit, and updates `head.html` with embed tags.

#### Environment

| Variable | Purpose | Required |
|----------|---------|----------|
| `ADOBE_FONTS_API_TOKEN` | Typekit API token for kit mutations | For steps 3-4 |

Token from `--token` flag takes precedence over env var.

#### 5-Step Resolution Cascade

Ported from vibemigration `useBrandExtraction.ts` lines 93-192:

```
For each detected font (body, heading):

  Step 1: System font?
    → isSystemFont(family) check against known list
    → If yes: skip (no delivery needed)

  Step 2: Already in the Typekit kit?
    → GET /kits/{kitId}/published (no auth needed)
    → Match by name or slug
    → If yes: use Typekit delivery (kit already has it)

  Step 3: Available in Adobe Fonts library?
    → GET /families/{slug} (no auth needed)
    → If found AND we have an API token:
        → POST /kits/{kitId}/families/{familyId}  (auth required)
        → POST /kits/{kitId}/publish               (auth required)
        → Wait for CDN propagation (~30s)
        → Result: "added-to-kit"
    → If found but NO token:
        → Log: "Font available in Adobe Fonts but no API token
          to add it. Set ADOBE_FONTS_API_TOKEN."
        → Fall through to Google Fonts

  Step 4: Available on Google Fonts?
    → GET fonts.googleapis.com/css2?family={name}:wght@400;700&display=swap
    → If 200 + contains @font-face rules: use Google Fonts delivery
    → Gotcha: 200 with empty body means weight not available

  Step 5: Not found
    → Log warning, use font-family declaration only (no delivery)
```

#### System Font List

Port from vibemigration `typekitClient.ts` lines 31-70:

```
arial, arial black, comic sans ms, courier new, georgia, helvetica,
helvetica neue, impact, lucida console, lucida grande,
lucida sans unicode, palatino linotype, segoe ui, tahoma,
times new roman, trebuchet ms, verdana, system-ui, sans-serif,
serif, monospace, cursive, fantasy, ui-sans-serif, ui-serif,
ui-monospace, ui-rounded, -apple-system, blinkmacsystemfont,
sf pro, sf pro display, sf pro text, sf mono, new york, roboto,
noto sans, open sans, segoe ui variable
```

#### Typekit API Integration

Base URL: `https://typekit.com/api/v1/json`
Auth header: `X-Typekit-Token: <token>`

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/kits/{kitId}/published` | GET | No | Fetch published kit families |
| `/families/{slug}` | GET | No | Check if font exists in Adobe Fonts + get metadata |
| `/kits/{kitId}/families/{familyId}` | POST | Yes | Add font to kit |
| `/kits/{kitId}/publish` | POST | Yes | Publish kit to CDN |

Slug derivation: `family.toLowerCase().replace(/['"]/g, '').trim().replace(/\s+/g, '-')`

#### head.html Update

After resolution, update `head.html`:

**If any font uses Typekit delivery:**
```html
<link rel="stylesheet" href="https://use.typekit.net/{kitId}.css">
```

**If any font uses Google Fonts delivery:**
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="{googleFontsUrl}" rel="stylesheet">
```

Idempotent: check for existing URLs before adding. Insert before the
first `<script>` or `<link>` tag.

#### Output

Writes updated `head.html` in-place. Prints resolution summary to
stdout as JSON:

```json
{
  "body": {
    "family": "lexia",
    "resolution": "added-to-kit",
    "delivery": "typekit",
    "kitId": "ddz3ptv"
  },
  "heading": {
    "family": "lexia",
    "resolution": "same-as-body"
  },
  "headHtmlUpdated": true,
  "typekitPublished": true
}
```

#### --dry-run Mode

Resolve fonts and print the resolution plan without mutating anything
(no kit changes, no head.html writes). Useful for previewing what
would happen.

---

## What Changes in SKILL.md

The brand-setup SKILL.md workflow simplifies to:

```
Step 1 — Open browser session (css-query.js open)
Step 2 — Wait for fonts (document.fonts.ready)
Step 3 — Detect fonts (font-detect.js → fonts-detected.json)
Step 4 — Install fonts (font-install.js → updates head.html)
Step 5 — Extract brand visuals (remaining brand extraction: colors,
         spacing, favicons — still uses the DOM IIFE approach)
Step 6 — Build brand.json (merge font + visual data)
Step 7 — Close session
Step 8 — EDS configuration (brand.css, styles.css, favicons)
```

Font detection and installation are now front-loaded before visual
extraction. This means fonts are available in the EDS project from
the start — downstream agents see correct font rendering immediately.

## What Gets Removed

- `font-resolve.js` — replaced by the resolution cascade in
  `font-install.js`
- The font-related parts of `brand-extract-dom.js` — replaced by
  `font-detect.js`. The brand visual extraction (colors, spacing,
  favicons) stays but moves to a separate concern.

## Files to Create/Modify

| File | Action |
|------|--------|
| `skills/brand-setup/scripts/font-detect.js` | Create — browser IIFE for 4-layer font detection |
| `skills/brand-setup/scripts/font-install.js` | Create — Typekit API client + resolution cascade + head.html update |
| `skills/brand-setup/scripts/brand-extract-dom.js` | Modify — remove font extraction, keep colors/spacing/favicons |
| `skills/brand-setup/scripts/font-resolve.js` | Delete — replaced by font-install.js |
| `skills/brand-setup/SKILL.md` | Modify — updated workflow with new scripts |

## Key Source Files to Port From

| Source | What to port |
|--------|-------------|
| `vibemigration/chrome-extension/src/shared/typekitClient.ts` | Typekit API functions, system font list, slug conversion, Google Fonts check |
| `vibemigration/chrome-extension/src/shared/hooks/useBrandExtraction.ts` lines 93-192 | 5-step resolution cascade |
| `vibemigration/playwright-worker/src/actions/brand/extractors/fonts-metadata.ts` | Computed style voting for body/heading fonts |

## Dependencies

- `playwright-cli` — browser session (existing dependency)
- Node 22 built-in `fetch` — Typekit API + Google Fonts calls
- No npm dependencies

## Verification

1. **Detection test:** Open astrazeneca.com, run font-detect.js, verify
   `lexia` detected with `sources.typekit.kitId = "ddz3ptv"` via
   css-import method
2. **Resolution test:** Run font-install.js with `--dry-run` against
   the AZ detection output, verify `lexia` resolves to "already in kit"
   (since ddz3ptv already has it)
3. **Installation test:** Run font-install.js against a test EDS
   project's head.html, verify Typekit `<link>` tag added correctly
4. **Google Fonts fallback test:** Run with a font not in Adobe Fonts
   (e.g. "Fira Code"), verify Google Fonts URL generated
5. **End-to-end:** Full brand-setup on astrazeneca.com, verify
   `head.html` has Typekit embed and fonts render in AEM dev server
