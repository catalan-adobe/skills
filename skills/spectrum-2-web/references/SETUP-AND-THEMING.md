# SWC Setup and Theming Reference

## SWC vs React Spectrum S2 Decision Table

| Dimension | SWC | React Spectrum S2 |
|-----------|-----|-------------------|
| Framework | Any (Lit/Web Components) | React only |
| SSR | No (client-only) | Full support |
| CDN/no-build | Yes (JSPM) | No |
| Style macros | No | Yes |
| Date/time components | Missing | Full suite |
| Adobe add-ons | Recommended | Secondary |

**Choose SWC when:**
- The project uses a non-React framework (Vue, Angular, Svelte, vanilla JS)
- Targeting Adobe add-ons (Express, Acrobat, Creative Cloud plugins)
- Prototyping quickly via CDN with no build step
- Embedding components in micro-frontends across different frameworks

**Choose React Spectrum S2 when:**
- The project is already React
- SSR or static generation is required (Next.js, Remix)
- Date/time picker components are needed
- Style macros (`css()`, `style()`) are part of the design system workflow

---

## Installation Patterns

### Option 1: npm — Individual Packages (Production)

Install only what you use. All packages **must use identical version numbers** or
theming and component contracts will break at runtime.

```bash
npm install \
  @spectrum-web-components/theme@1.11.2 \
  @spectrum-web-components/button@1.11.2 \
  @spectrum-web-components/textfield@1.11.2
```

Add packages one-by-one as needed; always pin to the same version as the rest.

### Option 2: Bundle Package (Prototyping Only)

Installs all SWC components in one package. Convenient for prototyping but
ships every component to production — avoid for shipped products.

```bash
npm install @spectrum-web-components/bundle
```

Import all elements at once:

```js
import '@spectrum-web-components/bundle/elements.js';
```

### Option 3: CDN via JSPM (No-Build / Prototyping)

JSPM correctly resolves SWC's `exports` conditions (bare specifiers,
`browser`/`development` variants). **Do not use unpkg or jsDelivr** — they
do not handle SWC's export map and will produce 404s or broken modules.

```html
<script
  src="https://jspm.dev/@spectrum-web-components/bundle/elements.js"
  type="module"
  async
></script>
```

For individual packages via JSPM import maps:

```html
<script type="importmap">
{
  "imports": {
    "@spectrum-web-components/theme/sp-theme.js":
      "https://ga.jspm.io/npm:@spectrum-web-components/theme@1.11.2/sp-theme.js",
    "@spectrum-web-components/button/sp-button.js":
      "https://ga.jspm.io/npm:@spectrum-web-components/button@1.11.2/sp-button.js"
  }
}
</script>
<script type="module">
  import '@spectrum-web-components/theme/sp-theme.js';
  import '@spectrum-web-components/button/sp-button.js';
</script>
```

---

## ESM-Only

SWC ships as ES modules exclusively — there is no CommonJS build. This means:

- Always use `import`, never `require()`
- File extensions are **required** in import specifiers: `sp-button.js` not `sp-button`
- Node.js scripts using SWC need `"type": "module"` in `package.json`
- Bundlers (Vite, Webpack 5, Rollup) handle ESM natively; no special config needed

---

## Side-Effect Import Pattern

Every SWC component self-registers its custom element when its module is first
imported. Import the element file directly — there is no named export to
destructure.

```js
import '@spectrum-web-components/button/sp-button.js';
import '@spectrum-web-components/textfield/sp-textfield.js';
import '@spectrum-web-components/action-button/sp-action-button.js';
import '@spectrum-web-components/icon/sp-icon.js';
```

**You must import every element you use explicitly.** There is no auto-import
or tree-shaking that discovers elements from HTML templates. If an element
appears in HTML but its module was never imported, it renders as an unknown
element with no styles or behavior.

---

## Auto-Imported Dependencies

Some components pull in peer components automatically when their module loads.
You do not need to import these yourself:

| Component | Auto-imports |
|-----------|-------------|
| `sp-button` | `@spectrum-web-components/icons-ui` |
| `sp-picker` | `@spectrum-web-components/popover`, `@spectrum-web-components/menu` |
| `sp-overlay` | `@spectrum-web-components/underlay` |
| `sp-combobox` | `@spectrum-web-components/popover`, `@spectrum-web-components/menu`, `@spectrum-web-components/textfield` |
| `sp-dialog-wrapper` | `@spectrum-web-components/dialog`, `@spectrum-web-components/underlay`, `@spectrum-web-components/button` |

Check the component's source `index.js` if behavior depends on a peer that
may or may not be auto-imported in a given version.

---

## `<sp-theme>` Setup

`<sp-theme>` is a **mandatory ancestor** for all SWC components. It injects
CSS custom properties (design tokens) into the subtree. Components outside an
`<sp-theme>` boundary render without tokens and will look broken.

Three required dimensions:

| Attribute | Values |
|-----------|--------|
| `system` | `spectrum` (S1), `spectrum-two` (S2), `express-deprecated` |
| `color` | `light`, `dark` |
| `scale` | `medium` (desktop), `large` (touch/mobile) |

Optional attributes:

| Attribute | Purpose | Default |
|-----------|---------|---------|
| `lang` | BCP 47 locale for i18n | inherits from `<html lang>` |
| `dir` | Text direction: `ltr` or `rtl` | inherits from document |

Minimal setup:

```html
<sp-theme system="spectrum-two" color="light" scale="medium">
  <!-- all SWC components go here -->
</sp-theme>
```

---

## S2 Activation

Spectrum 2 (`system="spectrum-two"`) requires **different import paths** from
Spectrum 1. The `spectrum-two/` subdirectory contains the S2 token files.

Import order:

```js
// 1. The theme element itself
import '@spectrum-web-components/theme/sp-theme.js';

// 2. S2 color theme (spectrum-two/ subdirectory)
import '@spectrum-web-components/theme/spectrum-two/theme-light.js';

// 3. S2 scale
import '@spectrum-web-components/theme/spectrum-two/scale-medium.js';
```

Then in HTML:

```html
<sp-theme system="spectrum-two" color="light" scale="medium">
  <sp-button>Click me</sp-button>
</sp-theme>
```

**S1 imports for comparison** (do not mix with S2 files):

```js
import '@spectrum-web-components/theme/sp-theme.js';
import '@spectrum-web-components/theme/theme-light.js';   // no subdirectory
import '@spectrum-web-components/theme/scale-medium.js';  // no subdirectory
```

Mixing S1 and S2 token files causes token conflicts — use one system
consistently throughout the application.

---

## Nested Themes

Multiple `<sp-theme>` elements can nest to override tokens for a subtree. This
enables mixing light/dark regions or LTR/RTL sections on the same page.

```html
<!-- Page-level: S2 light, LTR -->
<sp-theme system="spectrum-two" color="light" scale="medium" dir="ltr">

  <header>
    <sp-button>Save</sp-button>
  </header>

  <!-- Dark sidebar within the light page -->
  <sp-theme color="dark">
    <nav>
      <sp-sidenav>
        <sp-sidenav-item value="home" label="Home"></sp-sidenav-item>
      </sp-sidenav>
    </nav>
  </sp-theme>

  <!-- RTL content block within the LTR page -->
  <sp-theme dir="rtl" lang="ar">
    <sp-textfield label="اسم المستخدم"></sp-textfield>
  </sp-theme>

</sp-theme>
```

Nested `<sp-theme>` elements **inherit** unspecified attributes from their
nearest `<sp-theme>` ancestor. Only specify what you want to override.

---

## Dynamic Theme Switching

Lazy-load theme variant modules at runtime to avoid shipping all color/scale
combinations in the initial bundle.

```js
/**
 * Switch the active theme by lazy-loading the required token files,
 * then updating the <sp-theme> element attributes.
 *
 * @param {'spectrum'|'spectrum-two'} system
 * @param {'light'|'dark'} color
 * @param {'medium'|'large'} scale
 */
async function updateTheme(system, color, scale) {
  const base = system === 'spectrum' ? '' : `${system}/`;

  await Promise.all([
    import(`@spectrum-web-components/theme/${base}theme-${color}.js`),
    import(`@spectrum-web-components/theme/${base}scale-${scale}.js`),
  ]);

  const el = document.querySelector('sp-theme');
  Object.assign(el, { system, color, scale });
}

// Usage:
document.getElementById('toggle-dark').addEventListener('click', () => {
  updateTheme('spectrum-two', 'dark', 'medium');
});
```

**Notes:**
- Dynamic `import()` with template literals requires bundler support (Vite,
  Rollup magic comments, or Webpack) to produce a chunk per variant
- For CDN usage, preload likely variants via `<link rel="modulepreload">` to
  avoid flash-of-unstyled-content on first switch
- Store the user's preference in `localStorage` and call `updateTheme` before
  first render to avoid a visible theme flash

---

## Context Detection Logic

When generating SWC code, choose the installation approach based on the
project environment:

```
Does package.json exist AND contain @spectrum-web-components/* dependencies?
├── YES → Project-aware mode
│         Use individual npm imports matching the installed version.
│         Read package.json to find the exact pinned version.
│         Do NOT add or change version numbers without asking.
└── NO  → Self-contained mode
          Use CDN (JSPM bundle script tag) — no build step required.
          Target latest stable (1.11.x as of early 2026).
          Emit a single <script> tag; no import maps needed for prototypes.
```

For project-aware mode, inspect `package.json` before generating any import
statements to ensure version consistency across all SWC packages.
