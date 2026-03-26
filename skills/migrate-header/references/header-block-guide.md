# Header Block Guide

The EDS header block is a flexible, multi-section navigation component that supports both simple single-row layouts and complex multi-section headers with mega menus.

## How It Works

The header block reads a `nav.plain.html` file and transforms it into a fully functional header with:
- Responsive navigation (desktop dropdowns, mobile menu)
- Multiple section support (brand, top-bar, main-nav, utility)
- Mega menu auto-detection (simple dropdowns vs rich content panels)
- Configurable mobile styles (accordion, slide-in, fullscreen)

## Section Types

Each section in `nav.plain.html` is identified by a `section-metadata` block with a `Style` property.

### brand

The logo/brand area. Typically contains just an image or linked image.

```html
<div>
  <p><a href="/"><img src="/images/logo.png" alt="Company Name"></a></p>
  <div class="section-metadata">
    <div><div>Style</div><div>brand</div></div>
  </div>
</div>
```

**Rendered as:** `.header-section.header-brand`

### top-bar

Announcement or promotional bar. Secondary information above main navigation.

```html
<div>
  <p>🎉 <strong>Special Offer:</strong> Free shipping on orders over $50! <a href="/shop">Shop Now</a></p>
  <div class="section-metadata">
    <div><div>Style</div><div>top-bar</div></div>
  </div>
</div>
```

**Rendered as:** `.header-section.header-top-bar`

### main-nav

Primary navigation with optional dropdowns and mega menus.

```html
<div>
  <ul>
    <li><a href="/products">Products</a>
      <ul>
        <li><a href="/products/all">All Products</a></li>
        <li><a href="/products/new">New Arrivals</a></li>
      </ul>
    </li>
    <li><a href="/about">About</a></li>
    <li><a href="/contact">Contact</a></li>
  </ul>
  <div class="section-metadata">
    <div><div>Style</div><div>main-nav</div></div>
    <div><div>Mobile Style</div><div>accordion</div></div>
  </div>
</div>
```

**Rendered as:** `.header-section.header-main-nav`

### utility

User actions like login, search, cart. Typically right-aligned.

```html
<div>
  <ul>
    <li><a href="/login">Login</a></li>
    <li><a href="/signup">Sign Up</a></li>
  </ul>
  <div class="section-metadata">
    <div><div>Style</div><div>utility</div></div>
  </div>
</div>
```

**Rendered as:** `.header-section.header-utility`

## Layout Types

### Multi-Section Layout

Multiple sections stacked vertically. Each section has its own `section-metadata`.

```
┌─────────────────────────────────────────┐
│ [Logo]                          brand   │
├─────────────────────────────────────────┤
│ 🎉 Announcement text            top-bar │
├─────────────────────────────────────────┤
│ Products ▼  Solutions ▼  About  main-nav│
├─────────────────────────────────────────┤
│                        Login | Sign Up  │ utility
└─────────────────────────────────────────┘
```

### Single-Row Layout

Everything in one `main-nav` section. Logo and utility are detected inline.

```
┌─────────────────────────────────────────┐
│ [Logo]  Products ▼  About  Login|SignUp │
└─────────────────────────────────────────┘
```

For single-row, include logo (as first `<p>` with image) and utility (as `<p>` after `<ul>`) within the `main-nav` section:

```html
<div>
  <p><a href="/"><img src="/images/logo.png" alt="Company"></a></p>
  <ul>
    <li><a href="/products">Products</a>...</li>
    <li><a href="/about">About</a></li>
  </ul>
  <p><a href="/login">Login</a> | <a href="/signup">Sign Up</a></p>
  <div class="section-metadata">
    <div><div>Style</div><div>main-nav</div></div>
  </div>
</div>
```

## Dropdown Types

The header block auto-detects dropdown type based on content:

### Simple Dropdown

Contains only links. Rendered as a compact vertical list.

```html
<li><a href="/products">Products</a>
  <ul>
    <li><a href="/products/all">All Products</a></li>
    <li><a href="/products/new">New Arrivals</a></li>
    <li><a href="/products/sale">On Sale</a></li>
  </ul>
</li>
```

**Detection:** Nested `<ul>` contains only `<li>` with `<a>` elements.

### Mega Menu

Contains rich content (headings, descriptions, images). Rendered as a full-width panel with grid layout.

```html
<li><a href="/solutions">Solutions</a>
  <ul>
    <li>
      <h3>Enterprise</h3>
      <p>Scalable solutions for large organizations.</p>
      <a href="/solutions/enterprise">Learn More</a>
    </li>
    <li>
      <h3>Small Business</h3>
      <p>Affordable tools for growing teams.</p>
      <a href="/solutions/small-business">Get Started</a>
    </li>
  </ul>
</li>
```

**Detection:** Nested `<ul>` contains headings (`<h1>`-`<h6>`), paragraphs (`<p>`), or images.

## Mobile Styles

Set via `Mobile Style` property in section-metadata.

### accordion (default)

Submenus expand in place. Tap to expand, tap again to collapse.

```html
<div><div>Mobile Style</div><div>accordion</div></div>
```

### slide-in

Submenus slide in from the right with a back button.

```html
<div><div>Mobile Style</div><div>slide-in</div></div>
```

### fullscreen

Submenus take over the full viewport with fade transition.

```html
<div><div>Mobile Style</div><div>fullscreen</div></div>
```

## CSS Customization

The header block uses CSS custom properties for easy theming:

```css
.header.block {
  --header-section-padding: 0.5rem 1rem;
  --header-background: #fff;
  --header-max-width: 1400px;
  --header-nav-gap: 2rem;
  --header-nav-font-size: 1rem;
  --header-nav-font-weight: 500;
  --header-dropdown-background: #fff;
  --header-dropdown-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  --header-dropdown-padding: 1.5rem;
  --header-mobile-menu-background: #fff;
}
```

Override these in your project's `styles.css` or in `blocks/header/header.css`.

## File Structure

```
blocks/header/
├── header.js    # Decoration logic
└── header.css   # Styles

nav.plain.html   # Navigation content (at project root or custom path)
```

## Navigation Path

By default, the header loads `/nav.plain.html`. To use a custom path, add a `nav` meta tag:

```html
<meta name="nav" content="/custom/path/nav">
```

The header block appends `.plain.html` automatically.
