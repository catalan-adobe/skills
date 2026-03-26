# Spectrum Web Components + Spectrum 2 — Research

Pre-design research for a Claude Code skill that helps build UIs with
Adobe Spectrum 2 design system using Spectrum Web Components (SWC).

**Date:** 2026-03-26
**Sources:** 70+ authoritative sources across 6 parallel research agents

---

## 1. Spectrum 2 Design System — Status

### What Changed from S1

Three design pillars distinguish S2 from S1:

| Dimension | Spectrum 1 | Spectrum 2 |
|-----------|-----------|-----------|
| Aesthetic | Subdued gray, minimalist | Expressive, approachable, rounder |
| Accessibility | Basic compliance | WCAG 2.1 AA built in; adaptive palettes |
| Platform fit | Cross-platform uniform | Platform-contextual (macOS/Win/iOS/web) |
| Color | Gray-dominant | Adobe brand colors integrated; CAM02-UCS |
| Typography | Adobe Clean (static) | Adobe Clean Spectrum VF (variable font) |
| Icons | Sharp, rational | Rounded, thicker strokes, higher contrast |

S2 was inspired by the Adobe Express sub-brand's visual language.

### GA Timeline

| Milestone | Date |
|-----------|------|
| S2 announced | December 12, 2023 |
| SWC v1.0.0 (S2 GA in web components) | October 31, 2024 |
| React Spectrum v1.0.0 (S2 GA in React) | December 16, 2025 |
| SWC current version | v1.11.2 (March 2026) |

### Documentation Sites

- `spectrum.adobe.com` — Spectrum 1 spec, principles, resources
- `s2.spectrum.adobe.com` — Spectrum 2 spec (forward-looking reference)
- `opensource.adobe.com/spectrum-web-components/` — SWC library docs
- `react-spectrum.adobe.com` — React Spectrum docs

### Adobe Product Adoption

Already using S2: Express, Firefly, Acrobat Web, Creative Cloud Web.
Planned: Photoshop, Lightroom, Premiere desktop (in progress). 100+ apps
on the roadmap.

---

## 2. SWC Architecture

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Standard | Custom Elements v1 |
| Encapsulation | Shadow DOM (mandatory via `SpectrumMixin`) |
| Rendering | LitElement (reactive, declarative templates) |
| Base class | `SpectrumElement = SpectrumMixin(LitElement)` |
| Theming | CSS Custom Properties via `<sp-theme>` |
| Package structure | Monorepo, one npm package per component |
| Language | TypeScript (63.1% of codebase) |

### Stability

- **v1.11.2** — all packages versioned in lockstep
- Production-ready; Adobe uses internally (Lightroom Web, Fonts,
  Education Exchange, Photoshop)
- ~1,400 GitHub stars, 5,146+ commits, 60+ contributors
- Repo restructured into `1st-gen/` (68 components, stable) and
  `2nd-gen/` (7 components, nascent next-gen architecture)

### Browser Support

Latest 2 major versions of Chrome, Firefox, Edge, Safari macOS.
Mobile browser support is not yet guaranteed (limited testing).

---

## 3. Theming

### Three Dimensions

| Attribute | Values | Default | Notes |
|-----------|--------|---------|-------|
| `system` | `spectrum`, `express` (deprecated), `spectrum-two` | `spectrum` | Design variant |
| `color` | `light`, `dark` | `light` | `lightest`/`darkest` deprecated |
| `scale` | `medium`, `large` | `medium` | Large = mobile/touch sizing |

Additional attributes: `lang` (BCP 47 locale), `dir` (`ltr`/`rtl`).

### `<sp-theme>` is Mandatory

`sp-theme` is not optional styling — it distributes design tokens as CSS
custom properties to its DOM scope. Without it, components render
completely unstyled. No console warning.

### S2 Activation

```js
import '@spectrum-web-components/theme/sp-theme.js';
import '@spectrum-web-components/theme/spectrum-two/theme-light.js';
import '@spectrum-web-components/theme/spectrum-two/scale-medium.js';
```

```html
<sp-theme system="spectrum-two" color="light" scale="medium">
  <!-- All SWC components use S2 tokens here -->
</sp-theme>
```

### S1 (Default) Setup

```js
import '@spectrum-web-components/theme/sp-theme.js';
import '@spectrum-web-components/theme/theme-light.js';
import '@spectrum-web-components/theme/scale-medium.js';
```

```html
<sp-theme system="spectrum" color="light" scale="medium">
  ...
</sp-theme>
```

### Nested Themes

```html
<sp-theme system="spectrum-two" color="light" scale="medium">
  <sp-button>Light button</sp-button>
  <sp-theme color="dark" scale="large" dir="rtl">
    <sp-button>Dark, large, RTL button</sp-button>
  </sp-theme>
</sp-theme>
```

### Dynamic Theme Switching

```js
async function updateTheme(system, color, scale) {
  const base = system === 'spectrum' ? '' : `${system}/`;
  await Promise.all([
    import(`@spectrum-web-components/theme/${base}theme-${color}.js`),
    import(`@spectrum-web-components/theme/${base}scale-${scale}.js`),
  ]);
  const el = document.querySelector('sp-theme');
  Object.assign(el, { system, color, scale });
}
```

### Breaking Changes from Pre-1.0

- `theme` attribute removed → use `system` attribute
- `color="lightest"` / `color="darkest"` → deprecated
- `system="express"` → deprecated (will be removed)

---

## 4. Installation & Imports

### Individual Packages (Production)

```bash
npm install \
  @spectrum-web-components/theme@1.11.2 \
  @spectrum-web-components/button@1.11.2 \
  @spectrum-web-components/textfield@1.11.2
```

**All packages must use identical versions.** Mixed versions cause
custom element registry conflicts at runtime.

### Bundle Package (Prototyping Only)

```bash
npm install @spectrum-web-components/bundle
```

```js
import '@spectrum-web-components/bundle/elements.js';
```

Officially discouraged for production: "we DO NOT suggest leveraging
this technique in a production application."

### CDN (Prototyping Only)

```html
<script
  src="https://jspm.dev/@spectrum-web-components/bundle/elements.js"
  type="module" async
></script>
```

JSPM CDN handles export conditions correctly. unpkg/jsDelivr do not.
CDN loads Lit in dev mode ("not recommended for production" warning).

### Side-Effect Import Pattern

Every component import is a side-effect that registers the custom
element. No default export. Must explicitly import every element used.

```js
// Each import self-registers a custom element
import '@spectrum-web-components/button/sp-button.js';
import '@spectrum-web-components/textfield/sp-textfield.js';
import '@spectrum-web-components/field-label/sp-field-label.js';
```

Some packages auto-import internal dependencies:
- button → icons-ui
- picker → popover
- overlay → underlay

### ESM Only

No CommonJS bundles. File extensions required in import paths (`.js`).

---

## 5. Token System

### Three-Tier Hierarchy

```
@adobe/spectrum-tokens (JSON source of truth, v14.1.0)
    ↓ (Style Dictionary transform)
@spectrum-css/tokens (CSS custom properties)
    ↓
Global tokens    --spectrum-gray-500, --spectrum-blue-700
    ↓ (referenced by)
Alias tokens     --spectrum-negative-border-color-default
    ↓ (applied via)
Component tokens --spectrum-actionbutton-border-color-default
    ↓ (auto-generated bridge)
System vars      --system-action-button-... (DO NOT USE)
    ↓ (CSS fallback chain)
Mod overrides    --mod-actionbutton-background-color-default (SAFE)
```

### Token Packages

- `@adobe/spectrum-tokens` (v14.1.0) — JSON source, repo renamed to
  `adobe/spectrum-design-data`. S2 on `main`, S1 on `s1-legacy`.
- `@spectrum-css/tokens` — CSS output for Spectrum CSS consumers
- `@spectrum-web-components/styles` — CSS output for SWC consumers
  - `styles/tokens` — Express + Spectrum (S1)
  - `styles/tokens-v2` — Spectrum 2

### The `--mod-*` Pattern — Official Customization API

Every component has a three-level CSS fallback:

```css
background-color: var(
  --highcontrast-actionbutton-background-color-default,  /* WHCM */
  var(
    --mod-actionbutton-background-color-default,         /* OVERRIDE */
    var(--spectrum-actionbutton-background-color-default) /* DEFAULT */
  )
);
```

Priority: `--highcontrast-*` > `--mod-*` > `--spectrum-*`

Customization: set `--mod-*` variables.

```css
sp-action-button {
  --mod-actionbutton-background-color-default: var(--spectrum-blue-100);
}
```

Available overrides per component documented in `mods.md` files in the
Spectrum CSS repo.

### Token Naming Conventions

Pattern: `--spectrum-[context]-[unit]-[clarification]`

```css
/* Global tokens (raw values) */
--spectrum-gray-500
--spectrum-blue-700
--spectrum-corner-radius-100
--spectrum-font-size-200          /* 16px medium, 19px large */
--spectrum-spacing-300

/* Semantic/alias tokens (named by purpose) */
--spectrum-negative-border-color-default
--spectrum-disabled-background-color
--spectrum-background-base-color

/* Consumer overrides (safe to set) */
--mod-actionbutton-background-color-default
--mod-button-border-color

/* Internal bridge — NEVER use */
--system-action-button-border-color-default
```

### S2 Color System

- Color space: CAM02-UCS (perceptually uniform, not HSL)
- Color ramps: 14 steps per family (100–1400), 11 gray tones (50–900)
- Contrast: 700-index ≥ 3:1 (large text), 900-index ≥ 4.5:1 (WCAG AA)
- Dark theme designed independently (not light inverted)
- Semantic aliases: `informative` (blue), `negative` (red), `notice`
  (orange), `positive` (green), `neutral` (gray)
- Static colors (`static-*`) — don't flip between light/dark
- Three visual depth layers: base (frame), layer-1 (headers/nav),
  layer-2 (content)

### Using Tokens in Custom CSS

```css
.my-panel {
  background: var(--spectrum-gray-100);
  border: 1px solid var(--spectrum-gray-300);
  border-radius: var(--spectrum-corner-radius-100);
  padding: var(--spectrum-spacing-300);
  font-size: var(--spectrum-font-size-100);
}
```

### S1 → S2 Token Migration

| S1 | S2 |
|----|-----|
| `--spectrum-global-color-gray-800` | `--spectrum-gray-800` |
| `@spectrum-css/vars` | `@spectrum-css/tokens` |
| `.spectrum` CSS class | `.spectrum--legacy` |
| N/A | `.spectrum` = S2 now |

`--spectrum-global-dimension-size-*` has no direct S2 parallel. Use
`--swc-scale-factor` as a multiplier instead.

---

## 6. Component Inventory (68 components)

### Buttons & Actions

| Package | Tags |
|---------|------|
| `button` | `<sp-button>`, `<sp-clear-button>`, `<sp-close-button>` |
| `button-group` | `<sp-button-group>` |
| `action-button` | `<sp-action-button>` |
| `action-bar` | `<sp-action-bar>` |
| `action-group` | `<sp-action-group>` |
| `action-menu` | `<sp-action-menu>` |
| `picker-button` | `<sp-picker-button>` |
| `infield-button` | `<sp-infield-button>` |

### Form Controls

| Package | Tags |
|---------|------|
| `checkbox` | `<sp-checkbox>` |
| `radio` | `<sp-radio>`, `<sp-radio-group>` |
| `switch` | `<sp-switch>` |
| `textfield` | `<sp-textfield>`, `<sp-textarea>` |
| `number-field` | `<sp-number-field>` |
| `search` | `<sp-search>` |
| `combobox` | `<sp-combobox>` |
| `picker` | `<sp-picker>` |
| `slider` | `<sp-slider>`, `<sp-slider-handle>` |
| `field-group` | `<sp-field-group>` |
| `field-label` | `<sp-field-label>` |
| `help-text` | `<sp-help-text>` |

### Color Tools

| Package | Tags |
|---------|------|
| `color-area` | `<sp-color-area>` |
| `color-field` | `<sp-color-field>` |
| `color-handle` | `<sp-color-handle>` |
| `color-loupe` | `<sp-color-loupe>` |
| `color-slider` | `<sp-color-slider>` |
| `color-wheel` | `<sp-color-wheel>` |
| `swatch` | `<sp-swatch>`, `<sp-swatch-group>` |

### Navigation

| Package | Tags |
|---------|------|
| `tabs` | `<sp-tabs>`, `<sp-tab>`, `<sp-tab-panel>` |
| `sidenav` | `<sp-sidenav>`, `<sp-sidenav-item>`, `<sp-sidenav-heading>` |
| `top-nav` | `<sp-top-nav>`, `<sp-top-nav-item>` |
| `breadcrumbs` | `<sp-breadcrumbs>`, `<sp-breadcrumb-item>` |
| `menu` | `<sp-menu>`, `<sp-menu-group>`, `<sp-menu-item>` |
| `accordion` | `<sp-accordion>`, `<sp-accordion-item>` |
| `link` | `<sp-link>` |

### Overlays & Dialogs

| Package | Tags |
|---------|------|
| `dialog` | `<sp-dialog>`, `<sp-dialog-base>`, `<sp-dialog-wrapper>` |
| `alert-dialog` | `<sp-alert-dialog>` |
| `popover` | `<sp-popover>` |
| `tooltip` | `<sp-tooltip>` |
| `toast` | `<sp-toast>` |
| `tray` | `<sp-tray>` |
| `overlay` | `<sp-overlay>`, `<sp-overlay-trigger>` |
| `underlay` | `<sp-underlay>` |
| `modal` | `<sp-modal>` |
| `contextual-help` | `<sp-contextual-help>` |

### Data Display

| Package | Tags |
|---------|------|
| `table` | `<sp-table>`, `<sp-table-head>`, `<sp-table-body>`, `<sp-table-row>`, `<sp-table-cell>` |
| `card` | `<sp-card>` |
| `avatar` | `<sp-avatar>` |
| `badge` | `<sp-badge>` |
| `status-light` | `<sp-status-light>` |
| `meter` | `<sp-meter>` |
| `progress-bar` | `<sp-progress-bar>` |
| `progress-circle` | `<sp-progress-circle>` |
| `thumbnail` | `<sp-thumbnail>` |
| `tags` | `<sp-tags>`, `<sp-tag>` |

### Content & Layout

| Package | Tags |
|---------|------|
| `asset` | `<sp-asset>` |
| `illustrated-message` | `<sp-illustrated-message>` |
| `divider` | `<sp-divider>` |
| `alert-banner` | `<sp-alert-banner>` |
| `split-view` | `<sp-split-view>` |
| `dropzone` | `<sp-dropzone>` |

### Onboarding & Icons

| Package | Tags |
|---------|------|
| `coachmark` | `<sp-coachmark>`, `<sp-coach-indicator>` |
| `icon` | `<sp-icon>` |
| `icons-ui` | Various `<sp-icon-*>` |
| `icons-workflow` | Various `<sp-icon-*>` |
| `iconset` | `<sp-iconset>` |

### Tool Packages

| Package | Purpose |
|---------|---------|
| `base` | SpectrumElement base class |
| `bundle` | All-in-one import (prototyping) |
| `grid` | CSS Grid layout helpers |
| `opacity-checkerboard` | Background for color pickers |
| `reactive-controllers` | Shared reactive controllers |
| `shared` | Utilities and mixins |
| `styles` | Global Spectrum CSS tokens |
| `theme` | `<sp-theme>` element |
| `truncated` | Text truncation component |

### Removed in v1.0.0

| Removed | Replacement |
|---------|-------------|
| `<sp-banner>` | `<sp-alert-banner>` |
| `<sp-quick-actions>` | `<sp-action-bar>` |
| `<sp-split-button>` | Button group pattern |

### Deprecated API Changes (v1.0.0)

| Component | Old API | New API |
|-----------|---------|---------|
| `sp-action-button` | `variant` attribute | `static-color="black"/"white"` |
| `sp-badge` | `top/bottom/left/right` | `block-start/block-end/inline-start/inline-end` |
| `sp-button` | `variant="cta"` | `variant="accent"` |
| `sp-button` | `variant="over-background"` | `static-color` |
| `sp-button` | `href` attribute | Use native `<a>` instead |
| `sp-popover` | `dialog` attribute | Slot an `<sp-dialog>` |
| `sp-progress-circle` | `over-background` | `static-color="white"` |
| `sp-theme` | `theme` attribute | `system` attribute |
| `sp-thumbnail` | `xxs/xs/s/m/l` sizes | `100/300/500/700/900` |

### Notable Gaps vs React Spectrum

| Missing from SWC | React Spectrum Status |
|------------------|-----------------------|
| Date Picker | GA |
| Date Range Picker | GA |
| Date Field | GA |
| Time Field | GA |
| Calendar | GA |
| Range Calendar | GA |
| Composite Color Picker | GA (Oct 2024) |
| Tree View | GA (2025) |
| ListView | GA in S2 |

Date/time components are the most-requested missing group (GitHub #3299).

---

## 7. Key Patterns

### Form Handling — Help Text Slots

```html
<sp-textfield id="email" type="email">
  <sp-help-text slot="help-text">
    Shown by default (neutral state)
  </sp-help-text>
  <sp-help-text slot="negative-help-text">
    Auto-shown when invalid=true
  </sp-help-text>
</sp-textfield>
```

The component self-manages the slot swap. No JavaScript needed for
basic show/hide.

### Form Handling — Validation Sync Hazard

When using `sp-field-group` for checkbox validation, set `invalid` on
**both** the group (controls help text) AND each checkbox (controls
visual styling). Missing one creates a sync hazard.

```html
<sp-field-group vertical label="Terms" invalid>
  <sp-checkbox invalid required name="terms">Accept</sp-checkbox>
  <sp-help-text slot="negative-help-text">Required</sp-help-text>
</sp-field-group>
```

### Form Labels

```html
<!-- Visible label with for attribute -->
<sp-field-label for="name" required>Name</sp-field-label>
<sp-textfield id="name"></sp-textfield>

<!-- Invisible label via attribute -->
<sp-textfield label="Search query"></sp-textfield>

<!-- Icon-only button MUST have label attribute -->
<sp-button icon-only label="Close dialog">
  <sp-icon-close slot="icon"></sp-icon-close>
</sp-button>
```

### Overlay System (v0.37+ — Native Top-Layer APIs)

Uses native `<dialog>`/`showModal()` and `popover`/`showPopover()`.
Content stays in the DOM (no portalling), preserving Shadow DOM
encapsulation and CSS inheritance.

```html
<sp-button id="btn">Open</sp-button>

<!-- Click → modal dialog -->
<sp-overlay trigger="btn@click" type="modal">
  <sp-dialog>
    <h2 slot="heading">Confirm</h2>
    <p>Are you sure?</p>
    <sp-button slot="button" variant="secondary">Cancel</sp-button>
    <sp-button slot="button" variant="accent">Confirm</sp-button>
  </sp-dialog>
</sp-overlay>

<!-- Hover → tooltip -->
<sp-overlay trigger="btn@hover" type="hint" placement="top">
  <sp-tooltip>Helpful text</sp-tooltip>
</sp-overlay>

<!-- Long-press (mobile) -->
<sp-overlay trigger="btn@longpress" placement="bottom-start">
  <sp-popover>
    <sp-dialog><h2 slot="heading">Menu</h2></sp-dialog>
  </sp-popover>
</sp-overlay>
```

Trigger syntax: `trigger="elementId@interaction"` where interaction is
`click`, `hover`, or `longpress`.

#### Overlay Types

| Type | Outside click closes | Focus trapped | Use case |
|------|---------------------|---------------|----------|
| `hint` | Yes (non-interactive) | No | Tooltips |
| `auto` | Yes | Yes | Dropdowns, pickers |
| `manual` | No | Yes | Persistent panels |
| `modal` | No | Yes (trapped) | Dialogs |
| `page` | No | Yes (trapped) | Blocking operations |

#### Programmatic Control

```js
const overlay = document.querySelector('sp-overlay');
overlay.open = true;
overlay.addEventListener('sp-opened', () => {});
overlay.addEventListener('sp-closed', () => {});
```

#### Virtual Trigger (Context Menu)

```js
import { VirtualTrigger } from '@spectrum-web-components/overlay';

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  overlay.triggerElement = new VirtualTrigger(e.clientX, e.clientY);
  overlay.open = true;
});
```

### Slot Composition

| Component | Slot | Purpose |
|-----------|------|---------|
| `sp-button` | `icon` | Icon before label |
| `sp-dialog` | `heading` | Dialog title (also aria label) |
| `sp-dialog` | `button` | Action buttons at bottom |
| `sp-textfield` | `help-text` | Default descriptive text |
| `sp-textfield` | `negative-help-text` | Error text (auto-shown) |
| `sp-picker` | `label` | Placeholder label |
| `sp-tab` | `icon` | Tab icon |

### Action Group (Selection)

```html
<!-- Single select (radio) -->
<sp-action-group selects="single">
  <sp-action-button value="left">Left</sp-action-button>
  <sp-action-button value="center" selected>Center</sp-action-button>
  <sp-action-button value="right">Right</sp-action-button>
</sp-action-group>

<!-- Multi-select (checkbox) -->
<sp-action-group selects="multiple">
  <sp-action-button value="bold">B</sp-action-button>
  <sp-action-button value="italic">I</sp-action-button>
</sp-action-group>
```

### Layout — No Native Containers

SWC has no Grid/Flex container components. Use CSS with Spectrum tokens:

```css
.app-layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: var(--spectrum-spacing-400);
  padding: var(--spectrum-spacing-300);
}
```

### CSS Parts (Component Internals)

```css
sp-button::part(button) { border-radius: 0; }
sp-textfield::part(input) { font-family: 'Custom Font'; }
```

### CSS File Architecture (Internal)

- `spectrum-[name].css` — Generated from Spectrum CSS (do not edit)
- `[name]-overrides.css` — System-specific `--system-*` overrides
- `[name].css` — Imports above + SWC custom styles

---

## 8. Accessibility

### Auto-Managed by SWC (Don't Override)

- `aria-expanded` on pickers and expandable sidenav items
- `aria-current="page"` on selected sidenav items with `href`
- `aria-hidden="true"` on decorative icons
- `aria-invalid` on form controls with `invalid` attribute

### Shadow DOM ARIA Limitation

Cannot reference elements across shadow roots with `aria-describedby`.
Use `slot="help-text"` inside the component instead.

### Keyboard Navigation (Built-In)

- `sp-action-group`: Arrow keys between buttons
- `sp-tabs`: Arrow keys between tabs
- `sp-sidenav`: Arrow keys expand/collapse, Enter navigates
- `sp-picker`: Arrow keys through options
- `sp-split-view`: Arrow keys move splitter when focused

### Roving Tab Index

`@spectrum-web-components/tools/roving-tab-index` implements WAI-ARIA
roving tabindex for composite widgets. Arrow key navigation (all
directions + Home/End), direction modes (horizontal/vertical/both/grid).

### Internationalization

30+ languages. RTL via CSS `:dir()` pseudo-class (inherited from DOM).
`LanguageResolutionController` tracks locale across shadow boundaries.

---

## 9. React Integration (`swc-react`)

Replace `@spectrum-web-components` scope with `@swc-react`:

```bash
npm install @swc-react/button @swc-react/theme @swc-react/textfield
```

62+ components available as React wrappers.

```jsx
import { Theme } from '@swc-react/theme';
import { Button } from '@swc-react/button';

function App() {
  return (
    <Theme system="spectrum" scale="medium" color="light">
      <Button variant="accent">Click me</Button>
    </Theme>
  );
}
```

### Next.js Static Export

```jsx
import { Button } from '@swc-react/button/next.js';
```

### Known Issues

- `onChange` doesn't work for form controls — use `onInput`
- Custom Lit annotations incompatible with standard `@lit-labs/gen-wrapper-react`
- JSX needs `IntrinsicElements` declaration merging for custom element tags

---

## 10. SWC vs React Spectrum S2

| Dimension | SWC | React Spectrum S2 |
|-----------|-----|-------------------|
| Framework | Any (Lit/Web Components) | React only |
| React integration | `@swc-react/*` wrappers | Native |
| SSR / Next.js | No (client-only) | Full support |
| CDN / no-build | Yes (JSPM) | No |
| Style macros | No | Yes (build-time, typed) |
| Date/time components | Missing | Full suite |
| MCP server | No | `@react-spectrum/mcp` |
| Adobe add-ons | Recommended by Adobe | Secondary |
| npm downloads | ~365/week (bundle) | ~44-87k/month |

### When to Choose SWC

- Adobe Express / CEP add-ons (Adobe's own recommendation)
- Angular, Vue, or non-React framework
- Multi-framework microfrontends
- CDN prototyping (no build step)
- No SSR requirement

### When to Choose React Spectrum S2

- React-only app
- SSR / Next.js / Remix
- Full date/time component suite needed
- Style macro system wanted
- Highest external community support

---

## 11. Known Gotchas

### Critical (Common, High Impact)

1. **`sp-theme` is mandatory** — components render completely unstyled
   without an ancestor `<sp-theme>`. No console warning.

2. **All packages must be the same version** — mixed versions cause
   custom element registry conflicts at runtime.

3. **Bundle package is prototyping-only** — officially discouraged for
   production. Tutorials sometimes mislead on this.

4. **No SSR** — web components require browser APIs. In Next.js:
   `dynamic(() => import(...), { ssr: false })`.

5. **Side-effect imports only** — must explicitly import each element.
   Tree-shaking cannot auto-discover components.

### Important (Less Common but Painful)

6. **React `onChange` mismatch** — SWC fires native DOM events. React's
   synthetic `onChange` doesn't map. Use `onInput` via `swc-react`.

7. **Safari memory leak** — input elements inside SWC components aren't
   garbage collected (GitHub #4197).

8. **`dir` attribute timing** — setting `dir` before DOM attachment
   breaks RTL inheritance from parent `sp-theme`.

9. **Overlay + `contain: paint`** — overlays cannot escape ancestors
   with CSS `contain: paint`. Requires DOM restructuring.

10. **CDN loads Lit in dev mode** — JSPM CDN produces "not recommended
    for production" console warnings.

### API Migration (v1.0.0 Breaking Changes)

11. **`system` attribute, not `theme`** — old `theme` attribute removed.

12. **`sp-button href` deprecated** — use native `<a>` with Spectrum CSS.

13. **`--system-*` variables are auto-generated** — never override;
    use `--mod-*` instead.

14. **`sp-field-group` invalid sync** — must set `invalid` on both the
    group AND each checkbox individually.

---

## 12. Tooling Ecosystem

### Token Visualization

| Tool | Purpose |
|------|---------|
| S1 Visualizer | Token dependency graphs |
| S2 Visualizer | Interactive ancestor/descendant graphs |
| S2 Tokens Viewer | Browse tokens with component usage |
| Release Timeline | Release history visualization |

All at `opensource.adobe.com/spectrum-design-data/`.

### AI Integration

- `@adobe/spectrum-design-data-mcp` — MCP server for tokens/schemas
- `@adobe/s2-docs-mcp` — MCP server for S2 component docs
- `@react-spectrum/mcp` — MCP server for React Spectrum (not SWC)

### Build Pipeline

Style Dictionary transforms JSON tokens to CSS. PostCSS plugins
(`postcss-add-theming-layer`) generate `--system-*` bridge variables.

---

## 13. Complete Application Example

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Settings — Spectrum App</title>
  <script type="module">
    import '@spectrum-web-components/theme/sp-theme.js';
    import '@spectrum-web-components/theme/spectrum-two/theme-light.js';
    import '@spectrum-web-components/theme/spectrum-two/scale-medium.js';
    import '@spectrum-web-components/sidenav/sp-sidenav.js';
    import '@spectrum-web-components/sidenav/sp-sidenav-item.js';
    import '@spectrum-web-components/tabs/sp-tabs.js';
    import '@spectrum-web-components/tabs/sp-tab.js';
    import '@spectrum-web-components/tabs/sp-tab-panel.js';
    import '@spectrum-web-components/textfield/sp-textfield.js';
    import '@spectrum-web-components/field-label/sp-field-label.js';
    import '@spectrum-web-components/help-text/sp-help-text.js';
    import '@spectrum-web-components/picker/sp-picker.js';
    import '@spectrum-web-components/menu/sp-menu-item.js';
    import '@spectrum-web-components/checkbox/sp-checkbox.js';
    import '@spectrum-web-components/button/sp-button.js';
    import '@spectrum-web-components/switch/sp-switch.js';
    import '@spectrum-web-components/overlay/sp-overlay.js';
    import '@spectrum-web-components/dialog/sp-dialog.js';
    import '@spectrum-web-components/tooltip/sp-tooltip.js';
  </script>
</head>
<body>
<sp-theme system="spectrum-two" color="light" scale="medium">
  <div class="app-shell">
    <sp-sidenav value="profile">
      <sp-sidenav-item value="profile" label="Profile"></sp-sidenav-item>
      <sp-sidenav-item value="security" label="Security"></sp-sidenav-item>
    </sp-sidenav>
    <main>
      <sp-tabs selected="personal">
        <sp-tab label="Personal" value="personal"></sp-tab>
        <sp-tab label="Preferences" value="prefs"></sp-tab>
        <sp-tab-panel value="personal">
          <sp-field-label for="name" required>Name</sp-field-label>
          <sp-textfield id="name" required>
            <sp-help-text slot="help-text">Your display name</sp-help-text>
            <sp-help-text slot="negative-help-text">Required</sp-help-text>
          </sp-textfield>
          <sp-field-label for="tz">Timezone</sp-field-label>
          <sp-picker id="tz">
            <span slot="label">Select</span>
            <sp-menu-item value="utc">UTC</sp-menu-item>
            <sp-menu-item value="pst">US Pacific</sp-menu-item>
          </sp-picker>
          <sp-button variant="accent" id="save">Save</sp-button>
          <sp-overlay trigger="save@click" type="modal">
            <sp-dialog>
              <h2 slot="heading">Save?</h2>
              <p>Changes take effect immediately.</p>
              <sp-button slot="button" variant="secondary">Cancel</sp-button>
              <sp-button slot="button" variant="accent">Save</sp-button>
            </sp-dialog>
          </sp-overlay>
        </sp-tab-panel>
        <sp-tab-panel value="prefs">
          <sp-switch>Dark mode</sp-switch>
          <sp-switch checked>Notifications</sp-switch>
        </sp-tab-panel>
      </sp-tabs>
    </main>
  </div>
</sp-theme>
<style>
  .app-shell {
    display: grid;
    grid-template-columns: 200px 1fr;
    height: 100vh;
    gap: var(--spectrum-spacing-400);
    padding: var(--spectrum-spacing-300);
  }
</style>
</body>
</html>
```

---

## 14. Skill Gap Analysis

### What Existing Skills Cover

- `react-spectrum-s2` MCP tool: React Spectrum S2 docs, components,
  style macros — React only
- `spectrum-2:spectrum-2-create/convert/audit`: React + Spectrum CSS —
  React focused

### What a New SWC Skill Should Provide

1. S2 theming setup (`sp-theme`, system attribute, import paths)
2. Side-effect import discipline
3. Component catalog awareness (what exists, what's missing, deprecated)
4. Form patterns (help-text slots, field-group validation sync)
5. Overlay patterns (trigger syntax, types, VirtualTrigger)
6. Token customization (`--mod-*` pattern, token naming)
7. Layout with Spectrum tokens (no native containers)
8. React integration via `@swc-react/*`
9. All 14 gotchas
10. Decision guidance (SWC vs React Spectrum S2)

### What the Skill Does NOT Need to Cover

- Style macros (React Spectrum S2 only)
- SSR patterns (web components don't support SSR)
- `@react-spectrum/s2` API
- React Aria
- Building custom web components (not design system usage)

---

## Sources

### Official Adobe

- https://s2.spectrum.adobe.com/
- https://spectrum.adobe.com/
- https://opensource.adobe.com/spectrum-web-components/
- https://react-spectrum.adobe.com/releases/v1-0-0
- https://github.com/adobe/spectrum-web-components
- https://github.com/adobe/spectrum-design-data
- https://github.com/adobe/spectrum-css

### SWC Documentation Pages

- Getting Started, Theme, Styles, Core Tokens, Migrating to Spectrum 2
- Components: button, textfield, overlay, dialog, picker, field-group,
  sidenav, tabs, action-group, split-view, help-text, tooltip
- Guides: styling components, swc-react, adding a component

### npm Packages

- @spectrum-web-components/bundle v1.11.2
- @adobe/spectrum-tokens v14.1.0
- @spectrum-css/tokens
- @swc-react/* (62+ packages)

### Articles & Discussions

- Adobe Blog: Spectrum 2 announcement (Dec 2023)
- adobe.design: Introducing Spectrum 2
- adobe.design: Reinventing Spectrum's colors (CAM02-UCS)
- TechCrunch: Adobe launches Spectrum 2
- GitHub Discussions: #3299 (date picker), #4197 (Safari leak),
  #7445 (SWC vs React future), #7433 (S2 parity)
- DeepWiki: Spectrum CSS architecture
