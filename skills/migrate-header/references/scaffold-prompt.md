# Scaffold Subagent Prompt

This prompt is sent to the scaffold subagent in Phase 4. The caller
replaces `<PROJECT_ROOT>` and `$SKILL_HOME` with actual paths before
dispatching.

---

You are customizing an EDS header block for a specific website. The
header.js is already in place and must NOT be modified. You will:
1. Customize the CSS custom properties in header.css
2. Generate nav.plain.html from extraction data

## Input Data

Read these files:
- Layout: <PROJECT_ROOT>/autoresearch/extraction/layout.json
- Styles: <PROJECT_ROOT>/autoresearch/extraction/styles.json
- Fonts (if exists): <PROJECT_ROOT>/autoresearch/extraction/fonts-detected.json

styles.json contains CDP-queried CSS values with provenance (which
rule, which file, whether inherited). Use these directly — they are
the source of truth for all styling decisions.

If fonts-detected.json exists, use its `fonts.heading.stack` and
`fonts.body.stack` values for `font-family` in header.css. These
are the actual rendered fonts detected from the source page, and
the corresponding font files are already installed in head.html.

## Reference Docs

Read ALL of these for patterns and mapping guidance:
- $SKILL_HOME/references/eds-header-conventions.md
- $SKILL_HOME/references/content-mapping.md
- $SKILL_HOME/references/styling-guide.md
- $SKILL_HOME/references/header-block-guide.md

## Task 1: Customize header.css

Open <PROJECT_ROOT>/blocks/header/header.css and update ONLY the CSS
custom properties block at the top (.header.block { ... }) to match the
source site's styles from styles.json.

**Properties to set (all from styles.json):**
- --header-background: from styles.header["background-color"].value
- --header-nav-gap: from styles.navSpacing.value (spatially measured)
- --header-nav-font-size: from styles.navLinks["font-size"].value
- --header-nav-font-weight: from styles.navLinks["font-weight"].value
- font-family: from styles.navLinks["font-family"].value
- --header-text-color: from styles.navLinks.color.value
- --header-section-padding: from styles.header.padding.value
- For multi-row headers: styles.rows[N]["background-color"].value
- For CTA buttons: styles.cta (background-color, color, border-radius)
- Accent/hover color: styles.navLinksHover.color.value

Do NOT modify the structural CSS (layout, dropdowns, etc.).

## Task 2: Generate nav.plain.html

Create <PROJECT_ROOT>/nav.plain.html following the content-mapping
guide patterns. Use the extraction data:

- layout.rows tells you the section structure (brand, main-nav, etc.)
- layout.navItems.primary are the main nav links
- layout.navItems.secondary are secondary/utility links
- layout.rows[].elements tells you what each section contains
- layout.logo has the logo image data (src, alt, width, height, href)
- branding.logo also has the logo image data (src, alt, width, height)

### Logo Handling

If layout.logo or branding.logo has a src URL:

Use `layout.logo` as the primary source (it includes `href`).
Fall back to `branding.logo` only if `layout.logo` is null;
use `href="/"` in that case since `branding.logo` has no link.

1. Download the logo image to <PROJECT_ROOT>/images/logo.png (or
   matching extension). Use curl or fetch.
2. In nav.plain.html, use the local path:
   `<p><a href="<logo.href>"><img src="./images/logo.png" alt="<logo.alt>"></a></p>`

If no logo URL is available, use text: `<p><a href="/">Company Name</a></p>`

Each section needs a section-metadata block with Style property.
See content-mapping.md for exact HTML patterns per section type.

For single-row headers (1 row): use a single main-nav section with
inline brand and tools.

For multi-row headers: use separate sections (brand, main-nav, utility)
each with their own section-metadata.

## Task 3: Wire extracted icons into EDS

If `<PROJECT_ROOT>/autoresearch/extraction/icons/icons.json` exists:

1. Read the icon manifest
2. Copy all SVG files from `<PROJECT_ROOT>/autoresearch/extraction/icons/icons/`
   to `<PROJECT_ROOT>/icons/`
3. In nav.plain.html, use `:iconname:` notation for icons that appear
   in the tools/utility section. For example, if the manifest has a
   "search" icon, use `:search:` where a search button appears.
4. For the logo, if the manifest has a "logo" class icon, use `:logo:`
   in the brand section instead of an `<img>` tag.

The EDS `decorateIcons()` function in `aem.js` automatically converts
`:iconname:` to `<span class="icon icon-{name}"><img src="/icons/{name}.svg">`
at runtime. Do NOT create inline SVGs for icons in the manifest.

If the icon manifest does not exist, skip this task — icons will be
handled by the polish loop instead.

## After Generating

Stage and commit:
  cd <PROJECT_ROOT>
  git add blocks/header/header.css nav.plain.html images/ icons/
  git commit -m "scaffold: customize header CSS and generate nav content"
