# Component Guide

## Table of Contents

1. [Component Inventory](#component-inventory)
   - [Buttons & Actions](#buttons--actions)
   - [Form Controls](#form-controls)
   - [Color Tools](#color-tools)
   - [Navigation](#navigation)
   - [Overlays & Dialogs](#overlays--dialogs)
   - [Data Display](#data-display)
   - [Content & Layout](#content--layout)
   - [Onboarding & Icons](#onboarding--icons)
   - [Tool Packages](#tool-packages)
2. [Removed Components](#removed-components)
3. [Deprecated API Changes](#deprecated-api-changes)
4. [Component Gaps](#component-gaps)
5. [Form Patterns](#form-patterns)
6. [Overlay Patterns](#overlay-patterns)
7. [Slot Composition](#slot-composition)
8. [Action Group](#action-group)
9. [React Integration](#react-integration)

---

## Component Inventory

### Buttons & Actions

| Package | Element Tags |
|---------|--------------|
| `@spectrum-web-components/button` | `<sp-button>`, `<sp-clear-button>`, `<sp-close-button>` |
| `@spectrum-web-components/button-group` | `<sp-button-group>` |
| `@spectrum-web-components/action-button` | `<sp-action-button>` |
| `@spectrum-web-components/action-bar` | `<sp-action-bar>` |
| `@spectrum-web-components/action-group` | `<sp-action-group>` |
| `@spectrum-web-components/action-menu` | `<sp-action-menu>` |
| `@spectrum-web-components/picker-button` | `<sp-picker-button>` |
| `@spectrum-web-components/infield-button` | `<sp-infield-button>` |

### Form Controls

| Package | Element Tags |
|---------|--------------|
| `@spectrum-web-components/checkbox` | `<sp-checkbox>` |
| `@spectrum-web-components/radio` | `<sp-radio>`, `<sp-radio-group>` |
| `@spectrum-web-components/switch` | `<sp-switch>` |
| `@spectrum-web-components/textfield` | `<sp-textfield>`, `<sp-textarea>` |
| `@spectrum-web-components/number-field` | `<sp-number-field>` |
| `@spectrum-web-components/search` | `<sp-search>` |
| `@spectrum-web-components/combobox` | `<sp-combobox>` |
| `@spectrum-web-components/picker` | `<sp-picker>` |
| `@spectrum-web-components/slider` | `<sp-slider>`, `<sp-slider-handle>` |
| `@spectrum-web-components/field-group` | `<sp-field-group>` |
| `@spectrum-web-components/field-label` | `<sp-field-label>` |
| `@spectrum-web-components/help-text` | `<sp-help-text>` |

### Color Tools

| Package | Element Tags |
|---------|--------------|
| `@spectrum-web-components/color-area` | `<sp-color-area>` |
| `@spectrum-web-components/color-field` | `<sp-color-field>` |
| `@spectrum-web-components/color-handle` | `<sp-color-handle>` |
| `@spectrum-web-components/color-loupe` | `<sp-color-loupe>` |
| `@spectrum-web-components/color-slider` | `<sp-color-slider>` |
| `@spectrum-web-components/color-wheel` | `<sp-color-wheel>` |
| `@spectrum-web-components/swatch` | `<sp-swatch>`, `<sp-swatch-group>` |

### Navigation

| Package | Element Tags |
|---------|--------------|
| `@spectrum-web-components/tabs` | `<sp-tabs>`, `<sp-tab>`, `<sp-tab-panel>` |
| `@spectrum-web-components/sidenav` | `<sp-sidenav>`, `<sp-sidenav-item>`, `<sp-sidenav-heading>` |
| `@spectrum-web-components/top-nav` | `<sp-top-nav>`, `<sp-top-nav-item>` |
| `@spectrum-web-components/breadcrumbs` | `<sp-breadcrumbs>`, `<sp-breadcrumb-item>` |
| `@spectrum-web-components/menu` | `<sp-menu>`, `<sp-menu-group>`, `<sp-menu-item>` |
| `@spectrum-web-components/accordion` | `<sp-accordion>`, `<sp-accordion-item>` |
| `@spectrum-web-components/link` | `<sp-link>` |

### Overlays & Dialogs

| Package | Element Tags |
|---------|--------------|
| `@spectrum-web-components/dialog` | `<sp-dialog>`, `<sp-dialog-base>`, `<sp-dialog-wrapper>` |
| `@spectrum-web-components/alert-dialog` | `<sp-alert-dialog>` |
| `@spectrum-web-components/popover` | `<sp-popover>` |
| `@spectrum-web-components/tooltip` | `<sp-tooltip>` |
| `@spectrum-web-components/toast` | `<sp-toast>` |
| `@spectrum-web-components/tray` | `<sp-tray>` |
| `@spectrum-web-components/overlay` | `<sp-overlay>`, `<sp-overlay-trigger>` |
| `@spectrum-web-components/underlay` | `<sp-underlay>` |
| `@spectrum-web-components/modal` | `<sp-modal>` |
| `@spectrum-web-components/contextual-help` | `<sp-contextual-help>` |

### Data Display

| Package | Element Tags |
|---------|--------------|
| `@spectrum-web-components/table` | `<sp-table>`, `<sp-table-head>`, `<sp-table-body>`, `<sp-table-row>`, `<sp-table-cell>`, `<sp-table-head-cell>`, `<sp-table-checkbox-cell>` |
| `@spectrum-web-components/card` | `<sp-card>` |
| `@spectrum-web-components/avatar` | `<sp-avatar>` |
| `@spectrum-web-components/badge` | `<sp-badge>` |
| `@spectrum-web-components/status-light` | `<sp-status-light>` |
| `@spectrum-web-components/meter` | `<sp-meter>` |
| `@spectrum-web-components/progress-bar` | `<sp-progress-bar>` |
| `@spectrum-web-components/progress-circle` | `<sp-progress-circle>` |
| `@spectrum-web-components/thumbnail` | `<sp-thumbnail>` |
| `@spectrum-web-components/tags` | `<sp-tags>`, `<sp-tag>` |

### Content & Layout

| Package | Element Tags |
|---------|--------------|
| `@spectrum-web-components/asset` | `<sp-asset>` |
| `@spectrum-web-components/illustrated-message` | `<sp-illustrated-message>` |
| `@spectrum-web-components/divider` | `<sp-divider>` |
| `@spectrum-web-components/alert-banner` | `<sp-alert-banner>` |
| `@spectrum-web-components/split-view` | `<sp-split-view>` |
| `@spectrum-web-components/dropzone` | `<sp-dropzone>` |

### Onboarding & Icons

| Package | Element Tags |
|---------|--------------|
| `@spectrum-web-components/coachmark` | `<sp-coachmark>` |
| `@spectrum-web-components/icon` | `<sp-icon>` |
| `@spectrum-web-components/icons-ui` | `<sp-icon-*>` (UI icon set) |
| `@spectrum-web-components/icons-workflow` | `<sp-icon-*>` (Workflow icon set) |
| `@spectrum-web-components/iconset` | `<sp-iconset>` |

### Tool Packages

| Package | Purpose |
|---------|---------|
| `@spectrum-web-components/base` | Base class for all SWC components |
| `@spectrum-web-components/bundle` | All components in one import |
| `@spectrum-web-components/grid` | CSS Grid layout helper |
| `@spectrum-web-components/opacity-checkerboard` | Transparency background pattern |
| `@spectrum-web-components/reactive-controllers` | Shared controller primitives |
| `@spectrum-web-components/shared` | Shared utilities and mixins |
| `@spectrum-web-components/styles` | Global Spectrum CSS |
| `@spectrum-web-components/theme` | `<sp-theme>` theming provider |
| `@spectrum-web-components/truncated` | `<sp-truncated>` text truncation |

---

## Removed Components

These elements no longer exist. Use the replacements shown.

| Removed | Replacement |
|---------|-------------|
| `<sp-banner>` | `<sp-alert-banner>` |
| `<sp-quick-actions>` | `<sp-action-bar>` |
| `<sp-split-button>` | Button group pattern |

---

## Deprecated API Changes

All 9 breaking API changes from earlier SWC versions:

| Component | Old API | New API |
|-----------|---------|---------|
| `<sp-action-button>` | `variant="..."` | `static-color="white\|black"` |
| `<sp-badge>` | positional attributes (`top`, `right`, etc.) | logical properties (`block-start`, `inline-end`, etc.) |
| `<sp-button>` | `variant="cta"` | `variant="accent"` |
| `<sp-button>` | `variant="over-background"` | `static-color="white"` |
| `<sp-button>` | `href` attribute | Use native `<a>` wrapping or `<sp-link>` |
| `<sp-popover>` | `dialog` attribute | Slot `<sp-dialog>` inside popover |
| `<sp-progress-circle>` | `over-background` attribute | `static-color="white"` |
| `<sp-theme>` | `theme` attribute | `system` attribute |
| `<sp-thumbnail>` | Named sizes (`small`, `medium`, etc.) | Numeric sizes (`100`, `300`, `500`, `700`, `900`) |

---

## Component Gaps

These Spectrum components do **not** exist in SWC. Do not attempt to use or implement them.

- **Date Picker** — no `<sp-date-picker>`
- **Date Range Picker** — no `<sp-date-range-picker>`
- **Date Field** — no `<sp-date-field>`
- **Time Field** — no `<sp-time-field>`
- **Calendar** — no `<sp-calendar>`
- **Range Calendar** — no `<sp-range-calendar>`
- **Color Picker** (composite) — no single `<sp-color-picker>` element; compose from color-area, color-slider, color-wheel, color-field, color-handle, swatch
- **Tree View** — no `<sp-tree-view>`
- **List View** — no `<sp-list-view>`

When a user requests one of these, explain the gap and offer the best available alternative or composition.

---

## Form Patterns

### Help Text Slots

`<sp-help-text>` attaches to fields via named slots. The `negative-help-text` slot is shown automatically when the field is `invalid`.

```html
<sp-textfield label="Email" invalid>
  <sp-help-text slot="help-text">Enter your email address.</sp-help-text>
  <sp-help-text slot="negative-help-text">Enter a valid email address.</sp-help-text>
</sp-textfield>
```

### Field-Group Validation Sync

When validating a group of checkboxes, set `invalid` on **both** the `<sp-field-group>` and each invalid `<sp-checkbox>`.

```html
<sp-field-group invalid>
  <sp-field-label for="opts">Select at least one</sp-field-label>
  <sp-checkbox id="opts" invalid>Option A</sp-checkbox>
  <sp-checkbox>Option B</sp-checkbox>
  <sp-help-text slot="negative-help-text">At least one option required.</sp-help-text>
</sp-field-group>
```

### Label Patterns

**Visible label (for attribute):**
```html
<sp-field-label for="my-field">Username</sp-field-label>
<sp-textfield id="my-field"></sp-textfield>
```

**Invisible label (accessibility attribute):**
```html
<sp-textfield label="Search" placeholder="Search..."></sp-textfield>
```

**Icon-only button with accessible label:**
```html
<sp-action-button label="Edit item">
  <sp-icon-edit slot="icon"></sp-icon-edit>
</sp-action-button>
```

---

## Overlay Patterns

### Trigger Syntax

Use `<sp-overlay-trigger>` with a `trigger` attribute referencing the overlay element by ID. Multiple triggers are pipe-separated.

```html
<sp-overlay-trigger>
  <sp-button slot="trigger">Open</sp-button>
  <sp-popover slot="click-content">Popover content</sp-popover>
</sp-overlay-trigger>
```

For `<sp-overlay>`, reference the trigger element: `trigger="element-id@click|hover|longpress"`.

```html
<sp-button id="my-btn">Open</sp-button>
<sp-overlay trigger="my-btn@click" type="auto">
  <sp-popover>Content</sp-popover>
</sp-overlay>
```

### Overlay Types

| Type | Outside-click closes | Focus trap | Use case |
|------|---------------------|------------|----------|
| `hint` | Yes | No | Tooltips, non-interactive |
| `auto` | Yes | No | Popovers, dropdowns |
| `manual` | No | No | Toasts, banners (explicit close) |
| `modal` | No | Yes | Dialogs requiring acknowledgment |
| `page` | No | Yes | Full-page blocking overlays |

### Modal Dialog

```html
<sp-button id="dialog-btn">Open Dialog</sp-button>
<sp-overlay trigger="dialog-btn@click" type="modal">
  <sp-dialog-base>
    <sp-dialog>
      <h2 slot="heading">Confirm Action</h2>
      <p>Are you sure you want to proceed?</p>
      <sp-button slot="button" variant="secondary" treatment="outline">Cancel</sp-button>
      <sp-button slot="button" variant="accent">Confirm</sp-button>
    </sp-dialog>
  </sp-dialog-base>
</sp-overlay>
```

### Tooltip

```html
<sp-overlay-trigger>
  <sp-button slot="trigger">Hover me</sp-button>
  <sp-tooltip slot="hover-content" placement="bottom">Helpful tip</sp-tooltip>
</sp-overlay-trigger>
```

### Longpress (Action Button)

```html
<sp-button id="lp-btn">Hold for more</sp-button>
<sp-overlay trigger="lp-btn@longpress" type="auto">
  <sp-popover>
    <sp-menu>
      <sp-menu-item>Option A</sp-menu-item>
      <sp-menu-item>Option B</sp-menu-item>
    </sp-menu>
  </sp-popover>
</sp-overlay>
```

### VirtualTrigger (Context Menus)

Use `VirtualTrigger` when there is no real DOM element to trigger from (right-click context menus, programmatic positioning).

```js
import { VirtualTrigger } from '@spectrum-web-components/overlay';

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const trigger = new VirtualTrigger(e.clientX, e.clientY);
  const overlay = document.querySelector('#context-overlay');
  overlay.triggerElement = trigger;
  overlay.open = true;
});
```

### Programmatic Control

```js
const overlay = document.querySelector('sp-overlay');

// Open
overlay.open = true;

// Close
overlay.open = false;

// Listen for state changes
overlay.addEventListener('sp-opened', () => console.log('opened'));
overlay.addEventListener('sp-closed', () => console.log('closed'));
```

### Overlay Warmup

The overlay system uses a 1000ms warmup delay before showing hover overlays. After the first overlay shows, subsequent overlays display immediately. After 1000ms of no overlay activity, the warmup resets. This is intentional Spectrum behavior — do not try to override it.

---

## Slot Composition

Named slots for the most commonly composed components:

| Component | Slot Name | Content |
|-----------|-----------|---------|
| `<sp-button>` | `icon` | Icon element (e.g., `<sp-icon-edit>`) |
| `<sp-dialog>` | `heading` | Dialog title text or element |
| `<sp-dialog>` | `button` | Action buttons (multiple allowed) |
| `<sp-textfield>` | `help-text` | Default hint text below field |
| `<sp-textfield>` | `negative-help-text` | Error text shown when `invalid` |
| `<sp-picker>` | `label` | Picker label (alternative to `label` attr) |
| `<sp-tab>` | `icon` | Icon displayed before tab label |

---

## Action Group

`<sp-action-group>` supports selection modes via the `selects` attribute.

**Single selection (radio behavior):**
```html
<sp-action-group selects="single" selected="left">
  <sp-action-button value="left">Left</sp-action-button>
  <sp-action-button value="center">Center</sp-action-button>
  <sp-action-button value="right">Right</sp-action-button>
</sp-action-group>
```

**Multiple selection (checkbox behavior):**
```html
<sp-action-group selects="multiple" selected="bold italic">
  <sp-action-button value="bold">Bold</sp-action-button>
  <sp-action-button value="italic">Italic</sp-action-button>
  <sp-action-button value="underline">Underline</sp-action-button>
</sp-action-group>
```

Listen for changes via the `change` event on `<sp-action-group>`. Access selected values via `actionGroup.selected` (returns an array of value strings).

---

## React Integration

SWC components have React wrappers in the `@swc-react` scope. The naming convention replaces `@spectrum-web-components/` with `@swc-react/`.

```js
// Web component
import '@spectrum-web-components/button/sp-button.js';

// React wrapper
import { Button } from '@swc-react/button';
```

**Key differences in React:**

- 62+ components have React wrappers (not all packages)
- `onChange` fires on commit (blur); use `onInput` for live updates — same as native inputs
- For Next.js, use the `/next.js` entry point to avoid SSR issues:

```js
import { Button } from '@swc-react/button/next.js';
```

**TypeScript JSX support** — merge SWC element types into JSX IntrinsicElements in a `.d.ts` file:

```ts
// swc.d.ts
import type { SWCInputEvent } from '@spectrum-web-components/shared';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'sp-button': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          variant?: 'accent' | 'primary' | 'secondary' | 'negative';
          size?: 's' | 'm' | 'l' | 'xl';
          disabled?: boolean;
          quiet?: boolean;
        },
        HTMLElement
      >;
      // Add other elements as needed
    }
  }
}
```
