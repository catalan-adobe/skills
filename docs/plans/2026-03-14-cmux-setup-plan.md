# cmux-setup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code skill that manages cmux workspace coloring via user-defined folder-pattern rules, with both persistent (shell hook) and on-demand modes.

**Architecture:** Two-layer system — a SKILL.md prompt for Claude-side orchestration + a `cmux-setup.sh` helper script that handles config CRUD, pattern matching, and shell hook installation. The script is the single source of truth for all mechanical operations; the skill prompt guides Claude on when and how to use it.

**Tech Stack:** Bash (helper script), jq (JSON parsing), cmux CLI (workspace control), zsh chpwd hook (persistent mode)

**Spec:** `docs/plans/2026-03-14-cmux-setup-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `skills/cmux-setup/SKILL.md` | Skill prompt — frontmatter, script location, two modes, rule management guidance |
| `skills/cmux-setup/scripts/cmux-setup.sh` | Helper script — all subcommands (apply, list, add, remove, match, install-hook, uninstall-hook) |
| `README.md` | Update skills table |
| `.claude/CLAUDE.md` | Update Available Skills table |
| `.claude-plugin/plugin.json` | Register skill in plugin manifest |
| `.claude-plugin/marketplace.json` | Update marketplace description |

---

## Chunk 1: Helper Script

### Task 1: Script Skeleton and Dependency Checks

**Files:**
- Create: `skills/cmux-setup/scripts/cmux-setup.sh`

- [ ] **Step 1: Create script with subcommand dispatch**

```bash
#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="${HOME}/.config/cmux-setup"
CONFIG_FILE="${CONFIG_DIR}/rules.json"

usage() {
  cat <<'EOF'
cmux-setup — manage cmux workspace colors

Usage: cmux-setup.sh <command> [options]

Commands:
  apply [dir]           Apply matching color rule (default: $PWD)
  list                  Show current rules
  add                   Add a rule (--pattern --color --icon --label)
  remove                Remove a rule (--pattern)
  match [dir]           Show which rule matches (default: $PWD)
  install-hook          Install chpwd hook in .zshrc
  uninstall-hook        Remove chpwd hook from .zshrc
EOF
}

require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "Error: jq is required but not found. Install: brew install jq" >&2
    exit 1
  fi
}

require_cmux() {
  if ! command -v cmux >/dev/null 2>&1; then
    echo "Error: cmux CLI not found. Is cmux running?" >&2
    exit 1
  fi
}

ensure_config() {
  if [[ ! -f "$CONFIG_FILE" ]]; then
    mkdir -p "$CONFIG_DIR"
    echo '{"rules":[],"status_key":"project"}' | jq . > "$CONFIG_FILE"
  fi
}

main() {
  local cmd="${1:-}"
  shift || true

  case "$cmd" in
    apply)        cmd_apply "$@" ;;
    list)         cmd_list "$@" ;;
    add)          cmd_add "$@" ;;
    remove)       cmd_remove "$@" ;;
    match)        cmd_match "$@" ;;
    install-hook) cmd_install_hook "$@" ;;
    uninstall-hook) cmd_uninstall_hook "$@" ;;
    -h|--help|"") usage ;;
    *) echo "Unknown command: $cmd" >&2; usage >&2; exit 1 ;;
  esac
}

main "$@"
```

- [ ] **Step 2: Verify script is executable and shows help**

```bash
chmod +x skills/cmux-setup/scripts/cmux-setup.sh
bash skills/cmux-setup/scripts/cmux-setup.sh --help
```

Expected: prints usage text, exit 0.

- [ ] **Step 3: Commit**

```bash
git add skills/cmux-setup/scripts/cmux-setup.sh
git commit -m "feat(cmux-setup): script skeleton with subcommand dispatch"
```

### Task 2: Pattern Matching Logic

**Files:**
- Modify: `skills/cmux-setup/scripts/cmux-setup.sh`

- [ ] **Step 1: Implement the `find_match` function**

This is the core matching logic. Expands `~` in patterns, checks prefix match (for `/*` patterns) or exact match (bare paths), and returns the most-specific (deepest) match.

```bash
# Expand ~ to $HOME in a pattern, strip trailing /*
expand_pattern() {
  local pat="$1"
  pat="${pat/#\~/$HOME}"
  echo "$pat"
}

# Count path segments in a string
count_segments() {
  local path="$1"
  # Remove trailing slash, then count /
  path="${path%/}"
  echo "$path" | tr -cd '/' | wc -c | tr -d ' '
}

# Find the best matching rule for a directory.
# Prints JSON of the winning rule, or empty string if no match.
find_match() {
  local dir="$1"
  require_jq
  ensure_config

  local best_json=""
  local best_depth=-1

  local rule_count
  rule_count=$(jq '.rules | length' "$CONFIG_FILE")

  local i=0
  while (( i < rule_count )); do
    local pattern
    pattern=$(jq -r ".rules[$i].pattern" "$CONFIG_FILE")

    local expanded
    expanded=$(expand_pattern "$pattern")

    local is_prefix=false
    if [[ "$expanded" == *'/*' ]]; then
      is_prefix=true
      expanded="${expanded%/\*}"
    fi

    local matched=false
    if [[ "$is_prefix" == true ]]; then
      # Prefix match: dir starts with expanded path
      if [[ "$dir" == "$expanded" || "$dir" == "$expanded"/* ]]; then
        matched=true
      fi
    else
      # Exact match
      if [[ "$dir" == "$expanded" ]]; then
        matched=true
      fi
    fi

    if [[ "$matched" == true ]]; then
      local depth
      depth=$(count_segments "$expanded")
      # Strict > means first rule wins at equal depth (tiebreaker per spec)
      if (( depth > best_depth )); then
        best_depth=$depth
        best_json=$(jq -c ".rules[$i]" "$CONFIG_FILE")
      fi
    fi

    (( ++i ))
  done

  echo "$best_json"
}
```

- [ ] **Step 2: Implement the `cmd_match` subcommand**

```bash
cmd_match() {
  local dir="${1:-$PWD}"
  require_jq
  local result
  result=$(find_match "$dir")

  if [[ -z "$result" ]]; then
    echo "No matching rule for: $dir"
    return 0
  fi

  echo "Match for: $dir"
  echo "$result" | jq .
}
```

- [ ] **Step 3: Test matching manually**

Create a temporary config and test:

```bash
mkdir -p ~/.config/cmux-setup
cat > ~/.config/cmux-setup/rules.json <<'EOF'
{
  "rules": [
    {"pattern": "~/repos/ai/*", "color": "#8B5CF6", "icon": "robot", "label": "AI"},
    {"pattern": "~/repos/ai/catalan-adobe/*", "color": "#F59E0B", "icon": "star", "label": "Adobe"}
  ],
  "status_key": "project"
}
EOF

# Test: more specific rule wins
bash skills/cmux-setup/scripts/cmux-setup.sh match ~/repos/ai/catalan-adobe/skills
# Expected: Adobe rule (#F59E0B)

# Test: general rule
bash skills/cmux-setup/scripts/cmux-setup.sh match ~/repos/ai/kite
# Expected: AI rule (#8B5CF6)

# Test: no match
bash skills/cmux-setup/scripts/cmux-setup.sh match ~/Documents
# Expected: "No matching rule"
```

- [ ] **Step 4: Commit**

```bash
git add skills/cmux-setup/scripts/cmux-setup.sh
git commit -m "feat(cmux-setup): pattern matching with most-specific-wins semantics"
```

### Task 3: Apply and List Subcommands

**Files:**
- Modify: `skills/cmux-setup/scripts/cmux-setup.sh`

- [ ] **Step 1: Implement `cmd_apply`**

```bash
# Apply the matching rule to the current cmux workspace.
# Abstracted: today uses set-status, future can swap to native API.
apply_color() {
  local key="$1" label="$2" color="$3" icon="$4"
  cmux set-status "$key" "$label" --color "$color" --icon "$icon"
}

clear_color() {
  local key="$1"
  cmux clear-status "$key"
}

cmd_apply() {
  local dir="${1:-$PWD}"
  require_jq
  require_cmux

  local result
  result=$(find_match "$dir")

  local status_key
  status_key=$(jq -r '.status_key // "project"' "$CONFIG_FILE")

  if [[ -z "$result" ]]; then
    clear_color "$status_key"
    return 0
  fi

  local label color icon
  label=$(echo "$result" | jq -r '.label')
  color=$(echo "$result" | jq -r '.color')
  icon=$(echo "$result" | jq -r '.icon')

  apply_color "$status_key" "$label" "$color" "$icon"
}
```

- [ ] **Step 2: Implement `cmd_list`**

```bash
cmd_list() {
  require_jq
  ensure_config

  local rule_count
  rule_count=$(jq '.rules | length' "$CONFIG_FILE")

  if (( rule_count == 0 )); then
    echo "No rules configured. Use 'add' to create one."
    return 0
  fi

  local status_key
  status_key=$(jq -r '.status_key // "project"' "$CONFIG_FILE")
  echo "Status key: $status_key"
  echo ""
  printf "%-40s %-10s %-8s %s\n" "PATTERN" "COLOR" "ICON" "LABEL"
  printf "%-40s %-10s %-8s %s\n" "-------" "-----" "----" "-----"

  local i=0
  while (( i < rule_count )); do
    local pat col ico lbl
    pat=$(jq -r ".rules[$i].pattern" "$CONFIG_FILE")
    col=$(jq -r ".rules[$i].color" "$CONFIG_FILE")
    ico=$(jq -r ".rules[$i].icon" "$CONFIG_FILE")
    lbl=$(jq -r ".rules[$i].label" "$CONFIG_FILE")
    printf "%-40s %-10s %-8s %s\n" "$pat" "$col" "$ico" "$lbl"
    (( ++i ))
  done
}
```

- [ ] **Step 3: Test apply in cmux**

```bash
# Apply for current directory (must be in cmux)
bash skills/cmux-setup/scripts/cmux-setup.sh apply ~/repos/ai/catalan-adobe/skills
# Expected: cmux sidebar shows Adobe badge

bash skills/cmux-setup/scripts/cmux-setup.sh list
# Expected: formatted table of rules
```

- [ ] **Step 4: Commit**

```bash
git add skills/cmux-setup/scripts/cmux-setup.sh
git commit -m "feat(cmux-setup): apply and list subcommands"
```

### Task 4: Add and Remove Subcommands

**Files:**
- Modify: `skills/cmux-setup/scripts/cmux-setup.sh`

- [ ] **Step 1: Implement `cmd_add` with flag parsing and hex validation**

```bash
validate_hex() {
  local color="$1"
  if [[ ! "$color" =~ ^#[0-9A-Fa-f]{6}$ ]]; then
    echo "Error: invalid hex color '$color'. Expected format: #RRGGBB" >&2
    return 1
  fi
}

cmd_add() {
  require_jq
  ensure_config

  local pattern="" color="" icon="" label=""

  while (( $# > 0 )); do
    case "$1" in
      --pattern) pattern="$2"; shift 2 ;;
      --color)   color="$2"; shift 2 ;;
      --icon)    icon="$2"; shift 2 ;;
      --label)   label="$2"; shift 2 ;;
      *) echo "Unknown flag: $1" >&2; return 1 ;;
    esac
  done

  if [[ -z "$pattern" || -z "$color" || -z "$icon" || -z "$label" ]]; then
    echo "Usage: cmux-setup.sh add --pattern <pat> --color <hex> --icon <icon> --label <text>" >&2
    return 1
  fi

  validate_hex "$color"

  local new_rule
  new_rule=$(jq -n \
    --arg p "$pattern" \
    --arg c "$color" \
    --arg i "$icon" \
    --arg l "$label" \
    '{pattern: $p, color: $c, icon: $i, label: $l}')

  jq --argjson rule "$new_rule" '.rules += [$rule]' "$CONFIG_FILE" \
    > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

  echo "Added rule: $pattern -> $label ($color)"
}
```

- [ ] **Step 2: Implement `cmd_remove`**

```bash
cmd_remove() {
  require_jq
  ensure_config

  local pattern=""

  while (( $# > 0 )); do
    case "$1" in
      --pattern) pattern="$2"; shift 2 ;;
      *) echo "Unknown flag: $1" >&2; return 1 ;;
    esac
  done

  if [[ -z "$pattern" ]]; then
    echo "Usage: cmux-setup.sh remove --pattern <pat>" >&2
    return 1
  fi

  local before_count
  before_count=$(jq '.rules | length' "$CONFIG_FILE")

  jq --arg p "$pattern" '.rules |= map(select(.pattern != $p))' "$CONFIG_FILE" \
    > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"

  local after_count
  after_count=$(jq '.rules | length' "$CONFIG_FILE")

  if (( before_count == after_count )); then
    echo "No rule found with pattern: $pattern"
  else
    echo "Removed rule: $pattern"
  fi
}
```

- [ ] **Step 3: Test add/remove cycle**

```bash
# Start fresh (ensure_config will recreate)
trash ~/.config/cmux-setup/rules.json 2>/dev/null || true

# Add rules
bash skills/cmux-setup/scripts/cmux-setup.sh add \
  --pattern "~/test/*" --color "#FF0000" --icon fire --label "Test"
# Expected: "Added rule: ~/test/* -> Test (#FF0000)"

bash skills/cmux-setup/scripts/cmux-setup.sh list
# Expected: one rule

# Validate hex rejection
bash skills/cmux-setup/scripts/cmux-setup.sh add \
  --pattern "~/bad/*" --color "purple" --icon x --label "Bad"
# Expected: error about invalid hex

# Remove
bash skills/cmux-setup/scripts/cmux-setup.sh remove --pattern "~/test/*"
# Expected: "Removed rule: ~/test/*"

bash skills/cmux-setup/scripts/cmux-setup.sh list
# Expected: "No rules configured."
```

- [ ] **Step 4: Commit**

```bash
git add skills/cmux-setup/scripts/cmux-setup.sh
git commit -m "feat(cmux-setup): add and remove subcommands with hex validation"
```

### Task 5: Shell Hook Installation

**Files:**
- Modify: `skills/cmux-setup/scripts/cmux-setup.sh`

- [ ] **Step 1: Implement `cmd_install_hook`**

```bash
HOOK_START="# cmux-setup-hook-start"
HOOK_END="# cmux-setup-hook-end"

cmd_install_hook() {
  local zshrc="${HOME}/.zshrc"

  # Copy script to ~/.local/bin for stable PATH-based lookup.
  # Avoids hardcoding an absolute path that breaks on plugin reinstall.
  local stable_dir="${HOME}/.local/bin"
  mkdir -p "$stable_dir"
  cp "$(cd "$(dirname "$0")" && pwd)/$(basename "$0")" "${stable_dir}/cmux-setup.sh"
  chmod +x "${stable_dir}/cmux-setup.sh"
  echo "Copied script to ${stable_dir}/cmux-setup.sh"

  local hook_block
  hook_block=$(cat <<HOOKEOF
${HOOK_START}
# Auto-apply cmux workspace colors on directory change.
# Installed by cmux-setup skill. Remove with: cmux-setup.sh uninstall-hook
_cmux_setup_chpwd() {
  command -v cmux >/dev/null 2>&1 || return 0
  command -v jq >/dev/null 2>&1 || return 0
  [[ -f "\${HOME}/.config/cmux-setup/rules.json" ]] || return 0
  "\${HOME}/.local/bin/cmux-setup.sh" apply "\$PWD" 2>/dev/null || true
}
# Append to chpwd_functions array (zsh hook mechanism).
# ${+chpwd_functions} tests the array variable, NOT ${+functions[...]}.
# Remove first to avoid duplicates, then append.
chpwd_functions=(\${chpwd_functions:#_cmux_setup_chpwd} _cmux_setup_chpwd)
${HOOK_END}
HOOKEOF
)

  # Remove existing hook block if present (idempotent)
  if [[ -f "$zshrc" ]] && grep -q "$HOOK_START" "$zshrc"; then
    local tmp
    tmp=$(mktemp)
    sed "/${HOOK_START}/,/${HOOK_END}/d" "$zshrc" > "$tmp"
    mv "$tmp" "$zshrc"
  fi

  echo "$hook_block" >> "$zshrc"
  echo "Hook installed in ${zshrc}"
  echo "Run 'source ~/.zshrc' or open a new terminal to activate."
}
```

- [ ] **Step 2: Implement `cmd_uninstall_hook`**

```bash
cmd_uninstall_hook() {
  local zshrc="${HOME}/.zshrc"

  if [[ ! -f "$zshrc" ]] || ! grep -q "$HOOK_START" "$zshrc"; then
    echo "No cmux-setup hook found in ${zshrc}"
    return 0
  fi

  local tmp
  tmp=$(mktemp)
  sed "/${HOOK_START}/,/${HOOK_END}/d" "$zshrc" > "$tmp"
  mv "$tmp" "$zshrc"
  echo "Hook removed from ${zshrc}"
}
```

- [ ] **Step 3: Add `main "$@"` at end of script**

Ensure the script entry point calls main:

Include `main "$@"` at the bottom of the script file. This must be present from Task 1 onward (not deferred) — add it as the last line of the script in Task 1 Step 1 as well.

```bash
main "$@"
```

- [ ] **Step 4: Test hook install/uninstall idempotency**

```bash
# Install
bash skills/cmux-setup/scripts/cmux-setup.sh install-hook
grep "cmux-setup-hook-start" ~/.zshrc
# Expected: found

# Install again (idempotent)
bash skills/cmux-setup/scripts/cmux-setup.sh install-hook
grep -c "cmux-setup-hook-start" ~/.zshrc
# Expected: 1 (not 2)

# Uninstall
bash skills/cmux-setup/scripts/cmux-setup.sh uninstall-hook
grep "cmux-setup-hook-start" ~/.zshrc
# Expected: not found
```

- [ ] **Step 5: Commit**

```bash
git add skills/cmux-setup/scripts/cmux-setup.sh
git commit -m "feat(cmux-setup): shell hook install/uninstall with idempotency"
```

---

## Chunk 2: Skill Prompt and Registration

### Task 6: SKILL.md

**Files:**
- Create: `skills/cmux-setup/SKILL.md`

- [ ] **Step 1: Write the skill prompt**

Follow the pattern from existing skills (cmux-demo, screencast, memory-triage). Include:

1. YAML frontmatter with name and description from the design spec
2. Overview paragraph
3. Script location block with `CLAUDE_SKILL_DIR` + fallback
4. Two modes section (persistent setup vs on-demand)
5. Subcommand reference table
6. Rule management guidance (how Claude should interact conversationally)
7. On-demand mode guidance (ad-hoc colors without config changes)

Key content for the SKILL.md:

```markdown
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

\```bash
git clone https://github.com/catalan-adobe/skills.git /tmp/catalan-skills
cp /tmp/catalan-skills/skills/cmux-setup/SKILL.md ~/.claude/commands/cmux-setup.md
cp /tmp/catalan-skills/skills/cmux-setup/scripts/cmux-setup.sh ~/.local/bin/cmux-setup.sh
chmod +x ~/.local/bin/cmux-setup.sh
\```

## Script

All operations go through the helper script bundled with this skill.

**Locating the script:**

\```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  CMUX_SETUP="${CLAUDE_SKILL_DIR}/scripts/cmux-setup.sh"
else
  CMUX_SETUP="$(find ~/.claude -path "*/cmux-setup/scripts/cmux-setup.sh" \
    -type f 2>/dev/null | head -1)"
fi
if [[ -z "$CMUX_SETUP" || ! -f "$CMUX_SETUP" ]]; then
  echo "Error: cmux-setup.sh not found." >&2
fi
\```

Store in `CMUX_SETUP` and use for all commands below.

## Commands

\```bash
bash "$CMUX_SETUP" apply [dir]           # Apply matching rule (default: $PWD)
bash "$CMUX_SETUP" list                  # Show all rules
bash "$CMUX_SETUP" add --pattern <pat> --color <hex> --icon <icon> --label <text>
bash "$CMUX_SETUP" remove --pattern <pat>
bash "$CMUX_SETUP" match [dir]           # Debug: show which rule matches
bash "$CMUX_SETUP" install-hook          # Install chpwd hook in .zshrc
bash "$CMUX_SETUP" uninstall-hook        # Remove chpwd hook from .zshrc
\```

## Mode 1: Persistent Setup

When the user wants workspace colors applied automatically:

1. Ask which directories should get which colors. Suggest meaningful
   defaults based on their project structure (read their home directory
   layout if needed).
2. Add rules via `add` subcommand.
3. Run `install-hook` to set up the chpwd integration.
4. Verify by running `apply` for the current directory.
5. Tell the user to `source ~/.zshrc` or open a new terminal.

## Mode 2: On-Demand

When the user wants to color a workspace right now:

- **With config:** run `apply` to apply the matching rule for the current
  directory.
- **Ad-hoc (no config change):** call cmux directly:
  `cmux set-status project "Label" --color "#HEX" --icon "icon"`
  These are ephemeral — they don't survive workspace restarts.

## Rule Management

When users ask to manage rules conversationally:

- **"Add a rule"** — ask for the directory pattern, pick a color, suggest
  an icon and label. Use the `add` subcommand.
- **"Show my rules"** — run `list`.
- **"Remove a rule"** — run `remove --pattern <pat>`.
- **"What matches here?"** — run `match` with the current directory.

## Config Format

Location: `~/.config/cmux-setup/rules.json`

Patterns use `~` (expanded to $HOME). Trailing `/*` means recursive
prefix match. Bare paths match exactly. Most specific (deepest) pattern
wins regardless of rule order.

## Relationship to cmux-demo

Both skills use `cmux set-status` but with different keys. This skill
uses the `status_key` from config (default: `"project"`). They coexist
without conflict.
```

- [ ] **Step 2: Verify SKILL.md is under 500 lines**

```bash
wc -l skills/cmux-setup/SKILL.md
```

Expected: well under 500 lines.

- [ ] **Step 3: Commit**

```bash
git add skills/cmux-setup/SKILL.md
git commit -m "feat(cmux-setup): skill prompt with two modes and command reference"
```

### Task 7: Update Plugin Registration Files

**Files:**
- Modify: `README.md`
- Modify: `.claude/CLAUDE.md`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

- [ ] **Step 1: Add to README.md**

Add a new section after the `screencast` entry:

```markdown
### cmux-setup

Manage cmux workspace visual configuration. Automatically colors
workspaces based on directory-pattern rules using a JSON config and a
zsh chpwd hook. Supports persistent setup (auto-apply on every cd) and
on-demand coloring. Most-specific pattern wins.

**Dependencies:** jq, cmux CLI

See [SKILL.md](skills/cmux-setup/SKILL.md) for the full workflow.
```

- [ ] **Step 2: Add to `.claude/CLAUDE.md` Available Skills table**

Add both `cmux-setup` and `cmux-demo` (pre-existing gap — deployed but missing from table):

```markdown
| `cmux-demo` | Scripted cmux terminal demos with multi-pane layouts |
| `cmux-setup` | Manage cmux workspace colors via directory-pattern rules |
```

- [ ] **Step 3: Update `.claude-plugin/plugin.json`**

Add `cmux-setup` to the description string and add relevant keywords (`cmux`, `workspace`, `colors`, `setup`).

- [ ] **Step 4: Update `.claude-plugin/marketplace.json`**

Add `cmux-setup` mention to the description.

- [ ] **Step 5: Commit**

```bash
git add README.md .claude/CLAUDE.md .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "feat(cmux-setup): register in plugin manifests and docs"
```

---

## Chunk 3: End-to-End Verification

### Task 8: Live Test

- [ ] **Step 1: Set up test rules**

```bash
bash skills/cmux-setup/scripts/cmux-setup.sh add \
  --pattern "~/repos/ai/*" --color "#8B5CF6" --icon robot --label "AI"
bash skills/cmux-setup/scripts/cmux-setup.sh add \
  --pattern "~/repos/ai/catalan-adobe/*" --color "#F59E0B" --icon star --label "Adobe"
bash skills/cmux-setup/scripts/cmux-setup.sh add \
  --pattern "~/repos/gc/*" --color "#10B981" --icon package --label "GC"

bash skills/cmux-setup/scripts/cmux-setup.sh list
```

Expected: three rules displayed.

- [ ] **Step 2: Test pattern matching**

```bash
# Most specific wins
bash skills/cmux-setup/scripts/cmux-setup.sh match ~/repos/ai/catalan-adobe/skills
# Expected: Adobe rule

# General match
bash skills/cmux-setup/scripts/cmux-setup.sh match ~/repos/ai/kite
# Expected: AI rule

# No match
bash skills/cmux-setup/scripts/cmux-setup.sh match ~/Documents
# Expected: "No matching rule"
```

- [ ] **Step 3: Test apply in cmux**

```bash
# Must be running inside cmux
bash skills/cmux-setup/scripts/cmux-setup.sh apply ~/repos/ai/catalan-adobe/skills
# Expected: cmux sidebar shows "Adobe" badge with #F59E0B color

bash skills/cmux-setup/scripts/cmux-setup.sh apply ~/Documents
# Expected: badge cleared
```

- [ ] **Step 4: Test hook install and chpwd**

```bash
bash skills/cmux-setup/scripts/cmux-setup.sh install-hook
source ~/.zshrc
cd ~/repos/ai/catalan-adobe/skills
# Expected: Adobe badge appears automatically

cd ~/Documents
# Expected: badge clears automatically
```

- [ ] **Step 5: Clean up test config if desired**

```bash
bash skills/cmux-setup/scripts/cmux-setup.sh uninstall-hook
```

- [ ] **Step 6: Run shellcheck on the script**

```bash
shellcheck skills/cmux-setup/scripts/cmux-setup.sh
```

Expected: no errors or warnings.

- [ ] **Step 7: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix(cmux-setup): address issues found in live testing"
```
