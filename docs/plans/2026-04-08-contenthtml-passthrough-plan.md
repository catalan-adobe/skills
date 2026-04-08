# Plan: Cleaned innerHTML Passthrough for Menu Items

Adds a `contentHtml` field to the row agent output schema. This field
carries each nav item's DOM so that no content (images, promotional
cards, nested structures) is lost during extraction. The scaffold agent
uses `contentHtml` as the source of truth for nav.plain.html generation
while keeping the structured `content` and `styles` fields for the
polish loop.

## Context

Observed during AstraZeneca migration (2026-04-07): the row-1 agent
extracted 6 promotional card images into an ad-hoc `promotionalCards`
field not in the schema. The scaffold agent had no pattern for this
field and dropped all images. The structured `content` schema cannot
anticipate every content type websites put in menus.

See `docs/2026-04-07-llm-row-extraction-design.md` for the overall
LLM row extraction design this plan extends.

## Approach

Add `contentHtml` alongside the existing structured fields. The row
agent captures `innerHTML` via a `playwright-cli eval` call, stripping
only `<script>`, `<style>`, and `<noscript>` elements. Class names,
data attributes, and other markup are preserved — they carry semantic
signal that helps the scaffold LLM understand the content. No new
script or dependency is needed.

The structured `content` remains useful for role classification and
style targeting. `contentHtml` acts as a completeness safety net
that the scaffold agent uses for generating nav.plain.html markup.

## Changes

### 1. Update row agent prompt in SKILL.md

In the Phase 3.1 row agent prompt template, add a step between DOM
analysis (step 3) and CSS querying (step 4):

```
3b. For each element, capture its cleaned innerHTML:
    ```bash
    playwright-cli -s=row-[INDEX] eval "
      const el = document.querySelector('<element-selector>').cloneNode(true);
      el.querySelectorAll('script,style,noscript').forEach(n => n.remove());
      el.innerHTML.trim()
    "
    ```
    Store the output as the element's `contentHtml` field.

    For nav-link elements with dropdown/submenu panels, capture the
    panel's innerHTML instead of just the link — this includes nested
    lists, promotional cards, and images.
```

### 2. Update row agent output schema in SKILL.md

Add `contentHtml` to the element schema:

```json
{
  "role": "nav-link",
  "position": "left",
  "content": { "text": "R&D", "href": "/r-d.html", "children": [...] },
  "contentHtml": "<a href=\"https://www.astrazeneca.com/r-d.html\">R&D</a><ul><li><a href=\"https://www.astrazeneca.com/r-d/our-approach.html\">Our approach</a></li><li><a href=\"https://www.astrazenecaclinicaltrials.com\"><img src=\"https://www.astrazeneca.com/content/dam/az/homepage/AZ2986.webp\" alt=\"Clinical trial\">AstraZeneca Clinical Trials</a></li></ul>",
  "styles": { ... }
}
```

Add to the schema field reference table:

| Field | Type | Description |
|-------|------|-------------|
| `elements[].contentHtml` | string | innerHTML of the element (or its dropdown panel for nav-links), with `<script>`, `<style>`, `<noscript>` removed. Source of truth for nav.plain.html content generation. |

### 3. Update scaffold-prompt.md

In the "Task 2: Generate nav.plain.html" section, add guidance:

```markdown
### Content Source Priority

When generating nav.plain.html markup for each element:

1. **Use `contentHtml`** as the primary content source. It contains the
   complete DOM of each element including images, nested lists, and
   promotional content. Convert it to EDS-compatible markup:
   - Keep `<a>`, `<img>`, `<ul>`, `<li>`, `<h1-h6>`, `<p>` as-is
   - Download referenced images to `<PROJECT_ROOT>/images/` and
     update `src` to local paths (same as logo handling)
   - Remove any remaining source-specific structure (`<div>` wrappers)
     that doesn't map to EDS patterns

2. **Use structured `content` fields** as a fallback when `contentHtml`
   is missing or empty. Also use `content.text` and `content.href` for
   the top-level link of each nav item.

3. **Use `role`** to determine layout position and section structure,
   not to filter content.
```

### 4. Update content-mapping.md

Add a "Promotional Cards in Mega Menus" section:

```markdown
### Promotional Cards / Featured Items

Source mega menu panels often contain promotional cards with images
alongside regular nav links. These appear in `contentHtml` as
`<a>` elements wrapping `<img>` tags.

**Source (from contentHtml):**
```html
<a href="https://www.astrazenecaclinicaltrials.com">
  <img src="https://.../.webp" alt="Clinical trial thumbnail">
  AstraZeneca Clinical Trials
</a>
```

**nav.plain.html:**
```html
<li>
  <a href="https://www.astrazenecaclinicaltrials.com">
    <img src="./images/clinical-trials-promo.webp" alt="Clinical trial thumbnail">
    AstraZeneca Clinical Trials
  </a>
</li>
```

Download images to `./images/` and reference locally. The header.js
mega menu renderer handles `<img>` inside `<li>` elements natively.
```

## Files Modified

| File | Change |
|------|--------|
| `SKILL.md` | Update Phase 3.1 row agent prompt + output schema |
| `references/scaffold-prompt.md` | Add contentHtml priority guidance |
| `references/content-mapping.md` | Add promotional card pattern |

## Files NOT Modified

- `scripts/css-query.js` — no changes, row agents use it as-is
- `block-files/header.js` — already handles `<img>` in mega menus
- `block-files/header.css` — no content-related changes
- `scripts/setup-polish-loop.js` — contentHtml is not used by polish loop

## Verification

1. Re-run AstraZeneca migration with updated pipeline
2. Confirm row-1.json elements have `contentHtml` with `<img>` tags
3. Confirm nav.plain.html includes promotional card images
4. Confirm scaffold score is at least equal to previous run
