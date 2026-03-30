# page-collect Skill & migrate-header Icon Integration

**Date:** 2026-03-30
**Issue:** catalan-adobe/skills#38
**Status:** Design approved

## Problem

During the AstraZeneca header migration, 5 of 8 kept iterations (62%)
touched icon styling — search icon, hamburger menu, dropdown carets.
Polish loop agents recreate icons from scratch each iteration, cycling
through emoji, Unicode, and hand-tuned SVG paths before converging.
This wastes iteration budget on a solved problem.

More broadly, there is no reusable way to extract structured resources
(icons, metadata, text, forms, videos, social links) from a source
webpage for use in EDS migrations. The page-processor-worker in the
vibemigration project solves this for Cloudflare Workers but is locked
to that infrastructure.

## Solution

Two deliverables:

1. **`page-collect` skill** — a generic resource extraction skill that
   ports the page-processor-worker's collector architecture to a local
   Claude Code tool. Uses Playwright, outputs structured JSON + assets.
2. **migrate-header icon integration** — updates the migration pipeline
   to consume `page-collect icons` output and wire extracted icons into
   the standard EDS `/icons/` + `decorateIcons()` system.

## Part 1: page-collect Skill

### Subcommands

| Subcommand | Purpose | Output |
|------------|---------|--------|
| `all` | Run all collectors | `collection.json` + all assets |
| `icons` | SVGs, icon fonts, CSS icons → classified SVGs | `icons/` + `icons.json` |
| `metadata` | Meta tags, OG, structured data, canonical | `metadata.json` |
| `text` | Body text, headings, word count, language | `text.json` |
| `forms` | Form structures, fields, actions | `forms.json` |
| `videos` | Video embeds, sources, thumbnails | `videos.json` |
| `socials` | Social media links, share buttons | `socials.json` |

**Invocation:**

```bash
node page-collect.js <subcommand> <url> [--output <dir>]
```

Default output directory: `./page-collect-output/`.

### Skill structure

```
skills/page-collect/
  SKILL.md
  scripts/
    page-collect.js                 # CLI — arg parsing, Playwright session, routing
    collect-icons.js                # Icon extraction, classification, optimization
    collect-metadata.js             # Meta tags, OG, structured data
    collect-text.js                 # Body text, headings, word count
    collect-forms.js                # Form structures
    collect-videos.js               # Video embeds
    collect-socials.js              # Social links
  references/
    icon-font-maps.md              # Placeholder for future icon font codepoint → SVG tables
    collectors.md                   # Collector details for progressive disclosure
```

### Script architecture

`page-collect.js` owns the Playwright lifecycle — launches browser,
navigates to the URL, waits for load, dismisses overlays (using
page-prep patterns), then passes the Playwright `page` object to the
requested collector(s).

Each `collect-*.js` exports a single async function:

```js
export async function collectIcons(page, outputDir) { ... }
export async function collectMetadata(page) { ... }
```

The `all` subcommand imports and calls each collector in sequence within
one browser session. Individual subcommands import only the one needed.

### Icon collector detail

**Extraction sources:**

| Source | Detection | Extraction |
|--------|-----------|------------|
| Inline SVGs | `<svg>` elements in DOM | Serialize `outerHTML` |
| `<img>` SVGs | `<img src="*.svg">` | Fetch the SVG file content |
| Icon fonts | Pseudo-content + known font-family | Flag in manifest (v1, no auto-conversion) |
| CSS background SVGs | `background-image: url("data:image/svg+xml...")` or `url("*.svg")` | Decode data URI or fetch file |
| SVG sprites | `<svg><use href="#id">` or `xlink:href` | Resolve symbol, extract standalone SVG |

**Classification** — based on rendered size and DOM context:

| Class | Heuristic | EDS treatment |
|-------|-----------|---------------|
| `icon` | Rendered ≤ 48px, inside interactive element (button, link, nav), or known icon pattern | → `/icons/{name}.svg` |
| `logo` | Inside header brand area, "logo" in alt/class/src, or first prominent image in top-left | → `/icons/logo.svg` |
| `image` | Rendered > 48px, standalone in content flow | Excluded from icon output |

Logos go to `/icons/` because the EDS icon system centralizes them —
change once, all pages update.

**Naming:**

1. Recognizable class/ID/aria-label (e.g., `class="search-icon"`) →
   derive name (`search`)
2. Known pattern (search form, hamburger button) → canonical name
3. Fallback → `icon-{index}` with `nameConfidence: "low"` in manifest

**SVG optimization** — hand-rolled, no SVGO dependency:

1. Strip XML declarations, comments, `<metadata>`, `<title>`, `<desc>`
2. Normalize viewBox (ensure present, remove hardcoded width/height)
3. Replace fill/stroke colors with `currentColor` (icons only, not logos)
4. Collapse whitespace, remove empty attributes

> **Future improvement:** If hand-rolled cleanup proves insufficient for
> edge cases (complex gradients, nested groups, editor bloat from tools
> like Illustrator or Figma), SVGO (`svgo` npm package) is the standard
> tool for SVG optimization and could replace the hand-rolled approach.
> It would add a `node_modules` dependency to the skill's scripts
> directory.

**Output:**

```
page-collect-output/
  icons/
    search.svg
    cart.svg
    logo.svg
    caret-down.svg
    icon-4.svg
  icons.json
```

**icons.json manifest:**

```json
{
  "url": "https://example.com",
  "icons": [
    {
      "name": "search",
      "class": "icon",
      "source": "inline-svg",
      "file": "icons/search.svg",
      "nameConfidence": "high",
      "context": "nav tools button"
    },
    {
      "name": "icon-4",
      "class": "icon",
      "source": "icon-font",
      "file": "icons/icon-4.svg",
      "nameConfidence": "low",
      "context": "utility bar link"
    }
  ]
}
```

### Other collectors

**Metadata:** Extracts `<title>`, all `<meta>` tags (description, og:*,
twitter:*, robots), canonical URL, structured data (application/ld+json),
favicon. Output: `metadata.json`.

**Text:** Extracts visible body text (stripped of nav/footer/scripts),
heading hierarchy with levels, word count, language (from `<html lang>`).
Output: `text.json`.

**Forms:** Extracts each `<form>` with action, method, field inventory
(name, type, required, label). Output: `forms.json`.

**Videos:** Extracts `<video>` elements (src, poster), `<iframe>` embeds
matching known video hosts (YouTube, Vimeo, Wistia), `<source>` variants.
Output: `videos.json`.

**Socials:** Extracts links matching known social media domains, share
buttons, social meta tags. Output: `socials.json` with platform, url,
type (profile vs share).

### The `all` subcommand

Runs every collector sequentially in one Playwright session. Produces a
top-level `collection.json`:

```json
{
  "url": "https://example.com",
  "collectedAt": "2026-03-30T...",
  "screenshot": "screenshot.jpg",
  "collectors": {
    "metadata": { "..." : "..." },
    "text": { "..." : "..." },
    "forms": { "..." : "..." },
    "videos": { "..." : "..." },
    "icons": { "..." : "..." },
    "socials": { "..." : "..." }
  }
}
```

Plus a full-page screenshot (`screenshot.jpg`) for reference.

## Part 2: migrate-header Icon Integration

### Pipeline change

Current:

```
capture-snapshot → extract-layout → extract-branding → scaffold → polish loop
```

Updated:

```
capture-snapshot → extract-layout → extract-branding → collect icons → scaffold → polish loop
```

The new stage runs `page-collect.js icons <url>` against the source site.

### Scaffold changes (Stage 7)

The scaffold subagent gains three additional responsibilities:

1. Copy extracted icon SVGs from collector output → project `/icons/`
2. Update `nav.plain.html` to use `:iconname:` notation where icons
   appear in the tools/utility section
3. Read `icons.json` manifest to know available icons and their names

**Example nav.plain.html with EDS icon references:**

```html
<div>
  <div>
    <p><a href="/">Brand</a></p>
    <p>:logo:</p>
  </div>
  <div>
    <ul>
      <li><a href="/products">Products</a></li>
      <li><a href="/solutions">Solutions</a></li>
    </ul>
  </div>
  <div>
    <p><a href="/search">:search:</a></p>
    <p><a href="/cart">:cart:</a></p>
    <p><a href="/account">:account:</a></p>
  </div>
</div>
```

The EDS boilerplate's `decorateIcons()` in `aem.js` turns `:search:`
into `<span class="icon icon-search"><img src="/icons/search.svg">`
automatically.

### What stays as CSS

Hamburger, close (X), and dropdown carets remain CSS-drawn in
`header.css`. These are structural UI elements with animations
(hamburger↔X transition, caret rotation) that don't belong in the
EDS icon system.

### program.md.tmpl update

Add guidance so the polish loop agent knows icons exist:

```markdown
## Available Icons
Pre-extracted SVG icons are in `/icons/`. These are referenced via
`:iconname:` notation in nav.plain.html and rendered by decorateIcons().
Do NOT recreate these as inline SVGs or CSS. Adjust size via CSS
width/height on `.icon-{name} img`, color is inherited via the SVG's
currentColor fill.
```

## Out of Scope

- **No icon font auto-conversion in v1.** Icon fonts are detected and
  flagged in the manifest (`source: "icon-font"`, `nameConfidence: "low"`)
  but not automatically converted to SVG. Claude handles these manually
  via web search. The `icon-font-maps.md` reference can be populated in
  a follow-up to enable auto-conversion for Font Awesome, Material Icons,
  and other common sets.

- **No iframes collector.** Video iframes are captured by the videos
  collector. Remaining iframe types (maps, widgets) are too varied.

- **No changes to `decorateIcons()`.** We use the standard EDS icon
  system as-is. The `<img>` approach works. Inline SVG for
  `currentColor` inheritance is a separate EDS-level concern.

- **No SVGO dependency.** SVG cleanup is hand-rolled. See the future
  improvement note in the icon collector section.

- **No changes to `extract-layout.js` or `extract-branding.js`.** Their
  existing icon detection remains as-is. `page-collect icons` is a
  separate, richer extraction.

## Testing

### page-collect skill

- Run `icons` subcommand against 3+ sites with different icon formats
  (inline SVGs, icon fonts, img-based SVGs)
- Verify classification accuracy (icon vs logo vs image)
- Verify SVG optimization output (viewBox present, currentColor applied,
  no editor metadata)
- Verify `all` subcommand produces complete collection.json
- Verify individual collector outputs match expected schema

### migrate-header integration

- Run a full header migration with icon collection enabled
- Compare iteration count vs baseline (without icon pre-seeding)
- Verify icons render correctly at 16px, 20px, 24px
- Verify `currentColor` inheritance with different header color schemes
- Verify `:iconname:` notation works in nav.plain.html via decorateIcons()
