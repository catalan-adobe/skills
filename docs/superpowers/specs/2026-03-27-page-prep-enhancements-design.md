# page-prep Enhancements: Click-First Dismiss + Visual Verification

## Context

The page-prep skill detects and removes webpage overlays (cookie banners, GDPR
consent, modals). Two gaps were identified by comparing it with the
dismiss-overlays skill from the aemcoder repository:

1. **Dismiss strategy defaults to hide.** page-prep presents CSS hide and
   interactive click-dismiss as equal options. Clicking is better: it sets
   consent cookies that persist across tabs in the same browser session.
2. **No visual verification.** page-prep verifies cleanup with a DOM query
   (`position:fixed` + `z-index > 1000`). This misses iframes, Shadow DOM,
   absolute-positioned overlays, and `<dialog>::backdrop`. A viewport
   screenshot catches what the DOM check cannot.

## Scope

SKILL.md prompt changes only. No script changes to `overlay-db.js`,
`overlay-detect.js`, or `known-patterns.md`.

## Design

### Mode parameter

A `mode` parameter controls dismiss strategy and verification depth:

| Mode | Dismiss strategy | Verification | Use case |
|------|-----------------|--------------|----------|
| `thorough` (default) | Click-first, hide as fallback | DOM check + viewport screenshot (max 2 retries) | Long-running sessions, interactive work |
| `quick` | Hide-only (CSS injection) | DOM check only | Ephemeral sessions, repeated evaluations |

The caller communicates mode in natural language ("use page-prep in quick
mode") or the agent infers from context. No script-level flag needed.

### Change 1: Click-first dismiss (Step 8)

Current Step 8 presents hide and dismiss as equal paths. Replace with:

**Thorough mode (default):**

1. For overlays with `dismiss` recipes (`source: "cmp-match"`): execute click
   steps sequentially via the active browser tool's click primitives. This
   sets consent cookies that persist across tabs.
2. For overlays with `dismiss: null` (`source: "heuristic"`): run the existing
   Agent Fallback sequence (Escape key, then close buttons, then element
   removal).
3. Only if clicking fails or times out: fall back to hide (CSS injection +
   `scroll_fix`).

**Quick mode:**

1. Batch-evaluate all `hide.js` rules in one browser_evaluate call.
2. Apply `scroll_fix` if `scroll_locked` is true.
3. Skip interactive dismiss entirely.

### Change 2: Viewport screenshot verification (new Step 9b)

After the existing DOM residual check (Step 9), add screenshot verification
in thorough mode:

1. Take a **viewport screenshot** (not fullpage) via the active browser tool.
   Overlays use `position:fixed`, so they are always visible in the viewport
   regardless of scroll position.
2. Visually analyze: are there visible overlays, banners, modals, or backdrop
   dimming still present?
3. If clean: verification complete.
4. If overlays remain: attempt to dismiss (click close buttons or remove
   elements), then re-screenshot. Maximum 2 retries.
5. After retries exhausted: report remaining overlays to the caller but do not
   block. The page is as clean as achievable.

**Skip conditions:**
- `quick` mode: skip entirely (DOM check only).
- Caller explicitly opts out.

### Changes to existing steps

| Step | Change |
|------|--------|
| Step 6 (resolve dismiss strategy) | No change |
| Step 7 (produce recipe manifest) | No change |
| Step 8 (execute recipe) | Rewrite: thorough = click-first, quick = hide-only |
| Step 9 (verify page is clean) | Add mode gate: always run DOM check, then screenshot in thorough mode |
| Step 10 (watch mode) | No change |

### What does NOT change

- Detection pipeline (Steps 1-5): refresh, bundle, inject, read report, resolve strategy
- Scripts: `overlay-db.js`, `overlay-detect.js` stay as-is
- Reference doc: `known-patterns.md` stays as-is
- Detection report format and recipe manifest format
- Agent fallback sequence for heuristic detections
- Watch mode
- Browser tool examples section

## Consumers

| Consumer | Expected mode | Notes |
|----------|--------------|-------|
| migrate-header (Stage 4) | `thorough` for initial detection; recipe replay for polish loop iterations | Stage 4 delegation to page-prep is out of scope for this spec |
| cdp-ext-pilot | `thorough` | Long-running CDP session, cookies persist |
| Manual invocation | `thorough` (default) | User says "clean this page" |

## Testing

- Manually invoke page-prep on a site with OneTrust (e.g., adobe.com) in
  thorough mode. Verify click-dismiss sets cookie, screenshot shows clean page.
- Re-run on same site in same session — overlay should not reappear (cookie
  persisted).
- Invoke in quick mode — verify hide-only, no screenshot step.
- Test on a site with no overlays — verify skill completes quickly with no
  false positives.
