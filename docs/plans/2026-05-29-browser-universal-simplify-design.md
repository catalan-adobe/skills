# browser-universal: Simplify Layer Detection

**Date:** 2026-05-29
**Status:** Design
**Skill:** `skills/browser-universal/`

## Problem

The skill's detection logic is harder to follow than it needs to be:

1. It probes all four layers in parallel, then resolves the winner through a
   separate "Default Priority" table (`Slicc > cmux-browser > Playwright MCP > CDP`).
   The ordering lives apart from the checks that produce it.
2. It calls the primary layer "Slicc playwright-cli" and confirms it by grepping
   `playwright-cli help` for subcommands (`snapshot`, `tab-list`, `teleport`) to
   distinguish a "Slicc" build from a "generic" one. This naming is wrong:
   `playwright-cli` is Microsoft's CLI (`/microsoft/playwright-cli` on Context7,
   "a token-efficient command-line interface for Playwright ... for coding
   agents"), not a Slicc tool. The subcommand-grep is the fiddly part the user
   flagged as confusing.

Meanwhile `playwright-cli` is already the repo's de-facto browser tool: seven
skills (news-digest, visual-tree, page-collect, migrate-header, browser-probe,
brand-setup, reduce-page) invoke it. Only reduce-page routes through
browser-universal at all.

## Goal

Make `playwright-cli` the default, recommended layer through a simple,
short-circuiting detection ladder. Probe alternatives only when playwright-cli
is absent. Remove the "Slicc" framing entirely.

## Decisions

| Decision | Choice |
|----------|--------|
| Detection model | Sequential short-circuit — first layer found wins, stop probing |
| playwright-cli check | `command -v playwright-cli` (POSIX builtin, more portable than `which`) |
| Slicc references | Removed everywhere — the layer is just `playwright-cli` |
| Fallback order | playwright-cli → Playwright MCP → cmux-browser → CDP |
| Layers kept | All four (none dropped) |
| Scope | `SKILL.md` + `references/LAYERS.md` only |

## Detection Ladder

Replaces the parallel-probe + priority-table model. Check in order; the first
match wins and detection stops:

```
1. playwright-cli   command -v playwright-cli        → found → use it, STOP
2. Playwright MCP   tool mcp__plugin_playwright_playwright__browser_navigate present
3. cmux-browser     cmux ping  (exit 0)
4. CDP              cdp.js resolves AND `node "$CDP_JS" list --port 9222` returns tabs
```

- Ordering is expressed by the ladder itself. The "Default Priority" section and
  its `Slicc > ...` table are deleted.
- The skill/user override is kept: if the consuming skill or user names a layer,
  use it and skip detection.
- The "No Layer Detected" blocking error is kept, with install hints reordered so
  playwright-cli is listed first.

### Why `command -v`

`command -v` is POSIX-standard and a shell builtin in bash, zsh, dash, and sh —
strictly more portable than `which` (not POSIX, an external binary that minimal
containers omit and that returns inconsistent exit codes). Every detection block
in the skill is already written in bash, so this adds no assumption the skill
doesn't already make. The subcommand-grep and the Slicc/generic distinction are
dropped — presence on PATH is the whole check.

## Naming Cleanup

- Strip every "Slicc" mention from `SKILL.md` and `references/LAYERS.md`. The
  layer is `playwright-cli`.
- Frontmatter `description`: reorder so playwright-cli reads as the default /
  recommended layer; remove "Slicc". Stays under the 1024-char limit.
- Universal verb table: rename the `Slicc` column header to `playwright-cli` and
  reorder columns to match the ladder (playwright-cli, Playwright MCP,
  cmux-browser, CDP).
- `LAYERS.md` "Slicc playwright-cli" section → "playwright-cli". Replace the
  `WebFetch` to the Slicc GitHub repo with the repo's own convention:
  `playwright-cli help` for the local command list, plus Context7
  (`/microsoft/playwright-cli`, verified to resolve) for detailed docs.

## Out of Scope

The seven skills that call `playwright-cli` directly are not changed. That most
of them bypass browser-universal is a separate concern; flag it as a possible
follow-up, do not expand it here.

## Files Touched

| File | Change |
|------|--------|
| `skills/browser-universal/SKILL.md` | Detection ladder, frontmatter, verb table, remove Slicc |
| `skills/browser-universal/references/LAYERS.md` | Rename section, swap Slicc WebFetch for `playwright-cli help` + Context7 |

## Verification

- `tessl skill lint skills/browser-universal` passes with zero warnings.
- No remaining "Slicc" / "slicc" string in either file.
- Detection ladder reads top-to-bottom with no separate priority table.
- `description` field under 1024 chars.
- `./scripts/sync-skills.sh` after changes.
