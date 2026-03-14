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

# cmux-setup

Manage cmux workspace visual configuration. Currently handles automatic
workspace coloring based on directory-pattern rules.

## Prerequisites

- jq (JSON parsing)
- cmux CLI (only needed for `apply`, not config management)

## Standalone Installation

```bash
git clone https://github.com/catalan-adobe/skills.git /tmp/catalan-skills
cp /tmp/catalan-skills/skills/cmux-setup/SKILL.md ~/.claude/commands/cmux-setup.md
cp /tmp/catalan-skills/skills/cmux-setup/scripts/cmux-setup.sh ~/.local/bin/cmux-setup.sh
chmod +x ~/.local/bin/cmux-setup.sh
```

## Script Location

```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  CMUX_SETUP="${CLAUDE_SKILL_DIR}/scripts/cmux-setup.sh"
else
  CMUX_SETUP="$(find ~/.claude -path "*/cmux-setup/scripts/cmux-setup.sh" \
    -type f 2>/dev/null | head -1)"
fi
if [[ -z "$CMUX_SETUP" || ! -f "$CMUX_SETUP" ]]; then
  echo "Error: cmux-setup.sh not found." >&2
fi
```

Store in `CMUX_SETUP` and use for all commands below.

## Commands

```bash
bash "$CMUX_SETUP" apply [dir]                          # Apply matching rule to workspace (default: cwd)
bash "$CMUX_SETUP" list                                 # List all configured rules
bash "$CMUX_SETUP" add --pattern <glob> --color <hex> --icon <sf.symbol> --label <text>
bash "$CMUX_SETUP" remove --pattern <glob>              # Remove rule by pattern
bash "$CMUX_SETUP" match [dir]                          # Show which rule matches a directory
bash "$CMUX_SETUP" install-hook                         # Install zsh chpwd hook in ~/.zshrc
bash "$CMUX_SETUP" uninstall-hook                       # Remove zsh chpwd hook from ~/.zshrc
```

## Mode 1: Persistent Setup

Use when the user wants colors applied automatically on every directory change.

1. Ask which directories they want to color and what color/icon/label to use
   for each. If they say "this project" or "here", use the current working
   directory.
2. For each rule, run `add` with `--pattern`, `--color`, `--icon`, `--label`.
3. Run `install-hook` to register the zsh `chpwd` hook.
4. Run `apply` (no args) to color the current workspace immediately.
5. Tell the user to `source ~/.zshrc` (or open a new terminal) so the hook
   takes effect in the current session.

## Mode 2: On-Demand

Use when the user wants to color the current workspace once without persisting
any config.

**With existing config:** Run `apply` and the best matching rule is used.

**Ad-hoc (no config):** Call cmux directly — no script needed:

```bash
cmux set-status project "Label" --color "#HEX" --icon "icon.name"
```

This is ephemeral — the color is gone when the workspace closes or a new rule
overwrites it.

## Rule Management

Handle these conversational requests:

| Request | Action |
|---------|--------|
| "Add a rule for ~/work" | Ask for color, icon, label; run `add` |
| "Show my rules" | Run `list` |
| "Remove the ~/work rule" | Run `remove --pattern ~/work` |
| "What matches here?" | Run `match` (no args = cwd) |
| "What would match ~/repos/foo?" | Run `match ~/repos/foo` |

When adding a rule, ask for all four fields (`--pattern`, `--color`, `--icon`,
`--label`) in one prompt if not already provided. Don't ask one at a time.

## Config Format

Location: `~/.config/cmux-setup/rules.json`

- Patterns use `~` (expanded to `$HOME` at match time)
- Trailing `/*` is a recursive prefix match — `~/work/*` matches any path
  under `~/work/`
- Bare paths without `/*` are exact matches
- Most specific rule wins (longest matching pattern)

Example:

```json
{
  "rules": [
    {
      "pattern": "~/repos/ai/*",
      "color": "#7B2FBE",
      "icon": "brain",
      "label": "AI"
    },
    {
      "pattern": "~/work/*",
      "color": "#0066CC",
      "icon": "briefcase",
      "label": "Work"
    }
  ]
}
```

## Relationship to cmux-demo

`cmux-setup` uses the `cmux-setup` key in sidebar metadata. `cmux-demo`
uses `demo` and other demo-specific keys. They coexist without conflict.
