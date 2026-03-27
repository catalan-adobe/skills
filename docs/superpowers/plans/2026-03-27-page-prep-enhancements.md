# page-prep Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance page-prep SKILL.md with click-first dismiss default and viewport screenshot verification.

**Architecture:** Three edits to one file (`skills/page-prep/SKILL.md`): add mode parameter to the intro, rewrite Step 8, and extend Step 9. No script changes.

**Tech Stack:** Markdown (SKILL.md prompt authoring)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `skills/page-prep/SKILL.md` | Modify: lines 16-20, 88-94, 96-129 | Skill prompt — all three changes land here |

---

### Task 1: Add mode parameter to skill intro

**Files:**
- Modify: `skills/page-prep/SKILL.md:16-20`

- [ ] **Step 1: Add mode section after the intro paragraph**

Replace lines 16-20:

```markdown
# Page Prep

Detect and remove overlays (cookie banners, GDPR consent, modals, paywalls,
login walls) before screenshots, scraping, or browser automation.
Node 22+ required. No npm dependencies.
```

With:

```markdown
# Page Prep

Detect and remove overlays (cookie banners, GDPR consent, modals, paywalls,
login walls) before screenshots, scraping, or browser automation.
Node 22+ required. No npm dependencies.

## Mode

The `mode` parameter controls dismiss strategy and verification depth.
Default is `thorough`. Callers can request `quick` mode in natural language
("use page-prep in quick mode") or the agent infers from context.

| Mode | Dismiss | Verification | Use case |
|------|---------|--------------|----------|
| `thorough` (default) | Click-first, hide as fallback | DOM check + viewport screenshot | Persistent sessions, interactive work |
| `quick` | Hide-only (CSS injection) | DOM check only | Ephemeral sessions, repeated evaluations |
```

- [ ] **Step 2: Verify the edit**

Read `skills/page-prep/SKILL.md` lines 16-32 and confirm the mode table renders correctly and the subsequent "## Script Location" section still follows.

- [ ] **Step 3: Commit**

```bash
git add skills/page-prep/SKILL.md
git commit -m "feat(page-prep): add mode parameter (thorough/quick)"
```

---

### Task 2: Rewrite Step 8 with click-first default

**Files:**
- Modify: `skills/page-prep/SKILL.md` — Step 8 section (lines 88-94)

- [ ] **Step 1: Replace Step 8 content**

Replace the current Step 8:

```markdown
### Step 8 — Execute the recipe

- **Visual cleanup** (fast): batch-evaluate the `hide.js` block in one
  `browser_evaluate` call. Hides all overlays and restores scroll.
- **Interactive dismiss** (thorough): execute each `dismiss.steps` entry
  sequentially using the browser tool's click/key primitives. Use this when
  the site requires a real consent signal (analytics, A/B tests).
```

With:

```markdown
### Step 8 — Execute the recipe

**Thorough mode (default) — click-first:**

1. For each overlay with a `dismiss` recipe (`source: "cmp-match"`): execute
   the `dismiss.steps` entries sequentially using the browser tool's click/key
   primitives. Clicking sets consent cookies that persist across all tabs in
   the same browser session — the overlay will not reappear.
2. For each overlay with `dismiss: null` (`source: "heuristic"`): run the
   Agent Fallback sequence (see below).
3. Apply `scroll_fix` if `scroll_locked` is true.
4. If any click fails or times out after 5 seconds: fall back to the hide
   path for that overlay (batch-evaluate its `hide.js` rule).

**Quick mode — hide-only:**

1. Batch-evaluate all `hide.js` rules in one `browser_evaluate` call.
2. Apply `scroll_fix` if `scroll_locked` is true.
3. Skip interactive dismiss entirely.

Use quick mode for ephemeral browser sessions where cookies are lost on close
(e.g., repeated evaluations in a polish loop). The detection recipe can be
saved and replayed cheaply without re-running the full pipeline.
```

- [ ] **Step 2: Verify the edit**

Read the Step 8 section and confirm both mode paths are present and the Step 9 section follows correctly.

- [ ] **Step 3: Commit**

```bash
git add skills/page-prep/SKILL.md
git commit -m "feat(page-prep): click-first dismiss as default in thorough mode"
```

---

### Task 3: Add viewport screenshot verification to Step 9

**Files:**
- Modify: `skills/page-prep/SKILL.md` — Step 9 section (lines 96-129)

- [ ] **Step 1: Replace Step 9 content**

Replace the current Step 9:

```markdown
### Step 9 — Verify the page is clean

The detection script catches known CMPs and common heuristic patterns, but
it will miss overlays that don't fit those signals — third-party login
prompts (Google One Tap, Apple Sign In), custom-built modals, iframes, or
elements injected after the initial scan. Accessibility tree snapshots also
miss iframes and elements outside the main document tree.

Run this check to find remaining blockers:

```js
JSON.stringify([...document.querySelectorAll('*')].filter(el => {
  var s = getComputedStyle(el);
  return s.position === 'fixed' && parseInt(s.zIndex, 10) > 1000
    && (el.offsetWidth > 100 || el.offsetHeight > 100);
}).map(el => {
  var s = getComputedStyle(el);
  return { tag: el.tagName, id: el.id, cls: (el.className || '').slice(0, 50),
    z: s.zIndex, w: el.offsetWidth, h: el.offsetHeight };
}))
```

Evaluate this via the browser tool. It returns all visible `position:fixed`
elements with `z-index > 1000` and non-trivial dimensions. Ignore
legitimate elements (navigation bars, toolbars) and remove the rest:

1. For each suspicious element, evaluate
   `document.querySelector('<selector>')?.remove()`.
2. Re-run the check.
3. Repeat until only legitimate page elements remain.

This verification loop is the agent's value over the heuristic script
alone — the script handles the 80% of known patterns fast, the agent
handles the 20% that requires judgment.
```

With:

```markdown
### Step 9 — Verify the page is clean

Verification runs in two layers. The DOM check runs in both modes. The
screenshot check runs only in thorough mode.

#### Step 9a — DOM residual check (both modes)

The detection script catches known CMPs and common heuristic patterns, but
it will miss overlays that don't fit those signals — third-party login
prompts (Google One Tap, Apple Sign In), custom-built modals, iframes, or
elements injected after the initial scan. Accessibility tree snapshots also
miss iframes and elements outside the main document tree.

Run this check to find remaining blockers:

```js
JSON.stringify([...document.querySelectorAll('*')].filter(el => {
  var s = getComputedStyle(el);
  return s.position === 'fixed' && parseInt(s.zIndex, 10) > 1000
    && (el.offsetWidth > 100 || el.offsetHeight > 100);
}).map(el => {
  var s = getComputedStyle(el);
  return { tag: el.tagName, id: el.id, cls: (el.className || '').slice(0, 50),
    z: s.zIndex, w: el.offsetWidth, h: el.offsetHeight };
}))
```

Evaluate this via the browser tool. It returns all visible `position:fixed`
elements with `z-index > 1000` and non-trivial dimensions. Ignore
legitimate elements (navigation bars, toolbars) and remove the rest:

1. For each suspicious element, evaluate
   `document.querySelector('<selector>')?.remove()`.
2. Re-run the check.
3. Repeat until only legitimate page elements remain.

In quick mode, stop here. In thorough mode, continue to Step 9b.

#### Step 9b — Viewport screenshot verification (thorough mode only)

The DOM check misses iframes, Shadow DOM, absolute-positioned overlays,
and `<dialog>::backdrop`. A viewport screenshot catches what DOM queries
cannot.

1. Take a **viewport screenshot** (not fullpage) via the active browser tool.
   Overlays use `position:fixed` and are always visible in the viewport
   regardless of scroll position.
2. Visually analyze the screenshot: are there visible overlays, banners,
   modals, or backdrop dimming still present?
3. If the page is clean: verification complete.
4. If overlays remain: attempt to dismiss them (click close buttons or
   remove elements via `document.querySelector('<selector>')?.remove()`),
   then take another viewport screenshot. Maximum 2 retries.
5. After retries exhausted: report remaining overlays to the caller but
   do not block — the page is as clean as achievable.

This two-layer verification is the agent's value over the heuristic script
alone — the script and DOM check handle the 80% of known patterns fast,
the screenshot catches the remaining edge cases that require visual
judgment.
```

- [ ] **Step 2: Verify the edit**

Read the Step 9 section and confirm both 9a and 9b subsections are present, the JS code block renders correctly, and Step 10 follows.

- [ ] **Step 3: Commit**

```bash
git add skills/page-prep/SKILL.md
git commit -m "feat(page-prep): add viewport screenshot verification in thorough mode"
```

---

### Task 4: Update Tips section

**Files:**
- Modify: `skills/page-prep/SKILL.md` — Tips section (lines 274-284)

- [ ] **Step 1: Update tips to reference modes**

Replace these two lines in the Tips section:

```markdown
- Visual cleanup (hide) is faster — one evaluate call, no sequencing needed.
- Interactive dismiss is more thorough — use it when a real consent signal matters.
```

With:

```markdown
- Use `quick` mode for ephemeral sessions or repeated evaluations where speed matters.
- Use `thorough` mode (default) when cookies should persist or visual accuracy matters.
```

- [ ] **Step 2: Verify the edit**

Read the Tips section and confirm the updated lines fit with the surrounding tips.

- [ ] **Step 3: Commit**

```bash
git add skills/page-prep/SKILL.md
git commit -m "feat(page-prep): update tips to reference mode parameter"
```

---

### Task 5: Lint and sync

**Files:**
- Run: `tessl skill lint skills/page-prep`
- Run: `./scripts/sync-skills.sh`

- [ ] **Step 1: Lint the skill**

```bash
tessl skill lint skills/page-prep
```

Expected: zero warnings. If orphaned file warnings appear, fix markdown link syntax in SKILL.md.

- [ ] **Step 2: Sync locally**

```bash
./scripts/sync-skills.sh
```

Expected: copies updated SKILL.md to `~/.claude/commands/page-prep.md`.

- [ ] **Step 3: Commit if lint required fixes**

Only if Step 1 required changes:

```bash
git add skills/page-prep/SKILL.md
git commit -m "fix(page-prep): address lint warnings"
```
