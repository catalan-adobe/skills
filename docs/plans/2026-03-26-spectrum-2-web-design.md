# spectrum-2-web Design Spec

## Overview

**Name:** `spectrum-2-web`

**Purpose:** Design and build web UIs using Adobe Spectrum 2 design
system. The skill applies S2 layout principles, visual hierarchy,
spacing, and component composition to produce clean, accessible
interfaces. Outputs either vanilla CSS with Spectrum design tokens
(static pages) or full Spectrum Web Components (interactive apps).

**Depends on:** Nothing — fully self-contained, no MCP or network
dependencies.

**Draft description (< 1024 chars):**
Design and build web UIs with Adobe Spectrum 2 design system. Applies
S2 layout principles, visual hierarchy, spacing, and component
composition to produce accessible interfaces. Outputs vanilla CSS with
Spectrum tokens (static pages) or Spectrum Web Components (interactive
apps). Recommends tier based on complexity. Covers sp-theme setup,
side-effect imports, overlay system, form patterns, --mod-* token
customization, and 14 critical gotchas. Use for: spectrum 2 web, SWC,
sp-button, sp-theme, build UI with spectrum, S2 layout, spectrum
application, adobe design system, web component form, spectrum overlay.

## Background

Adobe Spectrum 2 is the latest overhaul of Adobe's design system,
announced December 2023 and GA in code libraries since late 2024.
Spectrum Web Components (SWC) v1.11.2 is the framework-agnostic
implementation — LitElement-based custom elements with Shadow DOM,
CSS custom property theming, and 68 production-ready components.

Existing skills (`react-spectrum-s2`, `spectrum-2:*`) cover React
Spectrum S2 only. No skill exists for Spectrum Web Components or for
applying S2 design principles to generate compliant layouts. This
skill fills that gap.

Full research: `docs/plans/2026-03-26-spectrum-web-components-research.md`

## Design Decisions

### Audience

Anyone wanting S2-compliant UIs. The skill teaches Claude how to
produce correct S2 output — the user doesn't need Spectrum expertise.

### Output Tier Selection

The skill recommends the appropriate tier based on what's being built:
- **Vanilla CSS + Spectrum tokens** — static content, landing pages,
  marketing pages, simple layouts with no interactivity
- **Spectrum Web Components** — forms, overlays, navigation, tabs,
  pickers, interactive controls, application UIs

The user can override this recommendation explicitly.

### Self-Contained

All knowledge is embedded in SKILL.md + `references/` files. No MCP
servers, no network fetching, no external dependencies. Works offline,
behind firewalls, and in any environment.

### Context-Aware Output

The skill detects the project context:
- `package.json` with `@spectrum-web-components/*` → project-aware
  output with npm import paths, separate files
- No project detected → self-contained HTML file with CDN imports
  via JSPM, inline styles, ready to open in browser

### Layout Knowledge

Combines canonical patterns (5 app shells) with composition rules:
- Patterns provide speed — adapt a known-good layout
- Rules provide flexibility — compose from scratch when no pattern fits

### S2 Compliance

Guided flexibility:
- Default to full S2 compliance (tokens, spacing, hierarchy,
  accessibility, `system="spectrum-two"`)
- Accept explicit user overrides, apply them, note the deviation
- Never block the user — the skill is a helper, not an enforcer

## Architecture

### Single Skill, Adaptive Workflow

One skill with three phases. Phase 1 always runs. Phases 2 and 3
activate based on classified intent.

```
skills/spectrum-2-web/
├── SKILL.md                      # ~450 lines: adaptive workflow
└── references/
    ├── DESIGN-PRINCIPLES.md      # ~250 lines
    ├── SETUP-AND-THEMING.md      # ~200 lines
    ├── LAYOUT-PATTERNS.md        # ~300 lines
    ├── COMPONENT-GUIDE.md        # ~300 lines
    ├── TOKEN-REFERENCE.md        # ~200 lines
    └── GOTCHAS.md                # ~100 lines
```

References are loaded progressively — only the files needed for the
active phase are read, keeping context usage efficient.

### Phase 1 — Classify (always runs, no references loaded)

1. Read the user's request
2. Classify intent:
   - **Design + Build** — "build me a settings page" → Phase 2 then 3
   - **Build only** — "implement this mockup with SWC" → Phase 3
   - **Design only** — "what layout for a dashboard?" → Phase 2
3. Determine output tier:
   - Static/presentational → vanilla CSS + Spectrum tokens
   - Interactive (forms, overlays, navigation) → SWC
4. Detect context:
   - `package.json` with `@spectrum-web-components/*` → project-aware
   - Otherwise → self-contained HTML (CDN via JSPM)

### Phase 2 — Design

**Loads:** `DESIGN-PRINCIPLES.md` + `LAYOUT-PATTERNS.md`

1. Read design principles reference
2. Identify the closest canonical layout pattern
3. Apply S2 principles: depth layers, spacing tokens, typography,
   semantic colors, accessibility baseline
4. Describe the proposed layout: sections, component choices,
   navigation approach, visual hierarchy
5. Note S2 compliance considerations
6. Get user confirmation before building

### Phase 3 — Build

**Loads:** `SETUP-AND-THEMING.md` + `COMPONENT-GUIDE.md` +
`TOKEN-REFERENCE.md` + `GOTCHAS.md`

1. Read setup guide — installation approach, theming setup
2. Read component guide — select components, check for gaps (date
   pickers, tree view not available), apply correct patterns
3. Read token reference — proper tokens for custom CSS, `--mod-*`
   for customizations
4. Check every component against GOTCHAS.md
5. Generate code:

**Self-contained output** (no project detected):
- Single HTML file
- CDN imports via JSPM (`<script type="module">`)
- `<style>` block with Spectrum tokens
- Ready to open in browser

**Project-aware output** (existing npm project):
- Separate files fitting existing structure
- npm import paths (`@spectrum-web-components/*/sp-*.js`)
- Proper `package.json` dependency additions if needed

**SWC output always includes:**
- `<sp-theme system="spectrum-two">` wrapper
- All required side-effect imports (no missing registrations)
- Correct slot usage (help-text, icons, headings, buttons)
- Proper form patterns (field-label + field + help-text stacking)
- Overlay trigger syntax when overlays are used

**Vanilla CSS output always includes:**
- Semantic HTML
- Spectrum token CSS custom properties
- Token definitions (link to `@spectrum-css/tokens` or inline)

## Reference File Contents

### DESIGN-PRINCIPLES.md (~250 lines)

S2 design knowledge for the design phase.

- **S2 design pillars**: expressive, accessible, platform-contextual
- **Visual hierarchy**: 3 depth layers (base=frame, layer-1=headers/nav,
  layer-2=content) with background token mappings
- **Spacing system**: `--spectrum-spacing-*` tokens — which values for
  padding, gaps, margins, section separation
- **Typography scale**: heading hierarchy (XXS–XXXL), body (XS–XXXL),
  detail (uppercase labels), code styles; Adobe Clean Spectrum VF font
- **S2 color usage**: semantic colors — informative (blue), negative
  (red), notice (orange), positive (green), neutral (gray). When to
  use each. Static colors that don't flip between light/dark themes.
- **Accessibility baseline**: WCAG 2.1 AA baked into S2. Contrast
  indices (700-index ≥ 3:1 for large text, 900-index ≥ 4.5:1 for
  small text WCAG AA). Auto-managed ARIA attributes — don't override
  `aria-expanded`, `aria-invalid`, `aria-current`, `aria-hidden`.
  Shadow DOM ARIA limitation (use slots, not `aria-describedby`
  across shadow roots). Keyboard navigation built into every composite
  widget. Label requirements: icon-only buttons MUST have `label`
  attribute.
- **Responsive approach**: `scale="medium"` for desktop,
  `scale="large"` for touch. Nested `sp-theme` for mixed regions.
- **Component composition rules**: grouping related controls, section
  separation with `sp-divider`, action button placement conventions,
  form field stacking order (label → field → help-text)

### SETUP-AND-THEMING.md (~200 lines)

Installation and theming setup for the build phase.

- **SWC vs React Spectrum S2**: decision table — when to use which,
  key differences (framework coupling, SSR, CDN, style macros,
  component coverage)
- **Installation patterns**:
  - npm individual packages (production) — all must be identical
    versions
  - Bundle package (prototyping only — officially discouraged)
  - CDN via JSPM (prototyping — JSPM handles export conditions,
    unpkg/jsDelivr do not)
- **ESM-only**: no CommonJS, `.js` extensions required in imports
- **Side-effect import pattern**: each import self-registers a custom
  element, must explicitly import every element used, tree-shaking
  cannot auto-discover them
- **Auto-imported dependencies**: button→icons-ui, picker→popover,
  overlay→underlay (don't need to import these manually)
- **`<sp-theme>` setup**: mandatory ancestor, distributes CSS custom
  properties to DOM scope. Three dimensions:
  - `system`: `spectrum` (S1), `express` (deprecated), `spectrum-two`
  - `color`: `light`, `dark` (`lightest`/`darkest` deprecated)
  - `scale`: `medium` (desktop), `large` (touch)
  - Additional: `lang` (BCP 47), `dir` (`ltr`/`rtl`)
- **S2 activation**: `system="spectrum-two"` + spectrum-two/ import
  paths for theme files
- **Nested themes**: mixing light/dark, LTR/RTL, medium/large in
  same page
- **Dynamic theme switching**: lazy-loading theme variants at runtime
  with `import()` + attribute updates
- **Context detection logic**: check for `package.json` with SWC
  dependencies → project-aware; otherwise → self-contained CDN

### LAYOUT-PATTERNS.md (~300 lines)

5 canonical app shell patterns with complete runnable examples.

Each pattern includes:
- When to use it
- Complete self-contained HTML (CDN imports + styles + markup)
- Key Spectrum tokens used
- Responsive behavior notes

**Patterns:**
1. **Sidebar + Main** — `sp-sidenav` + CSS Grid `240px 1fr`.
   Settings pages, admin panels, documentation sites.
2. **Top Nav + Content** — `sp-top-nav` + full-width header.
   Public-facing apps, simple tool UIs.
3. **Dashboard** — CSS Grid multi-column, `sp-card`, `sp-meter`,
   `sp-status-light`, `sp-progress-bar`. Analytics, monitoring.
4. **Form Page** — vertical field stacking, field-label→field→help-text,
   button row at bottom. Data entry, registration, onboarding.
5. **Settings Panel** — `sp-sidenav` + `sp-tabs` combined.
   Nested categories with tabbed sub-sections.

### COMPONENT-GUIDE.md (~300 lines)

Component inventory and usage patterns for the build phase.

- **Compact component inventory**: all 68 components grouped by
  category (buttons, forms, color, navigation, overlays, data display,
  content/layout, onboarding, icons) with package names and element
  tags in table format
- **Removed components**: `sp-banner`→`sp-alert-banner`,
  `sp-quick-actions`→`sp-action-bar`, `sp-split-button`→button group
- **Deprecated API changes**: `variant`→`static-color`,
  `theme`→`system`, `href` on button removed, `cta`→`accent`,
  `over-background`→`static-color`, position values→logical
  equivalents, size names→numeric sizes
- **Component gaps vs React Spectrum**: date pickers (Date Picker,
  Date Range Picker, Date Field, Time Field, Calendar, Range Calendar),
  composite Color Picker, Tree View, ListView — skill should not
  attempt to generate these, suggest alternatives or note the gap
- **Form patterns**: help-text slot system (slot="help-text" default,
  slot="negative-help-text" auto-shown when invalid), field-group
  validation sync hazard (set `invalid` on group AND each checkbox),
  field-label `for` attribute, invisible labels via `label` attribute
- **Overlay patterns**: trigger syntax (`trigger="id@click|hover|
  longpress"`), 5 overlay types (hint/auto/manual/modal/page) with
  behavior table, VirtualTrigger for context menus, programmatic
  control (`overlay.open`, `sp-opened`/`sp-closed` events), delayed
  warmup (1000ms) and cooldown
- **Slot composition reference**: table of all named slots per
  component (icon, heading, button, help-text, negative-help-text,
  label)
- **Action group selection**: `selects="single"` (radio) vs
  `selects="multiple"` (checkbox)
- **React integration**: `@swc-react/*` packages (replace scope name),
  62+ components, `onChange`→`onInput` for forms, Next.js static
  export via `/next.js` entry point, JSX `IntrinsicElements`
  declaration merging needed for custom element tags

### TOKEN-REFERENCE.md (~200 lines)

Token system and CSS customization for the build phase.

- **Token naming convention**: `--spectrum-[context]-[unit]-[clarification]`
- **Three-tier hierarchy**: global (raw values, e.g. `--spectrum-gray-500`)
  → alias (semantic, e.g. `--spectrum-negative-border-color-default`)
  → component (specific, e.g. `--spectrum-actionbutton-border-color-default`)
- **Most-used tokens by purpose**: organized tables for spacing,
  color, typography, sizing, border-radius, animation duration
- **S2 color system**: CAM02-UCS perceptual color space. 14-step
  ramps per color family (100–1400). 11 gray tones (50–900). Contrast
  indices: 700 ≥ 3:1 (large text/icons), 900 ≥ 4.5:1 (WCAG AA small
  text). Dark theme designed independently (not light inverted).
  Semantic aliases: informative, negative, notice, positive, neutral.
  Static colors (`static-*`) don't flip between themes.
- **The `--mod-*` customization pattern**: three-level CSS fallback
  (`--highcontrast-*` > `--mod-*` > `--spectrum-*`). Worked examples
  of customizing button background, border colors, component sizing.
- **CSS parts (`::part()`)**: styling component internals
  (`sp-button::part(button)`, `sp-textfield::part(input)`)
- **`--system-*` warning**: auto-generated bridge variables, unstable
  across builds, never override
- **Practical CSS examples**: custom panels, cards, section containers,
  headers using only Spectrum tokens — complete CSS blocks ready to use
- **S1→S2 token migration**: dropped `global-color-` infix
  (`--spectrum-global-color-gray-800` → `--spectrum-gray-800`),
  `@spectrum-css/vars` → `@spectrum-css/tokens`, `.spectrum` class
  now means S2 (`.spectrum--legacy` for S1),
  `--spectrum-global-dimension-size-*` → use `--swc-scale-factor`

### GOTCHAS.md (~100 lines)

14 critical pitfalls organized by severity.

**Critical (common, high impact):**
1. `sp-theme` mandatory — unstyled without it, no warning
2. All packages must be same version — registry conflicts
3. Bundle package is prototyping-only
4. No SSR — `dynamic(() => import(), { ssr: false })` in Next.js
5. Side-effect imports only — must import each element explicitly

**Important (less common but painful):**
6. React `onChange` mismatch — use `onInput` via swc-react
7. Safari memory leak — inputs not garbage collected (#4197)
8. `dir` attribute timing — set after DOM attachment
9. Overlay + `contain: paint` — overlays can't escape
10. CDN loads Lit in dev mode — console warnings

**API migration (v1.0.0 breaking changes):**
11. `system` attribute, not `theme`
12. `sp-button href` deprecated — use native `<a>`
13. `--system-*` variables auto-generated — use `--mod-*`
14. `sp-field-group` invalid sync — set on group AND checkbox

Each entry: what happens, why, fix/workaround.

## What This Skill Does NOT Cover

- **Style macros** — React Spectrum S2 only
- **SSR patterns** — web components don't support SSR
- **`@react-spectrum/s2` API** — different library, covered by
  existing `react-spectrum-s2` skill
- **React Aria** — different library
- **Building custom web components** — this skill is about using the
  design system, not extending it
- **Figma/design tool workflows** — code output only
