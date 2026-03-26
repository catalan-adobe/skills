# spectrum-2-web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a Claude Code skill that designs and builds S2-compliant web UIs using Spectrum Web Components or vanilla CSS with Spectrum tokens.

**Architecture:** Single skill with adaptive 3-phase workflow (classify → design → build). Six reference files loaded progressively on demand. Pure prompt — no scripts, no external dependencies.

**Tech Stack:** SKILL.md (prompt), Markdown reference files, tessl for linting

**Source of truth:**
- Design spec: `docs/plans/2026-03-26-spectrum-2-web-design.md`
- Research: `docs/plans/2026-03-26-spectrum-web-components-research.md`

---

## File Structure

```
skills/spectrum-2-web/
├── SKILL.md                          # ~450 lines: adaptive workflow
└── references/
    ├── DESIGN-PRINCIPLES.md          # ~250 lines: S2 design knowledge
    ├── SETUP-AND-THEMING.md          # ~200 lines: installation + sp-theme
    ├── LAYOUT-PATTERNS.md            # ~300 lines: 5 app shells
    ├── COMPONENT-GUIDE.md            # ~300 lines: 68-component inventory + patterns
    ├── TOKEN-REFERENCE.md            # ~200 lines: token system + CSS examples
    └── GOTCHAS.md                    # ~100 lines: 14 pitfalls
```

Post-publish sync files (updated in final task):
- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `.claude/CLAUDE.md`
- `README.md`

---

### Task 1: Create DESIGN-PRINCIPLES.md

**Files:**
- Create: `skills/spectrum-2-web/references/DESIGN-PRINCIPLES.md`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p skills/spectrum-2-web/references
```

- [ ] **Step 2: Write DESIGN-PRINCIPLES.md**

Write to `skills/spectrum-2-web/references/DESIGN-PRINCIPLES.md`. Content must cover all items from the design spec Section "DESIGN-PRINCIPLES.md (~250 lines)":

1. **S2 Design Pillars** — expressive (rounder, richer colors, variable font), accessible (WCAG 2.1 AA), platform-contextual (adapts to OS conventions). Reference: research doc Section 1 "What Changed from S1" table.

2. **Visual Hierarchy — 3 Depth Layers** with token mappings:
   - Base (furthest from user) — `--spectrum-background-base-color` — application frame, borders
   - Layer 1 (middle) — `--spectrum-background-layer-1-color` — headers, side navigation
   - Layer 2 (closest to user) — `--spectrum-background-layer-2-color` — general content background
   - Reference: research doc Section 5 "S2 Color System" → "Three visual depth layers"

3. **Spacing System** — token table organized by use:
   - `--spectrum-spacing-50` through `--spectrum-spacing-600` (at minimum: 75, 100, 200, 300, 400, 500)
   - Usage guidance: 75-100 for tight spacing within components, 200 for standard element gaps, 300-400 for section padding, 500-600 for major section separation
   - CSS Grid `gap` and Flexbox `gap` are the preferred layout mechanisms

4. **Typography Scale** — all styles from research doc Section 5 "styles package":
   - Headings: XXS through XXXL with weight variants
   - Body: XS through XXXL
   - Detail: uppercase labels S–XL
   - Code: monospace XS–XL
   - Font: Adobe Clean Spectrum VF (variable font, S2)
   - Token examples: `--spectrum-font-size-75` through `--spectrum-font-size-1300`, `--spectrum-heading-size-*`

5. **S2 Color Usage** — semantic color categories with when-to-use guidance:
   - Informative/Accent (blue) — primary actions, selected states, links, focus indicators
   - Negative (red) — errors, destructive actions, validation failures
   - Notice (orange) — warnings, caution states
   - Positive (green) — success, completion, confirmation
   - Neutral (gray) — default UI, borders, disabled states, backgrounds
   - Static colors (`static-*`) — brand elements that must NOT flip between themes
   - Reference: research doc Section 5 "S2 Color System"

6. **Accessibility Baseline** (from research doc Section 8):
   - WCAG 2.1 AA built into S2 token indices (700 ≥ 3:1 for large text, 900 ≥ 4.5:1 for small text)
   - Auto-managed ARIA — SWC handles these automatically, don't override: `aria-expanded`, `aria-invalid`, `aria-current="page"`, `aria-hidden="true"`
   - Shadow DOM ARIA limitation: cannot reference elements across shadow roots with `aria-describedby` — use `slot="help-text"` inside the component instead
   - Keyboard navigation built into all composite widgets (action-group, tabs, sidenav, picker, split-view)
   - Label requirements: icon-only buttons MUST have `label` attribute; all form controls need either `sp-field-label` with `for` or `label` attribute
   - Focus management: overlays trap focus, restore on close; focus rings appear on keyboard interaction only

7. **Responsive Approach**:
   - `scale="medium"` — desktop/mouse (default)
   - `scale="large"` — mobile/touch (increases tap targets)
   - Nested `sp-theme` for mixed regions on same page
   - Use CSS media queries for layout breakpoints; use `scale` for component sizing

8. **Component Composition Rules**:
   - Form field stacking: label → field → help-text (vertical, always this order)
   - Group related controls with `sp-field-group` (vertical or horizontal)
   - Separate sections with `sp-divider`
   - Action buttons: primary (accent) rightmost, secondary leftmost in button rows
   - Use `sp-action-group` for related toggle actions (not separate buttons)
   - Navigation: sidebar for deep hierarchies (`sp-sidenav`), top for shallow (`sp-top-nav`), tabs for same-page sections (`sp-tabs`)

Target: ~250 lines. Include a table of contents at the top (required per conventions for files > 300 lines, recommended for ~250).

- [ ] **Step 3: Commit**

```bash
git add skills/spectrum-2-web/references/DESIGN-PRINCIPLES.md
git commit -m "feat(spectrum-2-web): add S2 design principles reference"
```

---

### Task 2: Create SETUP-AND-THEMING.md

**Files:**
- Create: `skills/spectrum-2-web/references/SETUP-AND-THEMING.md`

- [ ] **Step 1: Write SETUP-AND-THEMING.md**

Write to `skills/spectrum-2-web/references/SETUP-AND-THEMING.md`. Content must cover all items from design spec "SETUP-AND-THEMING.md (~200 lines)":

1. **SWC vs React Spectrum S2 Decision Table** — from research doc Section 10:

   | Dimension | SWC | React Spectrum S2 |
   |-----------|-----|-------------------|
   | Framework | Any (Lit/Web Components) | React only |
   | SSR | No (client-only) | Full support |
   | CDN/no-build | Yes (JSPM) | No |
   | Style macros | No | Yes |
   | Date/time components | Missing | Full suite |
   | Adobe add-ons | Recommended | Secondary |

   When to choose SWC: add-ons, Angular/Vue, CDN prototyping, no SSR needed.
   When to choose React Spectrum: React-only, SSR/Next.js, style macros, date pickers.

2. **Installation Patterns** — three options with code:
   - npm individual packages (production): `npm install @spectrum-web-components/theme@1.11.2 @spectrum-web-components/button@1.11.2` — ALL must be identical versions
   - Bundle (prototyping only): `npm install @spectrum-web-components/bundle` — officially discouraged for production
   - CDN via JSPM (prototyping): `<script src="https://jspm.dev/@spectrum-web-components/bundle/elements.js" type="module" async></script>` — JSPM handles export conditions; unpkg/jsDelivr do not

3. **ESM-Only**: no CommonJS bundles; `.js` extensions required in import paths

4. **Side-Effect Import Pattern** with code examples:
   ```js
   import '@spectrum-web-components/button/sp-button.js';    // registers <sp-button>
   import '@spectrum-web-components/textfield/sp-textfield.js'; // registers <sp-textfield>
   ```
   Each import self-registers. Must explicitly import every element. Tree-shaking cannot auto-discover.

5. **Auto-Imported Dependencies**: button→icons-ui, picker→popover, overlay→underlay (don't import manually)

6. **`<sp-theme>` Setup** with complete code examples:
   - Mandatory ancestor — distributes CSS custom properties. Without it, components render completely unstyled (no warning).
   - Three dimensions table: `system` (spectrum/express-deprecated/spectrum-two), `color` (light/dark), `scale` (medium/large)
   - Additional: `lang` (BCP 47), `dir` (ltr/rtl)

7. **S2 Activation** — import paths differ from S1:
   ```js
   import '@spectrum-web-components/theme/sp-theme.js';
   import '@spectrum-web-components/theme/spectrum-two/theme-light.js';
   import '@spectrum-web-components/theme/spectrum-two/scale-medium.js';
   ```
   ```html
   <sp-theme system="spectrum-two" color="light" scale="medium">
   ```

8. **Nested Themes** with example:
   ```html
   <sp-theme system="spectrum-two" color="light" scale="medium">
     <sp-button>Light</sp-button>
     <sp-theme color="dark" scale="large" dir="rtl">
       <sp-button>Dark, large, RTL</sp-button>
     </sp-theme>
   </sp-theme>
   ```

9. **Dynamic Theme Switching** with code from research doc Section 3.

10. **Context Detection Logic** — check for `package.json` with `@spectrum-web-components/*` → project-aware (npm imports); otherwise → self-contained HTML (CDN). Include the Glob/Read pattern to check this.

Target: ~200 lines.

- [ ] **Step 2: Commit**

```bash
git add skills/spectrum-2-web/references/SETUP-AND-THEMING.md
git commit -m "feat(spectrum-2-web): add setup and theming reference"
```

---

### Task 3: Create LAYOUT-PATTERNS.md

**Files:**
- Create: `skills/spectrum-2-web/references/LAYOUT-PATTERNS.md`

- [ ] **Step 1: Write LAYOUT-PATTERNS.md**

Write to `skills/spectrum-2-web/references/LAYOUT-PATTERNS.md`. This file contains 5 canonical app shell patterns. Each pattern MUST include a complete self-contained HTML example (CDN imports + styles + markup that opens in a browser).

**Table of contents** at top (required — file will be ~300 lines).

**Pattern 1: Sidebar + Main** (~60 lines)
- When to use: settings pages, admin panels, documentation sites
- Components: `sp-sidenav`, `sp-sidenav-item`, `sp-sidenav-heading`
- Layout: CSS Grid `grid-template-columns: 240px 1fr`
- Key tokens: `--spectrum-spacing-400` (gap), `--spectrum-spacing-300` (padding)
- Complete HTML example using CDN bundle import, `sp-theme system="spectrum-two"`, sidenav with 3-4 items, main content area with heading and paragraph
- Responsive note: collapse sidebar at narrow widths via media query

**Pattern 2: Top Nav + Content** (~50 lines)
- When to use: public-facing apps, simple tool UIs, single-purpose utilities
- Components: `sp-top-nav`, `sp-top-nav-item`
- Layout: full-width sticky header + main content below
- Complete HTML example

**Pattern 3: Dashboard** (~70 lines)
- When to use: analytics, monitoring, status overviews
- Components: `sp-card`, `sp-meter`, `sp-status-light`, `sp-progress-bar`, `sp-badge`
- Layout: CSS Grid `grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))`
- Complete HTML example with 3-4 dashboard cards showing different data display components

**Pattern 4: Form Page** (~60 lines)
- When to use: data entry, registration, onboarding, settings input
- Components: `sp-field-label`, `sp-textfield`, `sp-help-text`, `sp-picker`, `sp-menu-item`, `sp-checkbox`, `sp-button`
- Layout: vertical stack, max-width container (~600px), button row at bottom
- Stacking: label → field → help-text (always)
- Complete HTML example with 3 fields (text, email, picker), help-text slots, and submit/cancel buttons

**Pattern 5: Settings Panel** (~60 lines)
- When to use: nested categories with tabbed sub-sections, app preferences
- Components: `sp-sidenav` + `sp-tabs` + `sp-tab` + `sp-tab-panel` + form controls
- Layout: CSS Grid sidebar + tabbed main (combines Patterns 1 and 4)
- Complete HTML example — sidebar nav selecting categories, tabs within each category, form controls in tab panels. Use the application example from research doc Section 13 as the base.

Target: ~300 lines. Include table of contents.

- [ ] **Step 2: Commit**

```bash
git add skills/spectrum-2-web/references/LAYOUT-PATTERNS.md
git commit -m "feat(spectrum-2-web): add layout patterns reference"
```

---

### Task 4: Create COMPONENT-GUIDE.md

**Files:**
- Create: `skills/spectrum-2-web/references/COMPONENT-GUIDE.md`

- [ ] **Step 1: Write COMPONENT-GUIDE.md**

Write to `skills/spectrum-2-web/references/COMPONENT-GUIDE.md`. Content covers component inventory and usage patterns. Table of contents at top.

1. **Compact Component Inventory** — all 68 components from research doc Section 6, organized as compact tables per category. Format: `| package | element tags |`. Categories: Buttons & Actions, Form Controls, Color Tools, Navigation, Overlays & Dialogs, Data Display, Content & Layout, Onboarding & Icons, Tool Packages. Copy directly from research — this is reference data, it must be complete and accurate.

2. **Removed Components** — table from research doc Section 6 "Removed in v1.0.0":
   | Removed | Replacement |
   |---------|-------------|
   | `<sp-banner>` | `<sp-alert-banner>` |
   | `<sp-quick-actions>` | `<sp-action-bar>` |
   | `<sp-split-button>` | Button group pattern |

3. **Deprecated API Changes** — table from research doc Section 6 "Deprecated API Changes":
   All 9 rows: sp-action-button variant, sp-badge positions, sp-button variants (cta/over-background), sp-button href, sp-popover dialog, sp-progress-circle over-background, sp-theme attribute, sp-thumbnail sizes.

4. **Component Gaps vs React Spectrum** — list from research doc Section 6 "Notable Gaps":
   Date Picker, Date Range Picker, Date Field, Time Field, Calendar, Range Calendar, composite Color Picker, Tree View, ListView. Note: "The skill should NOT attempt to generate these components. Suggest alternatives or note the gap to the user."

5. **Form Patterns** with code examples from research doc Section 7:
   - Help-text slot system: `slot="help-text"` (default), `slot="negative-help-text"` (auto-shown when `invalid=true`). Show the HTML.
   - Field-group validation sync: set `invalid` on BOTH group AND each checkbox. Show the HTML.
   - Field-label patterns: `for` attribute, `required` flag, invisible labels via `label` attribute.
   - Show 3 label patterns (visible with for, invisible via attribute, icon-only button label).

6. **Overlay Patterns** with code examples from research doc Section 7:
   - Trigger syntax: `trigger="elementId@interaction"` — `click`, `hover`, `longpress`
   - Overlay types table (5 types: hint, auto, manual, modal, page) with outside-click, focus-trap, use-case columns
   - Modal dialog example, tooltip example, longpress example — all from research
   - VirtualTrigger for context menus — code from research doc
   - Programmatic control: `overlay.open = true`, `sp-opened`/`sp-closed` events
   - Delayed warmup: 1000ms before first delayed overlay, immediate after warmup, 1000ms cooldown

7. **Slot Composition Reference** — table from research doc Section 7:
   | Component | Slot | Purpose |
   Rows: sp-button icon, sp-dialog heading, sp-dialog button, sp-textfield help-text, sp-textfield negative-help-text, sp-picker label, sp-tab icon.

8. **Action Group Selection** with code from research doc Section 7:
   - `selects="single"` (radio behavior) — code example
   - `selects="multiple"` (checkbox behavior) — code example

9. **React Integration (`swc-react`)** from research doc Section 9:
   - Package naming: replace `@spectrum-web-components` with `@swc-react`
   - 62+ components available
   - Root setup with `<Theme>` component
   - `onChange` does NOT work for form controls → use `onInput`
   - Next.js static export: `import { Button } from '@swc-react/button/next.js'`
   - TypeScript: JSX needs `IntrinsicElements` declaration merging for custom element tags

Target: ~300 lines. Table of contents at top.

- [ ] **Step 2: Commit**

```bash
git add skills/spectrum-2-web/references/COMPONENT-GUIDE.md
git commit -m "feat(spectrum-2-web): add component guide reference"
```

---

### Task 5: Create TOKEN-REFERENCE.md

**Files:**
- Create: `skills/spectrum-2-web/references/TOKEN-REFERENCE.md`

- [ ] **Step 1: Write TOKEN-REFERENCE.md**

Write to `skills/spectrum-2-web/references/TOKEN-REFERENCE.md`. Content covers the token system and CSS customization.

1. **Token Naming Convention**: `--spectrum-[context]-[unit]-[clarification]`
   Show examples for each tier: global, alias/semantic, component, mod override, system (don't use). From research doc Section 5.

2. **Three-Tier Hierarchy** — diagram from research:
   ```
   Global     --spectrum-gray-500 (raw values)
     → Alias  --spectrum-negative-border-color-default (semantic)
       → Component --spectrum-actionbutton-border-color-default
   ```

3. **Most-Used Tokens by Purpose** — organized tables:
   - **Spacing**: `--spectrum-spacing-75` through `--spectrum-spacing-600` with px equivalents at medium scale
   - **Color (gray)**: `--spectrum-gray-50` through `--spectrum-gray-900` — note: 50 = white in light, dark gray in dark
   - **Color (semantic)**: `--spectrum-background-base-color`, `--spectrum-background-layer-1-color`, `--spectrum-background-layer-2-color`, `--spectrum-negative-border-color-default`, `--spectrum-disabled-background-color`
   - **Typography**: `--spectrum-font-size-75` through `--spectrum-font-size-1300`
   - **Sizing**: `--spectrum-component-height-*` tokens
   - **Border radius**: `--spectrum-corner-radius-100` etc.
   - **Animation**: `--spectrum-animation-duration-100` etc.

4. **S2 Color System** from research doc Section 5:
   - CAM02-UCS perceptual color space
   - 14-step ramps per color family (100–1400), 11 gray tones (50–900)
   - Contrast: 700 ≥ 3:1 (large text/icons), 900 ≥ 4.5:1 (WCAG AA small text)
   - Dark theme designed independently (not inversion)
   - 5 semantic categories: informative (blue), negative (red), notice (orange), positive (green), neutral (gray)
   - Static colors don't flip between themes

5. **The `--mod-*` Customization Pattern** from research doc Section 5:
   ```css
   /* Three-level fallback inside every component */
   background-color: var(
     --highcontrast-actionbutton-background-color-default,
     var(
       --mod-actionbutton-background-color-default,
       var(--spectrum-actionbutton-background-color-default)
     )
   );
   ```
   Priority: `--highcontrast-*` > `--mod-*` > `--spectrum-*`
   Show 2-3 worked examples: customize button background, change border color, adjust component sizing.

6. **CSS Parts** from research doc Section 7:
   ```css
   sp-button::part(button) { border-radius: 0; }
   sp-textfield::part(input) { font-family: 'Custom Font', sans-serif; }
   ```

7. **`--system-*` Warning**: auto-generated bridge variables. Unstable across builds. NEVER override — use `--mod-*` instead.

8. **Practical CSS Examples** — complete CSS blocks using only Spectrum tokens:
   - Custom panel/card:
     ```css
     .panel {
       background: var(--spectrum-background-layer-2-color);
       border: 1px solid var(--spectrum-gray-300);
       border-radius: var(--spectrum-corner-radius-100);
       padding: var(--spectrum-spacing-300);
     }
     ```
   - Section container, header bar, content card — 3-4 complete examples

9. **S1→S2 Token Migration** from research doc Section 5:
   | S1 | S2 |
   | `--spectrum-global-color-gray-800` | `--spectrum-gray-800` |
   | `@spectrum-css/vars` | `@spectrum-css/tokens` |
   | `.spectrum` CSS class | `.spectrum--legacy` (S1 now) |
   | `.spectrum` (new meaning) | = S2 Foundations |
   | `--spectrum-global-dimension-size-*` | Use `--swc-scale-factor` multiplier |

Target: ~200 lines.

- [ ] **Step 2: Commit**

```bash
git add skills/spectrum-2-web/references/TOKEN-REFERENCE.md
git commit -m "feat(spectrum-2-web): add token reference"
```

---

### Task 6: Create GOTCHAS.md

**Files:**
- Create: `skills/spectrum-2-web/references/GOTCHAS.md`

- [ ] **Step 1: Write GOTCHAS.md**

Write to `skills/spectrum-2-web/references/GOTCHAS.md`. All 14 gotchas from research doc Section 11. Each entry has: **Problem** (one line), **Why** (one line), **Fix** (concrete workaround with code if applicable).

**Critical (Common, High Impact):**

1. `sp-theme` is mandatory
   - Problem: Components render completely unstyled without an ancestor `<sp-theme>`. No console warning.
   - Why: `sp-theme` distributes design tokens as CSS custom properties. Without it, all `var(--spectrum-*)` resolve to nothing.
   - Fix: Always wrap all SWC components in `<sp-theme system="spectrum-two" color="light" scale="medium">`.

2. All packages must be the same version
   - Problem: Mixed `@spectrum-web-components/*` versions cause custom element registry conflicts at runtime.
   - Why: Two versions try to register the same tag name (e.g., `<sp-button>`). Second registration throws.
   - Fix: Pin all packages to identical versions: `@spectrum-web-components/theme@1.11.2`, `@spectrum-web-components/button@1.11.2`, etc.

3. Bundle package is prototyping-only
   - Problem: `@spectrum-web-components/bundle` is officially discouraged for production.
   - Why: Makes version management hard, includes everything (huge bundle), can't tree-shake.
   - Fix: Use individual packages in production. Bundle only for quick prototypes and CDN demos.

4. No SSR
   - Problem: SWC components require browser APIs (Shadow DOM, `customElements.define()`).
   - Why: Web Components are a browser standard — no server-side equivalent exists natively.
   - Fix: In Next.js: `dynamic(() => import('./Component'), { ssr: false })`. In general: render SWC only on the client.

5. Side-effect imports only
   - Problem: Components don't render if you forget to import their registration file.
   - Why: Each `import '@spectrum-web-components/button/sp-button.js'` runs side-effect code that calls `customElements.define()`. No import = no registration = browser ignores the unknown tag.
   - Fix: Explicitly import every element used. Check HTML for any `<sp-*>` tag without a matching import.

**Important (Less Common but Painful):**

6. React `onChange` mismatch
   - Problem: `onChange` doesn't fire for SWC form controls in React.
   - Why: SWC fires native DOM events. React's synthetic `onChange` doesn't intercept them.
   - Fix: Use `onInput` instead when using `@swc-react/*` wrappers.

7. Safari memory leak
   - Problem: Input elements inside SWC components are not garbage collected in Safari.
   - Why: Known Safari bug — reported at GitHub #4197.
   - Fix: No workaround available. Be aware when building long-lived SPAs targeting Safari. Monitor memory in Safari Web Inspector.

8. `dir` attribute timing
   - Problem: Setting `dir` on an element before it's attached to the DOM breaks RTL inheritance.
   - Why: `SpectrumMixin` resolves `dir` from the parent `sp-theme` on attachment. Pre-set `dir` prevents resolution.
   - Fix: Set `dir` after DOM attachment, or set it on `<sp-theme>` directly and let children inherit.

9. Overlay + `contain: paint`
   - Problem: Overlays (popover, tooltip, dialog) cannot escape ancestors with CSS `contain: paint`.
   - Why: CSS containment spec prevents content from painting outside the containing box.
   - Fix: Restructure DOM so overlays are not nested inside elements with `contain: paint`, `contain: layout`, or `overflow: hidden`.

10. CDN loads Lit in dev mode
    - Problem: JSPM CDN bundle produces "Spectrum Web Components is in dev mode" console warnings.
    - Why: CDN serves the development build by default.
    - Fix: Ignore for prototyping. For production, use npm packages with a proper build tool (Vite/Webpack).

**API Migration (v1.0.0 Breaking Changes):**

11. `system` attribute, not `theme`
    - Problem: `<sp-theme theme="spectrum">` no longer works.
    - Why: `theme` attribute was removed in v1.0.0, replaced by `system`.
    - Fix: `<sp-theme system="spectrum-two" ...>`.

12. `sp-button href` deprecated
    - Problem: Using `href`, `target`, `download` on `<sp-button>` is deprecated.
    - Why: Buttons and links are semantically different. Using button as link breaks accessibility.
    - Fix: Use native `<a>` element styled with Spectrum CSS classes. Or use `<sp-link>`.

13. `--system-*` variables are auto-generated
    - Problem: Setting `--system-*` CSS custom properties has no reliable effect and may break.
    - Why: These are generated by `postcss-add-theming-layer` at build time. Names change between builds.
    - Fix: Use `--mod-*` prefix for component customization. Use `--spectrum-*` for global token values.

14. `sp-field-group` invalid sync
    - Problem: Setting `invalid` only on `sp-field-group` shows error text but doesn't style the checkboxes. Setting `invalid` only on checkboxes styles them but doesn't show error text.
    - Why: `sp-field-group` controls help-text slot visibility. Individual checkboxes control their own visual styling. Neither propagates to the other.
    - Fix: Set `invalid` on BOTH: `<sp-field-group invalid>` AND `<sp-checkbox invalid>`.

Target: ~100 lines.

- [ ] **Step 2: Commit**

```bash
git add skills/spectrum-2-web/references/GOTCHAS.md
git commit -m "feat(spectrum-2-web): add gotchas reference"
```

---

### Task 7: Create SKILL.md

**Files:**
- Create: `skills/spectrum-2-web/SKILL.md`

- [ ] **Step 1: Write SKILL.md**

Write to `skills/spectrum-2-web/SKILL.md`. This is the main skill prompt. Must follow the conventions exactly:

**Frontmatter** (YAML):
```yaml
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
```

**Body structure** (~450 lines). Must reference all 6 reference files using **markdown link syntax** (not backtick code spans — tessl only recognizes markdown links):

```markdown
# Spectrum 2 Web

Design and build web UIs using Adobe Spectrum 2 with Spectrum Web
Components (SWC) or vanilla CSS with Spectrum design tokens.
```

**Phase 1 — Classify** (always runs, no references loaded):

Detailed instructions for:
1. Reading the user's request and classifying intent:
   - **Design + Build** — user describes what they want ("build me a settings page") → Phase 2 then 3
   - **Build only** — user has a design/mockup ("implement this layout with SWC") → Phase 3 only
   - **Design only** — user wants layout advice ("what layout for a dashboard?") → Phase 2 only

2. Determining output tier:
   - Static/presentational (landing page, marketing page, no interactivity) → **vanilla CSS + Spectrum tokens**
   - Interactive (forms, overlays, navigation, tabs, pickers, controls) → **Spectrum Web Components**
   - User can override explicitly

3. Detecting context:
   - Check for `package.json` with `@spectrum-web-components/*` → project-aware output (npm imports, separate files)
   - Otherwise → self-contained HTML file (CDN via JSPM, inline styles, opens in browser)

**Phase 2 — Design** (if intent includes design):

Instructions to:
1. Read [the design principles](references/DESIGN-PRINCIPLES.md) for S2 visual rules
2. Read [the layout patterns](references/LAYOUT-PATTERNS.md) for canonical app shells
3. Identify closest layout pattern or compose from principles
4. Apply S2 principles: depth layers, spacing tokens, typography, semantic colors, accessibility
5. Describe the proposed layout to user: sections, component choices, navigation, hierarchy
6. Note S2 compliance considerations
7. Get user confirmation before building

**Phase 3 — Build** (if intent includes build):

Instructions to:
1. Read [the setup and theming guide](references/SETUP-AND-THEMING.md) for installation and `sp-theme`
2. Read [the component guide](references/COMPONENT-GUIDE.md) for component selection and patterns
3. Read [the token reference](references/TOKEN-REFERENCE.md) for CSS customization
4. Read [the gotchas guide](references/GOTCHAS.md) and check every component against it

5. Generate output based on detected context:

   **Self-contained output** (no project):
   - Single HTML file with `<!DOCTYPE html>`
   - CDN import: `<script src="https://jspm.dev/@spectrum-web-components/bundle/elements.js" type="module" async></script>`
   - `<sp-theme system="spectrum-two" color="light" scale="medium">` wrapping all content
   - `<style>` block using Spectrum tokens for layout
   - Ready to open in browser

   **Project-aware output** (npm project detected):
   - JS file with individual side-effect imports for each component used
   - HTML/template with `<sp-theme system="spectrum-two">` wrapper
   - CSS file using Spectrum tokens
   - Note which packages to install (all same version)

6. SWC output checklist (verify before delivering):
   - [ ] `<sp-theme system="spectrum-two">` wraps all components
   - [ ] Every `<sp-*>` tag has a matching import
   - [ ] Form fields use label → field → help-text stacking
   - [ ] Icon-only buttons have `label` attribute
   - [ ] Overlays use `trigger="id@interaction"` syntax
   - [ ] No deprecated APIs (variant→static-color, theme→system, href on button)
   - [ ] No `--system-*` overrides (use `--mod-*`)

7. Vanilla CSS output checklist:
   - [ ] Semantic HTML elements
   - [ ] All custom properties use `--spectrum-*` tokens
   - [ ] Token definitions included (CDN link or inline)
   - [ ] Accessible: contrast, headings, labels

**S2 Compliance** (throughout):
- Default to full S2 compliance
- Accept explicit user overrides → apply and note deviation
- Always use `system="spectrum-two"` unless user explicitly requests S1

Target: ~450 lines. Under 500.

- [ ] **Step 2: Lint the skill**

```bash
tessl skill lint skills/spectrum-2-web
```

Expected: zero warnings. If orphaned reference warnings appear, check that all `references/*.md` files are linked with markdown link syntax `[label](references/FILE.md)` in SKILL.md.

- [ ] **Step 3: Commit**

```bash
git add skills/spectrum-2-web/SKILL.md
git commit -m "feat(spectrum-2-web): add main skill prompt"
```

---

### Task 8: Lint, Test, and Publish Sync

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `.claude/CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Run tessl lint**

```bash
tessl skill lint skills/spectrum-2-web
```

Expected: zero warnings, zero errors. Fix any issues before proceeding.

- [ ] **Step 2: Run tessl review**

```bash
tessl skill review skills/spectrum-2-web/SKILL.md
```

Expected: 70%+ on all three dimensions (Validation, Description/Activation, Content/Implementation). If below 70%, iterate on the SKILL.md.

- [ ] **Step 3: Sync local**

```bash
./scripts/sync-skills.sh
```

This copies `skills/spectrum-2-web/SKILL.md` → `~/.claude/commands/spectrum-2-web.md`.

- [ ] **Step 4: Update plugin.json**

Edit `.claude-plugin/plugin.json`. Add `spectrum-2-web` to the description string (alphabetical order within the skill listing) and add keywords: `"spectrum-2-web"`, `"spectrum-web-components"`, `"swc"`, `"spectrum-2"`, `"adobe-design-system"`.

- [ ] **Step 5: Update marketplace.json**

Edit `.claude-plugin/marketplace.json`. Add `spectrum-2-web` to the plugin description string.

- [ ] **Step 6: Update CLAUDE.md skills table**

Edit `.claude/CLAUDE.md`. Add row to the "Available Skills" table:

```markdown
| `spectrum-2-web` | Design and build web UIs with Spectrum 2 + Spectrum Web Components |
```

- [ ] **Step 7: Update README.md**

Edit `README.md`. Add a new section under "Available Skills":

```markdown
### spectrum-2-web

Design and build web UIs with Adobe Spectrum 2 design system. Outputs
vanilla CSS with Spectrum tokens (static pages) or Spectrum Web
Components (interactive apps). Recommends output tier based on
complexity.

See [SKILL.md](skills/spectrum-2-web/SKILL.md) for details.
```

- [ ] **Step 8: Commit all sync files**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json .claude/CLAUDE.md README.md
git commit -m "feat(spectrum-2-web): update plugin manifests and docs"
```

---

### Task 9: Live Test

This task is manual — test the skill on real prompts in a fresh Claude Code session.

- [ ] **Step 1: Test Design + Build intent**

In a new Claude Code session, run:
```
/spectrum-2-web Build me a settings page for a photo editing app with sidebar navigation, dark mode toggle, and account preferences
```

Verify:
- Skill classifies as Design + Build
- Loads design principles and layout patterns
- Proposes Settings Panel layout (Pattern 5)
- Generates SWC output with `system="spectrum-two"`
- All components have matching imports
- Uses correct slot patterns, overlay syntax

- [ ] **Step 2: Test Build only intent**

```
/spectrum-2-web Convert this to SWC: I need a form with name, email, country picker, and a terms checkbox with validation
```

Verify:
- Skips design phase
- Generates SWC form with field-label → textfield → help-text stacking
- Uses `sp-picker` for country, `sp-field-group` for checkbox
- Correct `invalid` sync on field-group AND checkbox

- [ ] **Step 3: Test vanilla CSS tier**

```
/spectrum-2-web Create a simple landing page hero section with a heading, subtitle, and call-to-action button
```

Verify:
- Recommends vanilla CSS + tokens (static, no interactivity)
- Uses `--spectrum-*` tokens for styling
- Semantic HTML, no `<sp-*>` components
- Accessible contrast

- [ ] **Step 4: Note any issues**

Record problems for iteration. Common issues from similar skills:
- Missing imports for components used in HTML
- Deprecated API patterns (variant="cta" instead of variant="accent")
- Missing `sp-theme` wrapper
- Wrong import paths (S1 instead of spectrum-two/)
