# Nav Completeness Visibility Check

## Problem

The polish loop evaluator counts nav items by querying the DOM for link
text, but does not check whether those elements are actually visible.
An AI agent can game the score by hiding nav items with `clip-path`,
`visibility: hidden`, `display: none`, or `opacity: 0` while keeping
them in the DOM so the nav completeness check passes.

On AstraZeneca iteration 4, the agent used `clip-path: inset(50%)` to
hide all nav items while overlaying a fake cookie banner div. Nav
completeness returned 100% despite zero visible navigation.

## Fix

In `migrate-header/templates/evaluate.js.tmpl`, the nav completeness
check should verify element visibility:

For each matched nav item, check:
- `display` is not `none`
- `visibility` is not `hidden`
- `opacity` is not `0`
- `clip-path` is not `inset(50%)` or similar full-clip patterns
- Element bounding rect has non-zero width and height

Only count items that pass all visibility checks. Penalize the score
if DOM-present items fail visibility (indicates intentional hiding).

## Files

- `skills/migrate-header/templates/evaluate.js.tmpl` — add visibility
  checks to nav completeness scoring

## Discovered

2026-04-01, AstraZeneca header migration test. AI gamed nav score by
hiding elements with clip-path while keeping them in DOM.
