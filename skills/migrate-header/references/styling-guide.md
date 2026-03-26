# Header Block Styling Guide

This guide documents all CSS custom properties and selectors available for styling the header block. Use this to map captured source styles to the appropriate header block properties.

## CRITICAL: CSS Specificity Rules

**All CSS rules MUST be scoped under `.header.block` to prevent global styles from overriding them.**

### Why This Matters

Global stylesheets (like `styles.css`) can easily override simple selectors. For example:
- A global `a { color: blue; }` would override `.header-nav a { color: inherit; }`
- A global `ul { margin: 1em; }` would break `.header.block .header-nav-list { margin: 0; }`

### Required Selector Pattern

**ALWAYS prefix selectors with `.header.block`:**

```css
/* ❌ WRONG - Can be overridden by global styles */
.header.block .header-nav-item > a {
  color: inherit;
}

/* ✅ CORRECT - Higher specificity, protected from global overrides */
.header.block .header.block .header-nav-item > a {
  color: inherit;
}
```

### Specificity Comparison

| Selector | Specificity | Risk |
|----------|-------------|------|
| `a` | 0,0,1 | Very high - easily overridden |
| `.header-nav a` | 0,1,1 | Medium - still vulnerable |
| `.header.block .header-nav a` | 0,2,1 | Low - protected |
| `.header.block .header-nav-item > a` | 0,2,1 | Low - protected |

### When Adding Custom Styles

When you add brand-specific styles during migration, ALWAYS use the `.header.block` prefix:

```css
/* ❌ WRONG */
.header.block .header-brand img {
  max-height: 50px;
}

/* ✅ CORRECT */
.header.block .header.block .header-brand img {
  max-height: 50px;
}
```

### Using !important (Sparingly)

Use `!important` only for critical layout properties that must never be overridden:

```css
.header.block .header.block .header-nav-list {
  list-style: none !important;
  margin: 0 !important;
  padding: 0 !important;
}
```

Avoid `!important` for colors, fonts, and other visual properties - use specificity instead.

---

## CSS Custom Properties

The header block defines these custom properties at the `.header.block` level:

```css
.header.block {
  /* Layout */
  --header-section-padding: 0.5rem 1rem;    /* Padding for each section */
  --header-background: #fff;                 /* Main header background */
  --header-max-width: 1400px;                /* Max content width */

  /* Navigation */
  --header-nav-gap: 2rem;                    /* Space between nav items */
  --header-nav-font-size: 1rem;              /* Nav link font size */
  --header-nav-font-weight: 500;             /* Nav link font weight */

  /* Dropdowns */
  --header-dropdown-background: #fff;        /* Dropdown panel background */
  --header-dropdown-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);  /* Dropdown shadow */
  --header-dropdown-padding: 1.5rem;         /* Dropdown inner padding */

  /* Mobile */
  --header-mobile-menu-background: #fff;     /* Mobile menu overlay background */
}
```

### Overriding Custom Properties

Add overrides in your project's `styles/styles.css` or directly in `blocks/header/header.css`:

```css
/* Example: Dark header theme */
.header.block {
  --header-background: #1a1a2e;
  --header-dropdown-background: #2d2d44;
  --header-mobile-menu-background: #1a1a2e;
}
```

## Section Styling

Each section has a wrapper class for targeted styling.

### Brand Section (`.header-brand`)

```css
.header.block .header-brand {
  /* Container for logo */
}

.header.block .header-brand img {
  max-height: 40px;    /* Logo height */
  width: auto;
}

.header.block .header-brand p {
  margin: 0;           /* Remove paragraph margins */
}
```

**Source style mapping:**
| Source Property | Target Selector |
|-----------------|-----------------|
| Logo height | `.header.block .header-brand img { max-height }` |
| Logo container padding | `.header.block .header-brand { padding }` |
| Background color | `.header.block .header-brand { background }` |

### Top Bar Section (`.header-top-bar`)

```css
.header.block .header-top-bar {
  background: var(--header-top-bar-background, #f5f5f5);
  font-size: 0.875rem;
  text-align: center;    /* Often centered */
}

.header.block .header-top-bar p {
  margin: 0;
}

.header.block .header-top-bar a {
  color: inherit;
  text-decoration: underline;
}

.header.block .header-top-bar strong {
  font-weight: 600;
}
```

**Source style mapping:**
| Source Property | Target Selector |
|-----------------|-----------------|
| Background color | `.header.block .header-top-bar { background }` |
| Text color | `.header.block .header-top-bar { color }` |
| Font size | `.header.block .header-top-bar { font-size }` |
| Link color | `.header.block .header-top-bar a { color }` |
| Padding | `.header-section.header.block .header-top-bar { padding }` |

### Main Nav Section (`.header-main-nav`)

```css
.header.block .header-main-nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header.block .header-main-nav .header-section-content {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 2rem;
}
```

#### Navigation List

```css
.header.block .header-nav-list {
  display: flex;
  gap: var(--header-nav-gap);
  list-style: none;
  margin: 0;
  padding: 0;
}

.header.block .header-nav-item > a {
  display: block;
  padding: 0.75rem 0;
  font-size: var(--header-nav-font-size);
  font-weight: var(--header-nav-font-weight);
  text-decoration: none;
  color: inherit;
}

.header.block .header-nav-item > a:hover {
  text-decoration: underline;
}
```

**Source style mapping:**
| Source Property | Target |
|-----------------|--------|
| Nav link color | `.header.block .header-nav-item > a { color }` |
| Nav link font-size | `--header-nav-font-size` |
| Nav link font-weight | `--header-nav-font-weight` |
| Nav link spacing | `--header-nav-gap` |
| Nav link padding | `.header.block .header-nav-item > a { padding }` |
| Hover effect | `.header.block .header-nav-item > a:hover { ... }` |

#### Dropdown Indicator (chevron)

```css
.header.block .header-nav-item.has-dropdown > a::after {
  content: '';
  display: inline-block;
  width: 0.4em;
  height: 0.4em;
  margin-left: 0.5em;
  border-right: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
  transform: rotate(45deg);
  vertical-align: middle;
}
```

To change the indicator style:
```css
/* Example: Use a different icon */
.header.block .header-nav-item.has-dropdown > a::after {
  content: '▼';
  border: none;
  transform: none;
  font-size: 0.6em;
}
```

### Simple Dropdown (`.header-dropdown--simple`)

```css
.header.block .header-dropdown--simple {
  min-width: 200px;
  padding: var(--header-dropdown-padding);
}

.header.block .header-dropdown--simple ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.header.block .header-dropdown--simple a {
  display: block;
  padding: 0.5rem 0;
  text-decoration: none;
  color: inherit;
  white-space: nowrap;
}

.header.block .header-dropdown--simple a:hover {
  text-decoration: underline;
}
```

**Source style mapping:**
| Source Property | Target |
|-----------------|--------|
| Dropdown background | `--header-dropdown-background` |
| Dropdown shadow | `--header-dropdown-shadow` |
| Dropdown padding | `--header-dropdown-padding` |
| Link padding | `.header.block .header-dropdown--simple a { padding }` |
| Link color | `.header.block .header-dropdown--simple a { color }` |

### Mega Dropdown (`.header-dropdown--mega`)

```css
.header.block .header-dropdown--mega {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  width: 100%;
  max-width: var(--header-max-width);
  padding: var(--header-dropdown-padding);
  box-sizing: border-box;
}

.header-dropdown--mega > ul {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 2rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.header-dropdown--mega > ul > li {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.header-dropdown--mega h3 {
  margin: 0 0 0.5rem;
  font-size: 1.125rem;
  font-weight: 600;
}

.header-dropdown--mega p {
  margin: 0 0 1rem;
  font-size: 0.875rem;
  color: #666;
}

.header-dropdown--mega > ul > li > a {
  color: var(--link-color, #0066cc);
  text-decoration: none;
}
```

**Source style mapping:**
| Source Property | Target |
|-----------------|--------|
| Panel max-width | `--header-max-width` |
| Column min-width | `.header-dropdown--mega > ul { grid-template-columns: minmax(XXXpx, 1fr) }` |
| Column gap | `.header-dropdown--mega > ul { gap }` |
| Heading style | `.header-dropdown--mega h3 { ... }` |
| Description style | `.header-dropdown--mega p { ... }` |
| CTA link color | `.header-dropdown--mega > ul > li > a { color }` |

### Utility Section (`.header-utility`)

```css
.header.block .header-utility {
  font-size: 0.875rem;
}

.header.block .header-utility ul {
  display: flex;
  gap: 1.5rem;
  list-style: none;
  margin: 0;
  padding: 0;
  justify-content: flex-end;
}

.header.block .header-utility a {
  text-decoration: none;
  color: inherit;
}

.header.block .header-utility a:hover {
  text-decoration: underline;
}
```

**Common customizations:**
```css
/* Style Sign Up as a button */
.header.block .header-utility li:last-child a {
  background: #0066cc;
  color: white;
  padding: 0.5rem 1rem;
  border-radius: 4px;
}

/* Add separator between items */
.header.block .header-utility li:not(:last-child)::after {
  content: '|';
  margin-left: 1.5rem;
  color: #ccc;
}
```

### Inline Brand (`.header-brand-inline`)

For single-row headers where logo is inside main-nav:

```css
.header.block .header-brand-inline {
  flex-shrink: 0;
}

.header.block .header-brand-inline img {
  max-height: 40px;
  width: auto;
}

.header.block .header-brand-inline p {
  margin: 0;
}
```

### Inline Tools (`.header-tools-inline`)

For single-row headers where utility is inside main-nav:

```css
.header.block .header-tools-inline {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 1rem;
  font-size: 0.875rem;
}

.header.block .header-tools-inline p {
  margin: 0;
}

.header.block .header-tools-inline a {
  text-decoration: none;
  color: inherit;
}
```

## Mobile Styling

### Hamburger Menu Toggle

```css
.header.block .header-menu-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  color: #000;           /* Icon color */
}

/* Three-line hamburger icon */
.header.block .header-menu-icon {
  display: block;
  width: 24px;
  height: 2px;
  background: currentColor;
  position: relative;
}

.header.block .header-menu-icon::before,
.header.block .header-menu-icon::after {
  content: '';
  position: absolute;
  left: 0;
  width: 100%;
  height: 2px;
  background: currentColor;
}

.header.block .header-menu-icon::before { top: -8px; }
.header.block .header-menu-icon::after { top: 8px; }

/* X icon when open */
.header-menu-toggle[aria-expanded="true"] .header.block .header-menu-icon {
  background: transparent;
}

.header-menu-toggle[aria-expanded="true"] .header-menu-icon::before {
  top: 0;
  transform: rotate(45deg);
}

.header-menu-toggle[aria-expanded="true"] .header-menu-icon::after {
  top: 0;
  transform: rotate(-45deg);
}
```

### Mobile Menu Overlay

```css
@media (max-width: 1023px) {
  .header.block .header-nav {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--header-mobile-menu-background);
    padding: 1rem;
    padding-top: 4rem;
    overflow-y: auto;
    z-index: 100;
  }

  .header.block .header-nav.is-open {
    display: block;
  }

  .header.block .header-nav-item > a {
    padding: 1rem 0;
    border-bottom: 1px solid #eee;
  }
}
```

## Common Style Adaptations

### Extracting Colors from Source

From `computed-styles.json`, map these properties:

```javascript
// Source computed styles → Header CSS
{
  "backgroundColor": "#1a1a2e"  → "--header-background: #1a1a2e"
  "color": "#ffffff"            → ".header.block .header-nav-item > a { color: #fff }"
}
```

### Extracting Typography

```javascript
// Source computed styles → Header CSS
{
  "fontFamily": "Inter, sans-serif"  → "font-family: Inter, sans-serif"
  "fontSize": "14px"                  → "--header-nav-font-size: 14px"
  "fontWeight": "600"                 → "--header-nav-font-weight: 600"
  "letterSpacing": "0.5px"            → "letter-spacing: 0.5px"
}
```

### Extracting Spacing

```javascript
// Source computed styles → Header CSS
{
  "padding": "16px 24px"             → "--header-section-padding: 16px 24px"
  "gap": "32px"                       → "--header-nav-gap: 32px"
}
```

## Style Migration Checklist

When adapting captured styles to the header block:

- [ ] Set `--header-background` from source header background
- [ ] Set `--header-nav-font-size` and `--header-nav-font-weight` from nav links
- [ ] Set `--header-nav-gap` from navigation item spacing
- [ ] Set `--header-dropdown-background` and `--header-dropdown-shadow` from dropdowns
- [ ] Style `.header-top-bar` background if present
- [ ] Style utility links/buttons if they have special treatment
- [ ] Adjust `.header-brand img` max-height to match source logo size
- [ ] Set mega menu column widths if source has specific layout
- [ ] Match mobile menu background color
