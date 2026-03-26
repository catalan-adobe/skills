# EDS Header Block Conventions

Reference for generating AEM Edge Delivery Services header blocks. All patterns below are required conventions unless marked optional.

## Block Contract

The block JS file exports a single async function:

```js
export default async function decorate(block) {
  // block is the header block DOM element
  // All setup happens here: fetch nav, build DOM, attach events
}
```

No other exports. No classes. No module-level side effects beyond constants and helper functions.

## Nav Document

The header fetches its content from a nav document authored in AEM:

```js
const navMeta = getMetadata('nav');
const navPath = navMeta
  ? new URL(navMeta, window.location).pathname
  : '/nav';
```

- Default path: `/nav` (resolves to `nav.plain.html` via EDS content bus)
- Per-page override: authors set `nav` metadata to point to a different nav document
- The nav document is loaded as a fragment, then its children are moved into a `<nav>` element

### nav.plain.html Structure

The fetched HTML contains plain `<div>` sections (one per content block in the authored nav page):

```html
<div>
  <!-- Section 1: brand/logo — typically a <p> with an <a> containing an <img> -->
  <p><a href="/"><img src="/logo.png" alt="Logo"></a></p>
</div>
<div>
  <!-- Section 2: navigation links — <ul> lists and/or <p> elements -->
  <ul>
    <li><a href="/products">Products</a></li>
    <li><a href="/services">Services</a></li>
  </ul>
</div>
<div>
  <!-- Section 3: utility/actions — CTAs, search, account links -->
  <p><a href="/contact" class="button">Contact Us</a></p>
</div>
```

Key structural rules:
- Top-level children are `<div>` elements, one per authored section
- Each `<div>` wraps its content in `.default-content-wrapper`
- Lists become `<ul>` with `<li>` items containing `<a>` tags
- Standalone links in `<p>` tags may get `.button-container` / `.button` classes from EDS auto-decoration
- The logo is typically the first `<a>` containing an `<img>` in the first section
- Sections are siblings — no `<hr>` separators in the resolved HTML

## Imports

Required:

```js
import { getMetadata } from '../../scripts/aem.js';
```

Optional (for loading the nav as a fragment):

```js
import { loadFragment } from '../fragment/fragment.js';
```

`loadFragment` fetches the `.plain.html` and returns a document fragment. If not using fragment loading, fetch `nav.plain.html` directly and parse it.

No other imports. No npm packages. No CDN scripts (except font stylesheets loaded at runtime).

## CSS Scoping

### Block selector

Block styles target `.header.block` (element has both classes):

```css
.header.block {
  /* block-level styles */
}
```

Most selectors use `header nav` as the base since the `<nav>` is the primary structural element:

```css
header nav {
  display: flex;
  flex-direction: column;
}

header nav a:any-link {
  color: currentcolor;
  text-decoration: none;
}
```

### Page-level header element

The `<header>` element is controlled by EDS core. It applies a default `height: 64px`. Override this:

```css
header {
  height: auto !important;
}
```

For sticky behavior:

```css
header {
  position: sticky;
  top: 0;
  z-index: 100;
}
```

The `!important` on height is necessary because EDS sets it inline or via high-specificity rules.

## CSS Custom Properties

Define themeable values on the block for easy per-site customization:

```css
.header.block {
  --header-bg: #ffffff;
  --header-text: #000000;
  --header-font: 'Inter', sans-serif;
  --header-nav-gap: 24px;
  --header-height: 64px;
  --header-mobile-height: 56px;
  --header-max-width: 1440px;
  --header-padding: 0 32px;
  --header-mobile-padding: 0 16px;
}
```

Use these throughout the CSS instead of hardcoded values. This allows the skill consumer to retheme by overriding properties.

## Mobile Responsive

Standard breakpoint at 900px:

```js
const isDesktop = window.matchMedia('(min-width: 900px)');
```

### Hamburger toggle

Create a hamburger button for mobile navigation:

```js
const hamburger = document.createElement('div');
hamburger.classList.add('nav-hamburger');
hamburger.innerHTML = `<button type="button" aria-controls="nav"
  aria-label="Open navigation">
  <span class="nav-hamburger-icon"></span>
</button>`;
hamburger.addEventListener('click', () => toggleMenu(nav));
```

The hamburger icon uses CSS pseudo-elements (three lines via `::before`, the element itself, and `::after`):

```css
header nav .nav-hamburger-icon,
header nav .nav-hamburger-icon::before,
header nav .nav-hamburger-icon::after {
  display: block;
  position: relative;
  width: 22px;
  height: 2px;
  border-radius: 2px;
  background: currentcolor;
}

header nav .nav-hamburger-icon::before,
header nav .nav-hamburger-icon::after {
  content: '';
  position: absolute;
}

header nav .nav-hamburger-icon::before { top: -7px; }
header nav .nav-hamburger-icon::after { top: 7px; }
```

### Toggle function

Use `aria-expanded` on the `<nav>` to track menu state:

```js
function toggleMenu(nav, forceExpanded = null) {
  const expanded = forceExpanded !== null
    ? !forceExpanded
    : nav.getAttribute('aria-expanded') === 'true';
  nav.setAttribute('aria-expanded', expanded ? 'false' : 'true');
  document.body.style.overflowY =
    (expanded || isDesktop.matches) ? '' : 'hidden';
}
```

- Lock body scroll when mobile menu is open (`overflow-y: hidden`)
- Listen to `isDesktop` media query changes to auto-close/open on resize
- Hide hamburger on desktop: `header nav .nav-hamburger { display: none; }` inside `@media (width >= 900px)`

### Mobile CSS pattern

```css
@media (width < 900px) {
  header nav .nav-hamburger {
    display: flex;
  }

  /* Hide nav links by default on mobile */
  header nav .nav-links {
    display: none;
  }

  /* Show when expanded */
  header nav[aria-expanded='true'] .nav-links {
    display: flex;
    flex-direction: column;
  }
}

@media (width >= 900px) {
  header nav .nav-hamburger {
    display: none;
  }
}
```

## Vanilla Only

Hard requirements:
- No frameworks (React, Vue, Lit, etc.)
- No build tools (Webpack, Vite, Rollup)
- No external JS dependencies
- No CSS preprocessors (Sass, Less, PostCSS)
- Inline SVGs for icons (no icon font libraries)

Use native browser APIs: `document.createElement`, `querySelector`, `classList`, `addEventListener`, `matchMedia`.

CSS custom properties replace what preprocessor variables would do. Template literals replace what JSX would do.

## DOM Construction Pattern

The standard flow inside `decorate(block)`:

1. Fetch and parse the nav document
2. Clear the block: `block.textContent = ''`
3. Create a `<nav>` element and move fragment children into it
4. Classify sections by adding class names to the `<div>` children
5. Decorate each section (add icons, restructure links, enhance CTAs)
6. Create and attach the hamburger
7. Set initial `aria-expanded` state based on viewport
8. Wrap in a container div and append to block

```js
block.textContent = '';
const nav = document.createElement('nav');
nav.id = 'nav';

// Move fragment children into nav
while (fragment.firstElementChild) nav.append(fragment.firstElementChild);

// Classify sections
const classes = ['brand', 'nav-links', 'actions'];
classes.forEach((cls, i) => {
  const section = nav.children[i];
  if (section) section.classList.add(cls);
});

// ... decorate sections ...

nav.setAttribute('aria-expanded', 'false');
toggleMenu(nav, isDesktop.matches);
isDesktop.addEventListener('change', () => toggleMenu(nav, isDesktop.matches));

const navWrapper = document.createElement('div');
navWrapper.className = 'nav-wrapper';
navWrapper.append(nav);
block.append(navWrapper);
```

## Reset Patterns

EDS and browser defaults add unwanted margins/padding inside header. Reset them:

```css
header nav p,
header nav ul,
header nav li,
header nav div {
  margin: 0;
  padding: 0;
}

header nav ul {
  list-style: none;
}

header nav p {
  line-height: 1;
}
```

## Max Width and Centering

Content sections should be constrained and centered:

```css
header nav .main-bar {
  max-width: var(--header-max-width, 1440px);
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  padding: var(--header-padding, 0 32px);
}
```

Apply the same pattern to each horizontal section (nav bar, brand bar, etc.).
