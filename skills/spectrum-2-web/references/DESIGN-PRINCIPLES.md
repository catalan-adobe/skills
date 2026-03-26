# Spectrum 2 Design Principles

Reference for the `spectrum-2-web` skill — loaded during the Design phase.

## Table of Contents

1. [S2 Design Pillars](#s2-design-pillars)
2. [Visual Hierarchy — Depth Layers](#visual-hierarchy--depth-layers)
3. [Spacing System](#spacing-system)
4. [Typography Scale](#typography-scale)
5. [Color Usage](#color-usage)
6. [Accessibility Baseline](#accessibility-baseline)
7. [Responsive Approach](#responsive-approach)
8. [Component Composition Rules](#component-composition-rules)

---

## S2 Design Pillars

Spectrum 2 is built on three pillars that inform every design decision:

**Expressive** — rounder corners, richer color palettes, and Adobe Clean Spectrum VF (a variable font
that supports optical sizing and weight axes). S2 components feel alive and branded while staying
functional.

**Accessible** — WCAG 2.1 AA is baked into the token system, not bolted on. Color ramp indices 700+
meet large-text contrast; 900+ meet small-text contrast. ARIA management is automatic inside
components — don't override it.

**Platform-contextual** — S2 adapts to OS conventions via `colorScheme` (light/dark/auto) and
`scale` (medium for desktop/mouse, large for touch/mobile). Components honor reduced-motion, forced
colors, and high-contrast modes without extra work.

---

## Visual Hierarchy — Depth Layers

S2 uses three background layers to establish depth. Apply them consistently to create a coherent
spatial model — closer to the user means higher layer number.

| Layer | Token | Intended Use |
|-------|-------|--------------|
| Base | `--spectrum-background-base-color` | Application chrome, window frame, outer borders |
| Layer 1 | `--spectrum-background-layer-1-color` | Headers, side navigation, panels behind content |
| Layer 2 | `--spectrum-background-layer-2-color` | General content area, card surfaces, modal dialogs |

**Rules:**
- Never reverse layer order (Layer 2 must never sit behind Layer 1 in the visual stack).
- Overlays (dialogs, popovers, tooltips) float above all three layers — they use their own
  surface tokens (`--spectrum-overlay-background-color`), not the depth-layer tokens.
- Borders between adjacent layers use `--spectrum-gray-200` in light, `--spectrum-gray-700` in dark.
  Use `sp-divider` rather than raw CSS borders wherever possible.

---

## Spacing System

All spacing uses a geometric scale anchored to a 4 px base. Use these tokens for padding, margin,
gap, and positioning — never hardcode pixel values.

| Token | Value | Typical Use |
|-------|-------|-------------|
| `--spectrum-spacing-50` | 4 px | Icon internal padding, micro-gaps |
| `--spectrum-spacing-75` | 6 px | Tight inline spacing, dense lists |
| `--spectrum-spacing-100` | 8 px | Compact control padding, chip gaps |
| `--spectrum-spacing-200` | 16 px | Standard gap between sibling elements |
| `--spectrum-spacing-300` | 24 px | Section padding, card internal padding |
| `--spectrum-spacing-400` | 32 px | Larger section gaps, dialog padding |
| `--spectrum-spacing-500` | 40 px | Major visual separation within a page |
| `--spectrum-spacing-600` | 48 px | Between distinct page sections or zones |

**Usage guidance:**
- `75`–`100`: tight contexts — dense data tables, compact toolbars, icon-to-label gaps.
- `200`: default gap between form fields, action buttons, and list items.
- `300`–`400`: card padding, section headers, dialog internal padding.
- `500`–`600`: separating major page zones (e.g., header from body, sidebar from main content).

**Layout preference:** use CSS Grid `gap` and Flexbox `gap` with these tokens. Avoid `margin-top`
on the first child; use `gap` on the parent instead.

```css
.action-bar {
  display: flex;
  gap: var(--spectrum-spacing-200);
  padding: var(--spectrum-spacing-300);
}
```

---

## Typography Scale

Adobe Clean Spectrum VF is the sole typeface. It ships as a variable font with `wght` (100–900) and
`opsz` (optical size) axes — let the S2 tokens drive both axes automatically.

### Heading Sizes

| Variant | Token | Weight | Use |
|---------|-------|--------|-----|
| `heading-size-xxxl` | `--spectrum-font-size-1300` | Bold/Heavy | Hero headlines, splash screens |
| `heading-size-xxl` | `--spectrum-font-size-1100` | Bold | Page titles |
| `heading-size-xl` | `--spectrum-font-size-900` | Bold | Section headers |
| `heading-size-l` | `--spectrum-font-size-700` | SemiBold | Panel headers |
| `heading-size-m` (default) | `--spectrum-font-size-500` | SemiBold | Card headers, widget titles |
| `heading-size-s` | `--spectrum-font-size-300` | SemiBold | Subsection labels |
| `heading-size-xs` | `--spectrum-font-size-200` | SemiBold | Tight subheadings |
| `heading-size-xxs` | `--spectrum-font-size-75` | Bold | Micro-labels needing heading treatment |

### Body Sizes

| Variant | Token | Use |
|---------|-------|-----|
| `body-size-xxxl` | `--spectrum-font-size-600` | Lead paragraphs, marketing copy |
| `body-size-xxl` | `--spectrum-font-size-500` | Large readable body text |
| `body-size-xl` | `--spectrum-font-size-400` | Comfortable reading |
| `body-size-l` | `--spectrum-font-size-300` | Default body text |
| `body-size-m` (default) | `--spectrum-font-size-200` | Standard UI prose |
| `body-size-s` | `--spectrum-font-size-75` | Captions, footnotes |
| `body-size-xs` | `--spectrum-font-size-50` | Legal text, timestamps |

### Detail (Uppercase Labels)

Detail text uses letter-spacing and uppercase transforms — for category labels, column headers in
tables, and metadata.

| Variant | Token | Sizes |
|---------|-------|-------|
| `detail-size-xl` | `--spectrum-font-size-200` | Prominent category labels |
| `detail-size-l` | `--spectrum-font-size-100` | Standard detail labels |
| `detail-size-m` | `--spectrum-font-size-75` | Default detail text |
| `detail-size-s` | `--spectrum-font-size-50` | Compact metadata |

### Code / Monospace

| Variant | Token | Use |
|---------|-------|-----|
| `code-size-xl` | `--spectrum-font-size-300` | Large code blocks |
| `code-size-l` | `--spectrum-font-size-200` | Standard code blocks |
| `code-size-m` (default) | `--spectrum-font-size-100` | Inline code, shell output |
| `code-size-s` | `--spectrum-font-size-75` | Compact code snippets |
| `code-size-xs` | `--spectrum-font-size-50` | Dense log output |

**Usage notes:**
- Use `<sp-body>`, `<sp-heading>`, `<sp-detail>`, `<sp-code>` elements — they wire up the correct
  tokens and optical sizing automatically.
- Don't set `font-size` directly on UI text — always go through size variants or tokens.
- Line height tokens (`--spectrum-line-height-100`, `--spectrum-line-height-200`) are set
  automatically by S2 typography components.

---

## Color Usage

S2 colors are semantic, not decorative. Each hue carries a meaning — use it consistently.

### Semantic Color Categories

**Informative / Accent (blue)**
- Primary actions (the single most important CTA on screen)
- Selected states in pickers, tabs, and navigation
- Links and interactive text
- Focus rings and active indicators

**Negative (red)**
- Error messages and validation failures
- Destructive actions (delete, remove, disconnect)
- Alert badges for critical issues

**Notice (orange)**
- Warnings — the action is allowed but carries risk
- Caution states in status badges
- "Proceed carefully" affordances

**Positive (green)**
- Success states — upload complete, payment accepted, file saved
- Completion indicators
- Confirmation feedback

**Neutral (gray)**
- Default UI chrome — borders, dividers, backgrounds
- Disabled states — use gray at reduced opacity, not a different hue
- Secondary text and placeholder text

### Static Colors

Tokens prefixed with `static-` (`--spectrum-static-white`, `--spectrum-static-black`, etc.) do NOT
flip between light and dark themes. Use them for:
- Content placed on colored backgrounds (e.g., white text on an accent-colored banner)
- Brand marks and logos that must remain consistent
- Photography overlays

Never use static colors for interactive UI — they break dark mode.

### Color Ramp Index Guide

S2 ramps run 100–1600 within each hue. Index semantics:
- 100–400: backgrounds, subtle fills, hover states
- 500–600: borders, disabled foregrounds
- 700: minimum for large text (≥ 3:1 contrast in most themes)
- 900: minimum for body text (≥ 4.5:1 contrast)
- 1000–1300: high-emphasis text, icons on light backgrounds
- 1400–1600: maximum contrast (use sparingly)

---

## Accessibility Baseline

S2 handles most accessibility automatically. Your job is to not break it.

### Contrast — Built Into Token Indices

WCAG 2.1 AA thresholds are guaranteed by index, not by you:
- **700+** on any hue → ≥ 3:1 against the layer backgrounds (large text / graphics)
- **900+** on any hue → ≥ 4.5:1 against the layer backgrounds (body text / UI components)

Do not use ramp indices below 700 for any text or interactive UI element.

### ARIA — Hands Off

S2 components auto-manage these attributes — overriding them breaks the contract:
- `aria-expanded` — set by `sp-accordion`, `sp-picker`, `sp-popover`
- `aria-invalid` — set by form controls when `invalid` attribute is present
- `aria-current="page"` — set by `sp-sidenav-item` and `sp-top-nav-item`
- `aria-hidden="true"` — set on decorative icons inside buttons

If you need to reflect state, use the component's own attributes (`invalid`, `disabled`,
`selected`, `expanded`) and let the component manage ARIA internally.

### Shadow DOM ARIA Limitation

Cross-shadow-root `aria-describedby` does not work in current browsers. Use slot-based help text
instead:

```html
<!-- Wrong: aria-describedby cannot cross shadow root boundaries -->
<sp-textfield aria-describedby="help"></sp-textfield>
<span id="help">Must be 8+ characters</span>

<!-- Correct: sp-help-text inside the component via slot -->
<sp-textfield>
  <sp-help-text slot="help-text">Must be 8+ characters</sp-help-text>
</sp-textfield>
```

### Keyboard Navigation

All composite widgets have keyboard navigation built in — do not reimplement it:
- `sp-action-group` — arrow keys move focus between items
- `sp-tabs` — arrow keys cycle tabs; Enter/Space activates
- `sp-sidenav` — arrow keys navigate tree nodes
- `sp-picker` — arrow keys navigate options; Enter selects
- `sp-split-view` — arrow keys resize panes

Do not add `tabindex` to items inside these composites — it breaks the roving tabindex pattern.

### Icon-Only Buttons

Every button with no visible text label MUST have a `label` attribute:

```html
<sp-action-button label="Delete item">
  <sp-icon-delete slot="icon"></sp-icon-delete>
</sp-action-button>
```

### Form Control Labels

Every form control needs an associated label — either via `sp-field-label` with a `for` attribute,
or a `label` attribute directly on the control:

```html
<sp-field-label for="email">Email address</sp-field-label>
<sp-textfield id="email" type="email"></sp-textfield>
```

Never rely on `placeholder` as the sole label — it disappears on input and is not reliably announced.

### Focus Management

- Overlays (`sp-dialog-wrapper`, `sp-popover`) trap focus on open and restore it to the trigger on close.
- Do not move focus manually inside overlays — the overlay component handles it.
- Focus rings appear only on keyboard navigation (`focus-visible`) — this is automatic.
- When building custom overlays (not using S2 components), implement focus trap with the
  `inert` attribute on background content.

---

## Responsive Approach

### Scale Attribute

```html
<!-- Desktop / mouse-primary UI -->
<sp-theme scale="medium">...</sp-theme>

<!-- Mobile / touch-primary UI -->
<sp-theme scale="large">...</sp-theme>
```

`scale="large"` increases touch target sizes across all components to meet WCAG 2.5.5 (44×44 px
minimum). Switch scale based on device capability, not screen width.

### Mixed Regions

Use nested `sp-theme` to apply a different scale to a specific region:

```html
<sp-theme scale="medium">
  <!-- Desktop toolbar -->
  <sp-action-bar>...</sp-action-bar>

  <sp-theme scale="large">
    <!-- Touch-optimized canvas area -->
    <canvas-region>...</canvas-region>
  </sp-theme>
</sp-theme>
```

### Layout Breakpoints

`scale` controls component sizing only. Use standard CSS media queries for layout changes:

```css
.layout {
  display: grid;
  grid-template-columns: 1fr;
}

@media (min-width: 768px) {
  .layout {
    grid-template-columns: 240px 1fr;
  }
}
```

Don't use JavaScript to detect breakpoints — CSS handles layout, `scale` handles component density.

---

## Component Composition Rules

### Form Stacking Order

Always: label → field → help text. Never rearrange.

```html
<sp-field-label for="name">Full name</sp-field-label>
<sp-textfield id="name" placeholder="Jane Smith"></sp-textfield>
<sp-help-text slot="help-text">Used on your account profile</sp-help-text>
```

Group related controls with `sp-field-group` — it handles spacing and alignment automatically.

### Section Separation

Use `sp-divider` between logical sections instead of margin hacks:

```html
<section>
  <sp-heading size="m">Account Settings</sp-heading>
  <!-- form fields -->
</section>
<sp-divider></sp-divider>
<section>
  <sp-heading size="m">Notifications</sp-heading>
  <!-- form fields -->
</section>
```

### Button Placement and Priority

- One primary (accent) button per view — rightmost in horizontal groups.
- Secondary and tertiary actions go to the left of primary.
- Destructive actions use `variant="negative"` and are separated from the primary group.

```html
<sp-button-group>
  <sp-button variant="secondary" treatment="outline">Cancel</sp-button>
  <sp-button variant="accent">Save changes</sp-button>
</sp-button-group>
```

### Toggle Action Groups

For mutually exclusive selections (view mode, filter state), use `sp-action-group` with `selects`:

```html
<sp-action-group selects="single" label="View mode">
  <sp-action-button value="grid">Grid</sp-action-button>
  <sp-action-button value="list">List</sp-action-button>
</sp-action-group>
```

### Navigation Pattern Selection

| Pattern | Component | Use When |
|---------|-----------|----------|
| Deep hierarchy (3+ levels) | `sp-sidenav` | File browsers, settings trees, admin dashboards |
| Shallow hierarchy (≤ 2 levels) | `sp-top-nav` | Marketing sites, app-level navigation |
| Same-page sections | `sp-tabs` | Detail pages, settings panels, multi-step forms |

Never mix navigation patterns on the same level — pick one and apply it consistently.

### Overlay and Popover Usage

| Use Case | Component |
|----------|-----------|
| Confirmation, blocking task | `sp-dialog-wrapper` (modal) |
| Contextual options, rich tooltips | `sp-popover` (non-modal) |
| Status feedback (auto-dismiss) | `sp-toast` |
| Simple text-only hint | `sp-tooltip` |

Avoid stacking modals — if a modal action requires another modal, reconsider the flow. Use
progressive disclosure within a single dialog instead.
