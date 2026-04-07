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
- Row extractions: <PROJECT_ROOT>/autoresearch/extraction/row-*.json
  (one file per visual row — row-0.json is topmost, row-1.json below, etc.)
- Fonts (if exists): <PROJECT_ROOT>/autoresearch/extraction/fonts-detected.json

Each row-N.json contains classified elements with per-element CSS styles
queried from the source page via CDP. These are the source of truth for
all styling decisions. See the design spec for the full schema.

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
source site's styles from the row extraction files.

**How to read styles from row files:**

Each row file has `rowStyles` (row-level CSS) and per-element `styles`.
Use element styles matching the role for each property:

- --header-background: from row-0.json rowStyles["background-color"]
- --header-nav-font-size: from the first nav-link element's styles["font-size"]
- --header-nav-font-weight: from the first nav-link element's styles["font-weight"]
- font-family: from the first nav-link element's styles["font-family"]
  (or rowStyles["font-family"] if not on the element)
- --header-text-color: from the first nav-link element's styles.color
- --header-section-padding: from row rowStyles padding (if present)
- For multi-row headers: each row's rowStyles["background-color"]
- For CTA buttons: from elements with role "cta" (background-color, color, border-radius)

**Important:** Use the font-size from nav-link elements for nav styling,
utility-link elements for utility styling. Do not mix them.

Do NOT modify the structural CSS (layout, dropdowns, etc.).

## Task 2: Generate nav.plain.html

Create <PROJECT_ROOT>/nav.plain.html following the content-mapping
guide patterns. Use the row extraction data:

**Key rule: one section per row file.** Each row-N.json represents one
visual row of the header. Generate exactly one nav.plain.html `<div>`
section per row file.

- Use `suggestedSectionStyle` from each row file for the section-metadata
  Style property
- Element roles tell you what each element is: logo, nav-link (with
  children for submenus), utility-link, cta, search, icon, text
- All elements are included regardless of role — do not filter any out.
  Promotional cards, featured links, etc. should appear in nav.plain.html
- Element `position` (left/right/center) guides layout within the section

### Logo Handling

Find the element with role "logo" in the row files. It will have content
with a tag, src, alt, and href.

1. Download the logo image to <PROJECT_ROOT>/images/logo.png (or
   matching extension). Use curl or fetch.
2. In nav.plain.html, use the local path:
   `<p><a href="<href>"><img src="./images/logo.png" alt="<alt>"></a></p>`

If no logo element exists, use text: `<p><a href="/">Company Name</a></p>`

### Nav links with submenus

Elements with role "nav-link" may have `content.children` — these are
submenu items (possibly from hidden dropdown panels). Render them as
nested `<ul>` structures per the content-mapping guide.

Each section needs a section-metadata block with Style property.
See content-mapping.md for exact HTML patterns per section type.

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
