---
name: spectrum-2-web
description: >-
  Design and build web UIs with Adobe Spectrum 2 design system. Applies
  S2 layout principles, visual hierarchy, spacing, and component
  composition to produce accessible interfaces. Outputs vanilla CSS with
  Spectrum tokens (static pages) or Spectrum Web Components (interactive
  apps). Recommends tier based on complexity. Covers sp-theme setup,
  side-effect imports, overlay system, form patterns, --mod-* token
  customization, and 14 critical gotchas. Use for: spectrum 2 web, SWC,
  sp-button, sp-theme, build UI with spectrum, S2 layout, spectrum
  application, adobe design system, web component form, spectrum overlay.
---

# Spectrum 2 Web

Design and build web UIs using Adobe Spectrum 2 with Spectrum Web
Components (SWC) or vanilla CSS with Spectrum design tokens.

## Reference Location

Read references from this skill's directory. If `CLAUDE_SKILL_DIR` is
available, references are at `${CLAUDE_SKILL_DIR}/references/`. Otherwise,
use Glob to find `skills/spectrum-2-web/SKILL.md` and derive the path.

## Phase 1 — Classify

Always run this phase first. No reference files are needed yet.

### Step 1: Classify intent

Determine what the user is asking for:

| Intent | Signal | Phases |
|--------|--------|--------|
| **Design + Build** | User describes what they want ("build me a settings page", "create a dashboard") | Phase 2 then 3 |
| **Build only** | User has a design, mockup, or specific layout ("implement this with SWC", "convert to Spectrum") | Phase 3 only |
| **Design only** | User wants layout advice ("what layout for a dashboard?", "how should I structure this?") | Phase 2 only |

If ambiguous, ask one clarifying question. Do not over-ask.

### Step 2: Determine output tier

Choose the output technology based on what's being built:

| Tier | When to use | Output |
|------|-------------|--------|
| **Vanilla CSS + Spectrum tokens** | Static/presentational content: landing pages, marketing, docs, no interactivity | Semantic HTML styled with `--spectrum-*` custom properties |
| **Spectrum Web Components** | Interactive UI: forms, overlays, navigation, tabs, pickers, data entry | `<sp-*>` custom elements with side-effect imports |

State your recommendation and rationale. The user can override — accept
any explicit preference without pushback.

### Step 3: Detect context

Check for an existing project:

1. Use Glob to look for `package.json` in the working directory and
   parent directories.
2. If found, Read it and check for `@spectrum-web-components` in
   `dependencies` or `devDependencies`.

| Result | Mode | Output format |
|--------|------|---------------|
| SWC already in dependencies | **Project-aware** | Separate JS/TS + HTML/template + CSS files; npm imports |
| `package.json` exists but no SWC | **Project-aware** | Same, plus `npm install` instructions |
| No `package.json` | **Self-contained** | Single HTML file with CDN imports via JSPM; opens in browser |

Report your classification to the user:
> "I'll **design and build** an interactive settings page using
> **Spectrum Web Components** in **self-contained** mode (single HTML
> file). Sound good?"

Proceed on confirmation (or immediately if the request is unambiguous).

## Phase 2 — Design

Runs when intent includes design.

### Load design references

Read these two files before designing:

1. [Spectrum 2 design principles](references/DESIGN-PRINCIPLES.md) — visual hierarchy, spacing, color, typography rules
2. [Layout patterns](references/LAYOUT-PATTERNS.md) — canonical app shells, dashboard grids, form layouts

### Design process

1. **Select layout pattern.** Match the user's request to the closest
   canonical pattern from the layout reference. If no pattern fits,
   compose from first principles using the design guide.

2. **Apply S2 visual system.** For each page region, specify:
   - **Depth layer**: base, layer-1, or layer-2 background
   - **Spacing tokens**: gaps, padding, margins from the scale
   - **Typography**: heading level, body vs detail, font weight
   - **Color intent**: informative, negative, notice, positive, neutral
   - **Component choices**: which SWC elements or HTML structures

3. **Verify accessibility baseline.**
   - Every interactive element has a visible label or `aria-label`
   - Color is never the sole indicator (pair with icon or text)
   - Heading hierarchy follows document order (h1 > h2 > h3)
   - Focus order matches visual reading order

4. **Present the design.** Describe to the user:
   - Page sections and their purpose
   - Component selections for each section
   - Navigation approach (sidebar, tabs, breadcrumbs)
   - Visual hierarchy (what draws the eye first, second, third)
   - Any S2 compliance notes

5. **Wait for confirmation** before proceeding to Phase 3. Incorporate
   feedback if the user suggests changes.

## Phase 3 — Build

Runs when intent includes build.

### Load build references

Read all four of these before generating code:

1. [Setup and theming](references/SETUP-AND-THEMING.md) — installation, sp-theme, color/scale
2. [Component guide](references/COMPONENT-GUIDE.md) — component selection, usage patterns, slot names
3. [Token reference](references/TOKEN-REFERENCE.md) — CSS custom properties for spacing, color, typography
4. [Gotchas](references/GOTCHAS.md) — 14 critical issues; check every component against this list

### Self-contained output (no project detected)

Generate a single HTML file:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Page Title</title>
  <script src="https://jspm.dev/@spectrum-web-components/bundle/elements.js"
          type="module" async></script>
  <style>
    /* Layout using Spectrum tokens */
    body { margin: 0; font-family: 'Adobe Clean', 'Source Sans Pro', -apple-system, BlinkMacSystemFont, sans-serif; }
  </style>
</head>
<body>
  <sp-theme system="spectrum-two" color="light" scale="medium">
    <!-- All content here -->
  </sp-theme>
</body>
</html>
```

Use CSS Grid or Flexbox for layout, referencing `--spectrum-spacing-*`
and `--spectrum-background-*` tokens in the `<style>` block.

### Project-aware output (existing npm project)

Generate separate files:

**JavaScript/TypeScript imports** — one side-effect import per component:

```js
// theme (always required)
import '@spectrum-web-components/theme/sp-theme.js';
import '@spectrum-web-components/theme/spectrum-two/theme-light.js';
import '@spectrum-web-components/theme/spectrum-two/scale-medium.js';

// components (only what you use)
import '@spectrum-web-components/button/sp-button.js';
import '@spectrum-web-components/textfield/sp-textfield.js';
// ... one import per component
```

**HTML/template** with `<sp-theme system="spectrum-two">` wrapper.

**CSS file** using Spectrum tokens for custom layout.

**Install command** listing every package needed:

```bash
npm install @spectrum-web-components/theme \
  @spectrum-web-components/button \
  @spectrum-web-components/textfield
# All packages must use the same version
```

### SWC output checklist

Verify every item before delivering SWC output:

- [ ] `<sp-theme system="spectrum-two">` wraps all components
- [ ] Every `<sp-*>` tag has a matching side-effect import
- [ ] Auto-imported children accounted for (button imports icons-ui,
      picker imports popover, overlay imports underlay)
- [ ] Form fields stack as: label, field, help-text
- [ ] Icon-only buttons have `label="Description"` attribute
- [ ] Overlays use `trigger="elementId@click"` syntax
- [ ] No deprecated APIs:
  - `variant` on theme → use `system="spectrum-two"`
  - `href` on `<sp-button>` → use `<sp-link>`
  - `variant="cta"` → use `variant="accent"`
- [ ] No `--system-*` CSS overrides (use `--mod-*` tokens instead)
- [ ] Components that don't exist in SWC are not used:
  date pickers, tree view, composite color picker

### Vanilla CSS output checklist

Verify every item before delivering vanilla CSS output:

- [ ] Semantic HTML: `<nav>`, `<main>`, `<section>`, `<header>`,
      `<form>`, proper heading levels
- [ ] All visual styling uses `--spectrum-*` token custom properties
- [ ] Token definitions included (CDN link to `@spectrum-css/tokens`
      or inline the needed variables)
- [ ] Accessible: proper contrast via token color indices, heading
      hierarchy, form `<label>` elements, visible focus styles

## S2 Compliance

These rules apply across all phases:

1. **Default to full S2 compliance.** Use tokens for all spacing,
   color, and typography. Follow the visual hierarchy from the design
   principles.

2. **Always use `system="spectrum-two"`** unless the user explicitly
   requests Spectrum 1 or Express theming.

3. **Accept user overrides without blocking.** If the user wants a
   custom color, non-standard spacing, or any deviation — apply it,
   then note the deviation concisely:

   > "Applied custom background `#FF5733`. The S2-compliant alternative
   > would be `--spectrum-informative-background-color-default` or
   > `--spectrum-accent-background-color-default`."

4. **Handle missing components gracefully.** SWC does not include
   date pickers, tree views, or composite color pickers. When the
   design calls for one:
   - Note the gap
   - Suggest alternatives: native `<input type="date">`, custom
     implementation, or React Spectrum S2 if the project uses React
   - Never invent fake `<sp-*>` tags

## Quick Reference

Full details in [Token reference](references/TOKEN-REFERENCE.md) and [Component guide](references/COMPONENT-GUIDE.md).

### Theme setup

```html
<sp-theme system="spectrum-two" color="light" scale="medium">
  <!-- all content inside -->
</sp-theme>
```

Color options: `light`, `dark`. Scale options: `medium`, `large`.

### Side-effect imports

```js
import '@spectrum-web-components/theme/sp-theme.js';
import '@spectrum-web-components/theme/spectrum-two/theme-light.js';
import '@spectrum-web-components/theme/spectrum-two/scale-medium.js';
```

One import per component: `@spectrum-web-components/<pkg>/<element>.js`

### Semantic colors

| Intent | Token prefix | Use for |
|--------|-------------|---------|
| Accent/Informative | `--spectrum-accent-*`, `--spectrum-informative-*` | Primary actions, links, selection |
| Negative | `--spectrum-negative-*` | Errors, destructive actions, alerts |
| Notice | `--spectrum-notice-*` | Warnings, caution states |
| Positive | `--spectrum-positive-*` | Success, completion, valid states |
| Neutral | `--spectrum-neutral-*`, `--spectrum-gray-*` | Secondary actions, borders, muted text |

### Spacing scale

| Use | Token |
|-----|-------|
| Tight (inline, icon gaps) | `--spectrum-spacing-75` to `--spectrum-spacing-100` |
| Standard (form fields, list items) | `--spectrum-spacing-200` |
| Section (card padding, group gaps) | `--spectrum-spacing-300` to `--spectrum-spacing-400` |
| Major (page sections, hero areas) | `--spectrum-spacing-500` to `--spectrum-spacing-600` |

### Common components

| Need | SWC element |
|------|-------------|
| Button | `<sp-button variant="accent\|primary\|secondary\|negative">` |
| Text input | `<sp-textfield label="Name">` |
| Dropdown | `<sp-picker label="Choose">` + `<sp-menu-item>` children |
| Checkbox | `<sp-checkbox>Label</sp-checkbox>` |
| Switch | `<sp-switch>Label</sp-switch>` |
| Link | `<sp-link href="...">Text</sp-link>` |
| Tabs | `<sp-tabs>` + `<sp-tab>` + `<sp-tab-panel>` |
| Dialog | `<sp-dialog-wrapper>` with overlay trigger |
| Toast | `<sp-toast variant="info\|positive\|negative">` |
| Card | `<sp-card heading="Title">` |
