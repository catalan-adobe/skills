# cmux-setup Skill Design

**Date:** 2026-03-14
**Status:** Approved

## Overview

A Claude Code skill for managing cmux workspace visual configuration. The first module handles automatic workspace coloring based on directory patterns. Designed to be extensible for future cmux setup concerns.

## Problem

cmux workspaces all look identical. When working across multiple projects (AI repos, GC repos, Adobe repos), there's no visual differentiation. Users must read workspace titles to identify context.

## Solution

Two-layer system:

1. **Skill (cmux-setup)** — Claude-side orchestration for config management, hook installation, and on-demand color application.
2. **Shell hook** — autonomous `chpwd` function that applies colors on every `cd` without Claude running.

## Architecture

### Config File

Location: `~/.config/cmux-setup/rules.json`

```json
{
  "rules": [
    {
      "pattern": "~/repos/ai/*",
      "color": "#8B5CF6",
      "icon": "robot",
      "label": "AI"
    },
    {
      "pattern": "~/repos/ai/catalan-adobe/*",
      "color": "#F59E0B",
      "icon": "star",
      "label": "Adobe"
    },
    {
      "pattern": "~/repos/gc/*",
      "color": "#10B981",
      "icon": "package",
      "label": "GC"
    }
  ],
  "status_key": "project"
}
```

- `pattern`: prefix path with `~` expanded to `$HOME` at evaluation time. Trailing `/*` means "this directory and anything below it" (recursive prefix match, not single-component glob). Bare paths without `/*` match that exact directory only. Patterns like `**` or `?` are not supported — keep it simple.
- `color`: hex color (`#RRGGBB` format, validated on add) for `cmux set-status --color`
- `icon`: icon name or emoji for `cmux set-status --icon`
- `label`: display text for `cmux set-status` value
- `status_key`: which `set-status` key to use (default: `"project"` if omitted from config)

### Match Semantics

**Most specific (deepest) pattern wins**, regardless of rule order.

Specificity is determined by the number of fixed path segments in the pattern prefix (before `/*`, after `~` expansion). For the path `~/repos/ai/catalan-adobe/skills`:

- `~/repos/ai/*` — prefix `/Users/catalan/repos/ai` has 4 segments — matches (PWD starts with prefix)
- `~/repos/ai/catalan-adobe/*` — prefix has 5 segments — matches, wins (more specific)
- `~/repos/ai` (no `/*`) — exact match only, does not match (PWD is deeper)

If two patterns have equal depth, the first one in the rules array wins (tiebreaker).

If no pattern matches, `cmux clear-status <key>` is called to remove any stale badge.

### Apply Mechanism (Abstracted)

Today:
```bash
cmux set-status "$key" "$label" --color "$color" --icon "$icon"
```

The apply logic is isolated in a single function in `cmux-setup.sh`. When cmux adds native workspace color APIs, only this function changes. The config format stays the same.

## Skill Behavior

### Two Modes

#### 1. Persistent Mode (Setup)

Triggers: "set up workspace colors", "install cmux colors", "configure project colors", "cmux setup"

Actions:
- Create `~/.config/cmux-setup/rules.json` with user-defined rules
- Generate a `chpwd` hook function that calls `cmux-setup.sh apply "$PWD"`
- Install by sourcing the hook from `.zshrc` (idempotent — uses sentinel comments `# cmux-setup-hook-start` / `# cmux-setup-hook-end` to detect and replace existing installs)
- Verify installation works by running `apply` on current directory

#### 2. On-Demand Mode

Triggers: "color this workspace green", "mark this as AI project", "apply my color rules"

Actions:
- Read config and apply matching rule for current directory
- Support ad-hoc colors without config changes: "make this workspace purple for now" calls `cmux set-status` directly
- Ad-hoc colors are ephemeral — not persisted to config unless requested

### Rule Management (Conversational)

- "Add a rule for my adobe projects" — skill asks for pattern/color/icon, updates JSON
- "Show my color rules" — reads and displays config as a table
- "Remove the GC rule" — deletes matching rule from JSON
- "What rule matches here?" — runs `match` subcommand for current directory

## Helper Script

`skills/cmux-setup/scripts/cmux-setup.sh`

Subcommands:

| Command | Description |
|---------|-------------|
| `apply [dir]` | Evaluate rules for directory (default: `$PWD`), call `cmux set-status` |
| `list` | Display current rules as formatted table |
| `add --pattern <pat> --color <hex> --icon <icon> --label <text>` | Append rule to config (validates hex format) |
| `remove --pattern <pat>` | Delete rule matching pattern |
| `install-hook` | Generate and install `chpwd` hook in `.zshrc` (idempotent) |
| `uninstall-hook` | Remove `chpwd` hook from `.zshrc` |
| `match [dir]` | Show which rule matches a directory (debug/preview) |

### Dependencies

- `jq` — JSON parsing (already installed)
- `cmux` CLI — workspace control (only required for `apply`, not for config management)

Script validates dependencies are available per-subcommand and prints actionable errors if missing.

### Shell Hook Safety

The generated `chpwd` function runs in the user's interactive shell. Critical constraints:

- **No `set -euo pipefail`** inside the hook function. The standalone `cmux-setup.sh` script uses strict mode, but the hook function must silently tolerate failures.
- **Guard all externals:** `command -v cmux >/dev/null` and `command -v jq >/dev/null` before calling them. If either is missing, no-op silently.
- **Guard config existence:** if `~/.config/cmux-setup/rules.json` does not exist, no-op silently.
- **Expected latency:** ~20-40ms per `cd` (one `jq` invocation + one `cmux` CLI call). Acceptable for interactive use.
- **Idempotent install:** sentinel comments (`# cmux-setup-hook-start` / `# cmux-setup-hook-end`) bracket the injected block. Re-running `install-hook` replaces the block rather than appending a duplicate.

## SKILL.md Frontmatter

```yaml
---
name: cmux-setup
description: >-
  BEFORE manually calling cmux set-status or writing chpwd hooks for workspace
  coloring, use this skill. Manages workspace color rules that auto-apply based
  on directory patterns. Handles config creation, zsh hook installation, rule
  management, and on-demand workspace coloring via cmux set-status. Triggers on
  "cmux setup", "workspace colors", "color this workspace", "add color rule",
  "project colors", or any request to visually differentiate cmux workspaces.
---
```

The description leads with what the skill provides that Claude cannot figure out alone (the config format, hook safety constraints, match semantics). This follows the undertriggering mitigation pattern from skill-conventions.md.

## Script Location

SKILL.md locates the helper script via `${CLAUDE_SKILL_DIR}/scripts/cmux-setup.sh`. Fallback when `CLAUDE_SKILL_DIR` is not set:

```bash
SCRIPT=$(find ~/.claude -path "*/cmux-setup/scripts/cmux-setup.sh" -type f 2>/dev/null | head -1)
```

## Relationship to cmux-demo

Both `cmux-setup` and `cmux-demo` use `cmux set-status`, but they target different keys. `cmux-setup` uses the `status_key` from config (default: `"project"`), while `cmux-demo` uses demo-specific keys. They coexist without conflict.

## Files

### Create

```
skills/cmux-setup/SKILL.md
skills/cmux-setup/scripts/cmux-setup.sh
```

### Update

```
README.md                        — add to skills table
.claude/CLAUDE.md                — add to Available Skills table
.claude-plugin/plugin.json       — register skill
.claude-plugin/marketplace.json  — register for marketplace
```

## Future Extensions

The `cmux-setup` skill name is intentionally broad. Future modules could handle:

- Workspace layout presets (split configurations per project type)
- Default shell commands on workspace creation
- Sidebar appearance per project
- Notification preferences per workspace
