# Spectrum Web Components — Gotchas

Organized by severity. Each entry: what breaks, why, and how to fix it.

---

## Critical — Common, High Impact

### 1. `sp-theme` is mandatory

**Problem:** Components render completely unstyled without an ancestor `<sp-theme>`.
**Why:** Design tokens and CSS custom properties are injected by `sp-theme`; nothing else sets them.
**Fix:** Always wrap your app in:
```html
<sp-theme system="spectrum-two" color="light" scale="medium">
  <!-- your content -->
</sp-theme>
```

---

### 2. All packages must be the same version

**Problem:** Mixed versions cause custom element registry conflicts — `customElements.define()` throws on duplicate tag names.
**Why:** Each package version tries to register its own copy of shared base classes.
**Fix:** Pin every `@spectrum-web-components/*` dependency to an identical version. Use `npm ls` or `pnpm why` to audit.

---

### 3. Bundle package is prototyping-only

**Problem:** `@spectrum-web-components/bundle` loads every component upfront — bad for production bundle size.
**Why:** The bundle exists for quick prototyping, not tree-shaken production use.
**Fix:** Use individual packages (`@spectrum-web-components/button`, etc.) so bundlers can tree-shake unused components.

---

### 4. No SSR support

**Problem:** SWC components crash in Node.js / SSR environments — `HTMLElement`, `customElements`, and `window` don't exist.
**Why:** Web Components are a browser-only API.
**Fix:** In Next.js, use dynamic import with SSR disabled:
```js
const SpButton = dynamic(() => import('@swc-react/button'), { ssr: false });
```

---

### 5. Side-effect imports are required

**Problem:** Components don't render — just show as unknown HTML elements — without their registration import.
**Why:** Custom element definitions are registered as a side effect; there's no default export to trigger it.
**Fix:** Import every element you use, even if you don't reference the import directly:
```js
import '@spectrum-web-components/button/sp-button.js';
```

---

## Important — Less Common but Painful

### 6. React `onChange` doesn't fire for SWC form controls

**Problem:** Attaching `onChange` to an SWC input or picker does nothing in React.
**Why:** React's synthetic `onChange` maps to the DOM `input` event, but SWC dispatches `change` (not `input`) for its controls.
**Fix:** Use `@swc-react/*` wrappers, which handle event mapping correctly, or attach a native `addEventListener('change', ...)` ref.

---

### 7. Safari memory leak with inputs (GitHub #4197)

**Problem:** `sp-textfield` and other input components are not garbage collected in Safari.
**Why:** Open bug in SWC — a retained reference cycle prevents GC.
**Fix:** No workaround available. Monitor memory in Safari-heavy apps; watch the upstream issue for resolution.

---

### 8. `dir` attribute timing breaks RTL

**Problem:** Setting `dir="rtl"` before the element is attached to the DOM silently fails — text direction stays LTR.
**Why:** SWC reads `dir` on `connectedCallback`; setting it before attachment is too early.
**Fix:** Set `dir` after DOM attachment, or set it on the `<sp-theme>` element (which propagates it correctly to children).

---

### 9. Overlays can't escape `contain: paint`

**Problem:** `sp-overlay`, `sp-picker`, and `sp-tooltip` are clipped inside any ancestor with `contain: paint` or `overflow: hidden`.
**Why:** Overlay positions itself relative to the viewport but can't paint outside a containment boundary.
**Fix:** Restructure the DOM so overlay-triggering elements are not descendants of contained elements, or remove `contain: paint` from ancestors.

---

### 10. CDN build loads Lit in dev mode

**Problem:** Browser console fills with Lit development-mode warnings when loading SWC from a CDN.
**Why:** CDN builds ship with `NODE_ENV` unset, which Lit treats as development.
**Fix:** Safe to ignore during prototyping. Switch to npm packages for production — bundlers set `NODE_ENV=production` and strip dev warnings.

---

## API Migration — v1.0.0 Breaking Changes

### 11. `system` attribute, not `theme`

**Problem:** `<sp-theme theme="spectrum-two">` does nothing in v1.0.0+.
**Why:** The `theme` attribute was renamed to `system` in v1.0.0 to disambiguate from the color theme.
**Fix:** Use `system="spectrum-two"` on every `sp-theme` element.

---

### 12. `sp-button href` deprecated

**Problem:** `<sp-button href="...">` no longer creates a link in v1.0.0+.
**Why:** Mixing button and anchor semantics was removed for accessibility correctness.
**Fix:** Use a native `<a>` element styled with the button variant, or use `<sp-link>` for inline links.

---

### 13. `--system-*` CSS variables are unstable

**Problem:** `--system-*` custom properties change names across builds — hard-coding them breaks on upgrades.
**Why:** These are auto-generated internal tokens, not part of the public API.
**Fix:** Use `--mod-*` prefixed variables for intentional overrides; they are stable and documented as the customization API.

---

### 14. `sp-field-group` invalid state requires double-setting

**Problem:** Marking an `sp-field-group` invalid visually but not its child checkboxes (or vice versa) produces inconsistent UI.
**Why:** `sp-field-group` manages group-level error display; individual checkboxes manage their own indicator.
**Fix:** Set `invalid` on **both** the `<sp-field-group>` and each `<sp-checkbox>` inside it:
```html
<sp-field-group invalid>
  <sp-checkbox invalid>Option A</sp-checkbox>
  <sp-checkbox invalid>Option B</sp-checkbox>
</sp-field-group>
```
