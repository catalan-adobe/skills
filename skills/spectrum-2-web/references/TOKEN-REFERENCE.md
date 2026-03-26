# Spectrum 2 Token Reference

CSS design token system for Spectrum 2 Web Components.

## Table of Contents

1. [Token Naming Convention](#token-naming-convention)
2. [Three-Tier Hierarchy](#three-tier-hierarchy)
3. [Tokens by Purpose](#tokens-by-purpose)
   - [Spacing](#spacing)
   - [Gray Scale](#gray-scale)
   - [Semantic Background Colors](#semantic-background-colors)
   - [Typography](#typography)
   - [Component Sizing](#component-sizing)
   - [Border Radius](#border-radius)
   - [Animation](#animation)
4. [S2 Color System](#s2-color-system)
5. [`--mod-*` Customization Pattern](#--mod--customization-pattern)
6. [CSS Parts](#css-parts)
7. [`--system-*` Warning](#--system--warning)
8. [Practical CSS Examples](#practical-css-examples)
9. [S1 → S2 Token Migration](#s1--s2-token-migration)

## Token Naming Convention

```
--spectrum-[context]-[unit]-[clarification]
```

Examples: `--spectrum-spacing-300`, `--spectrum-gray-700`,
`--spectrum-actionbutton-border-color-default`

## Three-Tier Hierarchy

```
Global     --spectrum-gray-500          (raw values, never override)
  → Alias  --spectrum-negative-border-color-default  (semantic meaning)
    → Component --spectrum-actionbutton-border-color-default
```

- **Global**: Raw values. Stable but rarely used directly in app CSS.
- **Alias**: Semantic tokens. Theme-aware. Primary choice for app styling.
- **Component**: Used internally by web components. Overridable via `--mod-*`.

---

## Tokens by Purpose

### Spacing

| Token | Value |
|-------|-------|
| `--spectrum-spacing-75` | 6px |
| `--spectrum-spacing-100` | 8px |
| `--spectrum-spacing-200` | 16px |
| `--spectrum-spacing-300` | 24px |
| `--spectrum-spacing-400` | 32px |
| `--spectrum-spacing-500` | 40px |
| `--spectrum-spacing-600` | 48px |

### Gray Scale

14-step ramp; in light theme 50=near-white, 900=near-black. Dark theme is independent (not inversion).

| Token | Light theme | Dark theme |
|-------|-------------|------------|
| `--spectrum-gray-50` | White | Dark gray |
| `--spectrum-gray-100` | Near-white | Slightly lighter |
| `--spectrum-gray-200` | Light gray | — |
| `--spectrum-gray-300` | — | — |
| `--spectrum-gray-400` | Mid-light | — |
| `--spectrum-gray-500` | Mid gray | Mid gray |
| `--spectrum-gray-600` | — | — |
| `--spectrum-gray-700` | — | — |
| `--spectrum-gray-800` | Dark gray | — |
| `--spectrum-gray-900` | Near-black | Near-white |

Contrast guarantees: gray-700 ≥ 3:1, gray-900 ≥ 4.5:1 against background.

### Semantic Background Colors

| Token | Usage |
|-------|-------|
| `--spectrum-background-base-color` | Page background |
| `--spectrum-background-layer-1-color` | Cards, panels |
| `--spectrum-background-layer-2-color` | Nested panels, sidebars |
| `--spectrum-negative-border-color-default` | Error state borders |
| `--spectrum-disabled-background-color` | Disabled controls |

### Typography

| Token | Value |
|-------|-------|
| `--spectrum-font-size-75` | 12px |
| `--spectrum-font-size-100` | 14px |
| `--spectrum-font-size-200` | 16px |
| `--spectrum-font-size-300` | 18px |
| `--spectrum-font-size-400` | 20px |
| `--spectrum-font-size-500` | 22px |
| `--spectrum-font-size-600` | 25px |
| `--spectrum-font-size-700` | 28px |
| `--spectrum-font-size-800` | 32px |
| `--spectrum-font-size-900` | 36px |
| `--spectrum-font-size-1000` | 40px |
| `--spectrum-font-size-1100` | 45px |
| `--spectrum-font-size-1200` | 50px |
| `--spectrum-font-size-1300` | 60px |

Font family: `--spectrum-sans-font-family-stack`,
`--spectrum-serif-font-family-stack`, `--spectrum-code-font-family-stack`

Font weight: `--spectrum-regular-font-weight`, `--spectrum-bold-font-weight`

### Component Sizing

| Token | Usage |
|-------|-------|
| `--spectrum-component-height-75` | Small (XS) controls |
| `--spectrum-component-height-100` | Medium controls (default) |
| `--spectrum-component-height-200` | Large controls |
| `--spectrum-component-height-300` | XL controls |

### Border Radius

| Token | Value |
|-------|-------|
| `--spectrum-corner-radius-75` | 4px |
| `--spectrum-corner-radius-100` | 8px |
| `--spectrum-corner-radius-200` | 16px |

### Animation

| Token | Value |
|-------|-------|
| `--spectrum-animation-duration-100` | 130ms |
| `--spectrum-animation-duration-200` | 160ms |
| `--spectrum-animation-duration-300` | 190ms |
| `--spectrum-animation-duration-400` | 220ms |
| `--spectrum-animation-ease-in-out` | cubic-bezier(0.45, 0, 0.40, 1) |
| `--spectrum-animation-ease-in` | cubic-bezier(0.50, 0, 1, 1) |
| `--spectrum-animation-ease-out` | cubic-bezier(0, 0, 0.40, 1) |

---

## S2 Color System

- Model: CAM02-UCS perceptual uniformity
- Color ramps: 14 steps (100–1400) per hue
- Gray tones: 11 steps (50–900)
- Dark theme: independently designed palettes, not a simple inversion
- Contrast guarantees: 700≥3:1, 900≥4.5:1 against their background tokens
- 5 semantic categories: neutral, informative, positive, negative, notice

### Static Colors

Static colors (`--spectrum-red-900-static`, etc.) do not flip between themes.
Use them when you need a color that stays fixed regardless of color scheme —
e.g., brand imagery, data visualization, illustrations.

---

## `--mod-*` Customization Pattern

Web components expose `--mod-*` custom properties as a stable override API.
Each component CSS uses a three-layer fallback cascade:

```css
/* Internal component CSS (read-only — shown for understanding) */
background-color: var(
  --highcontrast-actionbutton-background-color-default,
  var(--mod-actionbutton-background-color-default,
    var(--spectrum-actionbutton-background-color-default)
  )
);
```

**Priority** (highest to lowest):

1. `--highcontrast-*` — forced colors mode (OS-level, do not set manually)
2. `--mod-*` — your customization layer (set these)
3. `--spectrum-*` — Spectrum defaults (fallback)

Setting `--spectrum-*` directly on a component is fragile and may conflict
with the component's own cascade. Always use `--mod-*`.

### Worked Examples

**Custom button variant:**

```css
.danger-zone sp-button {
  --mod-actionbutton-border-color-default: var(--spectrum-negative-border-color-default);
  --mod-actionbutton-background-color-default: var(--spectrum-negative-background-color-default);
  --mod-actionbutton-label-color: var(--spectrum-white);
}
```

**Tighter text field:**

```css
.compact-form sp-textfield {
  --mod-textfield-height: var(--spectrum-component-height-75);
  --mod-textfield-font-size: var(--spectrum-font-size-75);
}
```

**Subdued picker:**

```css
.sidebar sp-picker {
  --mod-picker-background-color-default: transparent;
  --mod-picker-border-color-default: var(--spectrum-gray-300);
}
```

---

## CSS Parts

For deeper DOM-level styling where `--mod-*` is insufficient, use `::part()`:

```css
/* Button inner element */
sp-button::part(button) {
  letter-spacing: 0.05em;
}

/* Textfield input element */
sp-textfield::part(input) {
  font-family: var(--spectrum-code-font-family-stack);
}

/* Overlay container */
sp-popover::part(content) {
  max-height: 400px;
  overflow-y: auto;
}
```

Parts are stable public API. Check each component's Storybook for its
exposed part names.

---

## `--system-*` Warning

`--system-*` tokens are auto-generated internal mappings between the token
tiers. They are unstable and will change without notice between releases.

**Never reference or override `--system-*` tokens in application CSS.**

---

## Practical CSS Examples

### Panel

```css
.panel {
  background: var(--spectrum-background-layer-2-color);
  border: 1px solid var(--spectrum-gray-300);
  border-radius: var(--spectrum-corner-radius-100);
  padding: var(--spectrum-spacing-300);
}
```

### Header Bar

```css
.app-header {
  background: var(--spectrum-background-base-color);
  border-bottom: 1px solid var(--spectrum-gray-200);
  padding: 0 var(--spectrum-spacing-400);
  height: var(--spectrum-component-height-200);
  display: flex;
  align-items: center;
  gap: var(--spectrum-spacing-200);
}

.app-header h1 {
  font-size: var(--spectrum-font-size-400);
  font-weight: var(--spectrum-bold-font-weight);
  color: var(--spectrum-gray-900);
}
```

### Content Card

```css
.content-card {
  background: var(--spectrum-background-layer-1-color);
  border: 1px solid var(--spectrum-gray-200);
  border-radius: var(--spectrum-corner-radius-100);
  padding: var(--spectrum-spacing-300);
  display: flex;
  flex-direction: column;
  gap: var(--spectrum-spacing-200);
  transition: box-shadow var(--spectrum-animation-duration-100)
    var(--spectrum-animation-ease-out);
}

.content-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}

.content-card__title {
  font-size: var(--spectrum-font-size-300);
  font-weight: var(--spectrum-bold-font-weight);
}

.content-card__body {
  font-size: var(--spectrum-font-size-100);
  color: var(--spectrum-gray-700);
}
```

### Section Container

```css
.section {
  background: var(--spectrum-background-base-color);
  padding: var(--spectrum-spacing-400) var(--spectrum-spacing-600);
  max-width: 1280px;
  margin: 0 auto;
}

.section + .section {
  border-top: 1px solid var(--spectrum-gray-200);
}

.section__heading {
  font-size: var(--spectrum-font-size-600);
  margin-bottom: var(--spectrum-spacing-300);
  color: var(--spectrum-gray-900);
}
```

---

## S1 → S2 Token Migration

| S1 (old) | S2 (new) |
|----------|----------|
| `--spectrum-global-color-gray-800` | `--spectrum-gray-800` |
| `--spectrum-global-color-blue-500` | `--spectrum-blue-500` |
| `--spectrum-global-dimension-size-100` | `--spectrum-spacing-100` |
| `--spectrum-global-dimension-size-300` | `--spectrum-spacing-300` |
| `@spectrum-css/vars` | `@spectrum-css/tokens` |

**CSS class changes:**

```html
<!-- S1 -->
<div class="spectrum spectrum--light">...</div>

<!-- S2 -->
<div class="spectrum spectrum--light">...</div>
<!-- .spectrum now activates S2; .spectrum--legacy activates S1 -->
```

**Scale factor:** `--spectrum-global-dimension-size-*` dimension tokens are
removed in S2. For scale-aware sizing, use `--swc-scale-factor` with the
component sizing tokens:

```css
/* S1 pattern (avoid) */
padding: var(--spectrum-global-dimension-size-200);

/* S2 pattern */
padding: var(--spectrum-spacing-200);
```
