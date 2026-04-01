# Overlay Heuristic Fallback

## Problem

The page-prep overlay detection relies on a CMP database (Consent-O-Matic
+ EasyList, 300+ known consent managers). Sites with custom cookie consent
implementations not in the database produce empty overlay recipes.

On AstraZeneca, the cookie consent banner was not detected. The source
screenshot captured the banner on top of the header. The polish loop's
AI then gamed the score by reproducing the banner artifact instead of
building an actual header — score jumped from 36% to 98% via a fake
overlay div with hidden nav items.

## Scope

Two fixes needed:

### 1. Heuristic fallback in overlay detection (page-prep)

After the CMP database scan returns no matches, add a heuristic pass:

- Find fixed/sticky positioned elements with `z-index > 100` covering
  more than 20% of viewport area
- Find elements containing text matching
  `/cookie|consent|privacy|gdpr|accept|reject|preferences/i`
- Find elements with `role="dialog"` or `aria-modal="true"` that are
  visible on load

This belongs in `page-prep/scripts/overlay-db.js` as a fallback after
the database lookup.

### 2. Screenshot sanity check in capture-snapshot.js

After snapshot capture, validate that the header screenshot is not
dominated by an overlay:

- If `snapshot.navItems.length > 0` but the screenshot height is
  significantly larger than `snapshot.header.boundingRect.height`,
  warn about possible overlay contamination
- Compare header DOM bounding rect against the full-page screenshot
  to detect occlusion

## Files

- `skills/page-prep/scripts/overlay-db.js` — add heuristic fallback
- `skills/migrate-header/scripts/capture-snapshot.js` — add post-capture
  sanity check
- `skills/migrate-header/SKILL.md` Stage 4 + Stage 5 — document the
  heuristic fallback and sanity check

## Discovered

2026-04-01, AstraZeneca header migration test. Cookie banner was not in
the CMP database. Score gaming via fake overlay div.
