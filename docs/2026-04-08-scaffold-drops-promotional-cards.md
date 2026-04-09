# Bug: Scaffold subagent drops promotional cards from mega menu dropdowns

**Date:** 2026-04-08
**Found during:** AstraZeneca header migration test (`test-header-astrazeneca` worktree)
**Severity:** Medium — nav links are complete but promotional/featured content is lost

## Summary

The scaffold subagent (Phase 4) drops promotional cards with images from
mega menu dropdowns. The extraction pipeline captures them correctly in
`contentHtml`, the content-mapping guide documents how to handle them,
and the header block renders them — but the scaffold agent ignores them
when generating nav.plain.html.

## Reproduction

1. Run `migrate-header` against https://www.astrazeneca.com/
2. Check `autoresearch/extraction/row-1.json` → R&D element `contentHtml`
3. Compare with generated `nav.plain.html` → R&D submenu

## What was extracted (row-1.json, R&D contentHtml)

The row-1 agent correctly captured the full dropdown panel including a
`<div class="spotlight">` block with two promotional cards:

```html
<ul>
  <li><a href="/r-d/our-approach.html">Our approach</a>...</li>
  <li><a href="/r-d/precision-medicine.html">Precision medicine</a></li>
  <!-- ...8 nav links total... -->
</ul>
<div class="spotlight">
  <a href="https://www.astrazenecaclinicaltrials.com">
    <span>Featured website</span>
    <span>AstraZeneca Clinical Trials</span>
    <img src="/content/dam/az/.../AZ2986_BioPharmaceuticals_TA-Image_Female_Final_RGB-450x250.webp"
         alt="Clinical trial website thumbnail">
  </a>
  <a href="https://openinnovation.astrazeneca.com/">
    <span>Featured website</span>
    <span>Open Innovation</span>
    <img src="/content/dam/az/.../OI-helix-hero-450x250.webp"
         alt="OpenInnovation logo">
  </a>
</div>
```

Investors and Sustainability also have similar spotlight cards.

## What was generated (nav.plain.html, R&D)

Only the `<ul>` links — no images, no promotional cards:

```html
<li><a href="/r-d.html">R&amp;D</a>
  <ul>
    <li><a href="/r-d/our-approach.html">Our approach</a>
      <ul>
        <li><a href="/r-d/our-approach/stem-at-astrazeneca.html">STEM at AstraZeneca</a></li>
      </ul>
    </li>
    <li><a href="/r-d/precision-medicine.html">Precision medicine</a></li>
    <!-- ...remaining links, no images... -->
  </ul>
</li>
```

## Root cause

The scaffold subagent used the structured `content.children` array
(which only contains text/href pairs) to build the `<ul>` tree instead
of converting the full `contentHtml` which includes the promotional
`<div class="spotlight">` sibling.

The content-mapping guide (lines 152-177) already documents the correct
approach for promotional cards:

```html
<li>
  <a href="https://www.astrazenecaclinicaltrials.com">
    <img src="./images/clinical-trials-promo.webp" alt="...">
    AstraZeneca Clinical Trials
  </a>
</li>
```

## What supports this content already

1. **header.js** — `isMegaContent(ul)` detects `img`/`picture` inside
   `<ul>` and applies `header-dropdown--mega` class
2. **header.css** — `.header-dropdown--mega img { max-width: 100%; height: auto; }`
   plus grid layout that accommodates mixed link+image columns
3. **content-mapping.md** — "Promotional Cards / Featured Items" section
   documents the `<li><a><img>` pattern and image download step

## Affected pipeline components

| Component | Status |
|-----------|--------|
| Row agent extraction (`contentHtml`) | Correct — cards captured |
| Row agent extraction (`content.children`) | Partial — only text links |
| content-mapping.md reference | Correct — documents the pattern |
| Scaffold subagent prompt (`references/scaffold-prompt.md`) | Mentions `contentHtml` priority but scaffold didn't follow |
| header.js mega menu detection | Correct — handles images |
| header.css mega menu styling | Correct — styles images |

## Suggested fix areas

1. **Scaffold prompt** (`references/scaffold-prompt.md`): The prompt
   says to use `contentHtml` as primary content source (line 97-103)
   but the LLM scaffold agent falls back to `children` for nav items.
   Consider making the promotional card handling more explicit with a
   concrete example showing the `<div class="spotlight">` → `<li><a><img>`
   conversion.

2. **Row agent prompt** (Phase 3.1 in skill definition): The `children`
   field in the output schema only has `text`/`href`. Consider adding a
   `promotionalCards` array to the structured output so the scaffold
   doesn't have to parse HTML to find them.

3. **Evaluator** (`evaluate.js`): The nav completeness check counts
   link text matches. Promotional cards with images don't have
   distinguishing link text (they're "Featured website" labels), so
   they score 100% even when missing. Consider adding image-presence
   checks for mega menu items.

## Minor: .html.html typo

Line 135 of generated nav.plain.html has a doubled extension:
```
/careers/great-place-to-work/learning-development.html.html
```
This is in the Sustainability > Our people submenu. Likely a source
data issue from the row agent extraction.
