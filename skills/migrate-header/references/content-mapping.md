# Content Mapping Guide

This guide explains how to transform captured source header HTML into the nav.plain.html format expected by the EDS header block.

## General Principles

1. **Identify logical sections** - Look for visual separation in the source header
2. **Map to section types** - brand, top-bar, main-nav, utility
3. **Preserve link hierarchy** - Maintain parent/child relationships for dropdowns
4. **Extract images** - Logo, icons, promo images
5. **Simplify markup** - Remove classes, inline styles, data attributes

## Structure Detection

### Signs of Multi-Section Header

- Multiple distinct horizontal rows
- Separate logo area from navigation
- Announcement/promo bar above navigation
- Utility links (login, cart) separated from main nav
- Different background colors for different sections

### Signs of Single-Row Header

- Logo, navigation, and utilities on same horizontal level
- Single background color/treatment
- No visual separation between elements
- Compact layout

## Common Source Patterns → nav.plain.html

### Logo/Brand

**Source patterns:**
```html
<!-- Pattern 1: Image in link -->
<a href="/" class="logo"><img src="/logo.png" alt="Company"></a>

<!-- Pattern 2: Background image -->
<a href="/" class="logo" style="background-image: url(/logo.png)">Company</a>

<!-- Pattern 3: SVG inline -->
<a href="/" class="logo"><svg>...</svg></a>

<!-- Pattern 4: Picture element -->
<a href="/"><picture><source srcset="..."><img src="/logo.png"></picture></a>
```

**nav.plain.html (as separate brand section):**
```html
<div>
  <p><a href="/"><img src="./images/logo.png" alt="Company"></a></p>
  <div class="section-metadata">
    <div><div>Style</div><div>brand</div></div>
  </div>
</div>
```

**nav.plain.html (inline in main-nav):**
```html
<div>
  <p><a href="/"><img src="./images/logo.png" alt="Company"></a></p>
  <ul>...</ul>
  <div class="section-metadata">
    <div><div>Style</div><div>main-nav</div></div>
  </div>
</div>
```

### Navigation Links

**Source pattern:**
```html
<nav class="main-menu">
  <ul>
    <li class="menu-item has-children">
      <a href="/products">Products</a>
      <ul class="submenu">
        <li><a href="/products/all">All Products</a></li>
        <li><a href="/products/new">New Arrivals</a></li>
      </ul>
    </li>
    <li class="menu-item"><a href="/about">About</a></li>
  </ul>
</nav>
```

**nav.plain.html:**
```html
<ul>
  <li><a href="/products">Products</a>
    <ul>
      <li><a href="/products/all">All Products</a></li>
      <li><a href="/products/new">New Arrivals</a></li>
    </ul>
  </li>
  <li><a href="/about">About</a></li>
</ul>
```

Key transformations:
- Remove all classes
- Keep nested `<ul>` structure for dropdowns
- Preserve `href` attributes
- Keep link text content

### Mega Menu Content

**Source pattern:**
```html
<li class="mega-menu-item">
  <a href="/solutions">Solutions</a>
  <div class="mega-menu-panel">
    <div class="mega-column">
      <h4>Enterprise</h4>
      <p>For large organizations</p>
      <a href="/solutions/enterprise" class="cta">Learn More</a>
    </div>
    <div class="mega-column">
      <h4>Small Business</h4>
      <p>For growing teams</p>
      <a href="/solutions/smb" class="cta">Get Started</a>
    </div>
  </div>
</li>
```

**nav.plain.html:**
```html
<li><a href="/solutions">Solutions</a>
  <ul>
    <li>
      <h3>Enterprise</h3>
      <p>For large organizations</p>
      <a href="/solutions/enterprise">Learn More</a>
    </li>
    <li>
      <h3>Small Business</h3>
      <p>For growing teams</p>
      <a href="/solutions/smb">Get Started</a>
    </li>
  </ul>
</li>
```

Key transformations:
- Convert `<div>` columns to `<li>` items
- Normalize headings to `<h3>` (consistency)
- Keep paragraphs and CTAs together in each `<li>`
- Remove CTA classes

### Promotional Cards / Featured Items

Source mega menu panels often contain promotional cards with images
alongside regular nav links. These appear in `contentHtml` as
`<a>` elements wrapping `<img>` tags.

**Source (from contentHtml):**
```html
<a href="https://www.astrazenecaclinicaltrials.com">
  <img src="https://.../.webp" alt="Clinical trial thumbnail">
  AstraZeneca Clinical Trials
</a>
```

**nav.plain.html:**
```html
<li>
  <a href="https://www.astrazenecaclinicaltrials.com">
    <img src="./images/clinical-trials-promo.webp" alt="Clinical trial thumbnail">
    AstraZeneca Clinical Trials
  </a>
</li>
```

Download images to `./images/` and reference locally. The header.js
mega menu renderer handles `<img>` inside `<li>` elements natively.

### Announcement/Top Bar

**Source pattern:**
```html
<div class="announcement-bar">
  <span class="promo-text">Free shipping on orders over $50!</span>
  <a href="/shop" class="promo-link">Shop Now</a>
</div>
```

**nav.plain.html:**
```html
<div>
  <p>Free shipping on orders over $50! <a href="/shop">Shop Now</a></p>
  <div class="section-metadata">
    <div><div>Style</div><div>top-bar</div></div>
  </div>
</div>
```

### Utility Links

**Source pattern:**
```html
<div class="header-actions">
  <a href="/login" class="btn-login">Login</a>
  <a href="/signup" class="btn-signup">Sign Up</a>
  <a href="/cart" class="cart-icon"><svg>...</svg></a>
</div>
```

**nav.plain.html (as separate utility section):**
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

**nav.plain.html (inline in main-nav):**
```html
<p><a href="/login">Login</a> | <a href="/signup">Sign Up</a></p>
```

## Image Handling

1. **Capture images** - analyze-source-component.js saves to `./images/`
2. **Use local paths** - Reference as `./images/filename.png`
3. **Copy to project** - `cp -r ./header-migration/images/* images/`

**Source:**
```html
<img src="https://example.com/assets/logo-2024.png" alt="Company">
```

**nav.plain.html:**
```html
<img src="./images/logo-2024.png" alt="Company">
```

## Common Pitfalls

### Don't Include

- Search forms (handle separately or omit)
- Complex interactive widgets
- JavaScript-dependent content
- Login/auth state indicators
- Cart count badges

### Do Include

- Static navigation links
- Logo image
- Dropdown menu structure
- Announcement text
- Simple utility links

## Transformation Checklist

- [ ] Identified header type (single-row vs multi-section)
- [ ] Extracted logo with alt text
- [ ] Mapped navigation links with dropdowns
- [ ] Converted mega menu content to `<li>` structure
- [ ] Added section-metadata to each section
- [ ] Set appropriate Mobile Style
- [ ] Copied images to local paths
- [ ] Removed all source classes and inline styles
