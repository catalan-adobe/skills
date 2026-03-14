#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="${HOME}/.config/cmux-setup"
CONFIG_FILE="${CONFIG_DIR}/rules.json"

HOOK_START="# cmux-setup-hook-start"
HOOK_END="# cmux-setup-hook-end"

usage() {
  cat <<'EOF'
cmux-setup -- manage cmux workspace colors

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

# ---------------------------------------------------------------------------
# Pattern matching
# ---------------------------------------------------------------------------

# Expand leading ~ to $HOME in a pattern.
expand_pattern() {
  local pat="$1"
  pat="${pat/#\~/$HOME}"
  echo "$pat"
}

# Count the number of / characters in a path (proxy for depth).
count_segments() {
  local path="$1"
  path="${path%/}"
  echo "$path" | tr -cd '/' | wc -c | tr -d ' '
}

# Find the best matching rule for a directory.
# Prints the winning rule as compact JSON, or empty string on no match.
#
# Match semantics:
#   - Patterns ending in /* match the prefix directory and everything below it.
#   - Bare patterns (no /*) match exactly.
#   - Most specific (deepest prefix) wins.
#   - Strict > so first rule wins at equal depth (tiebreaker per spec).
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
    local pattern expanded is_prefix matched depth
    pattern=$(jq -r ".rules[$i].pattern" "$CONFIG_FILE")
    expanded=$(expand_pattern "$pattern")

    is_prefix=false
    if [[ "$expanded" == *'/*' ]]; then
      is_prefix=true
      expanded="${expanded%/\*}"
    fi

    matched=false
    if [[ "$is_prefix" == true ]]; then
      if [[ "$dir" == "$expanded" || "$dir" == "$expanded"/* ]]; then
        matched=true
      fi
    else
      if [[ "$dir" == "$expanded" ]]; then
        matched=true
      fi
    fi

    if [[ "$matched" == true ]]; then
      depth=$(count_segments "$expanded")
      # Strict > ensures first rule wins when two patterns have equal depth.
      if (( depth > best_depth )); then
        best_depth=$depth
        best_json=$(jq -c ".rules[$i]" "$CONFIG_FILE")
      fi
    fi

    (( ++i ))
  done

  echo "$best_json"
}

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

# ---------------------------------------------------------------------------
# Apply and list
# ---------------------------------------------------------------------------

# Abstraction point: today uses set-status; swap here when cmux adds native API.
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

  local result status_key
  result=$(find_match "$dir")
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

# ---------------------------------------------------------------------------
# Add and remove
# ---------------------------------------------------------------------------

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
      --color)   color="$2";   shift 2 ;;
      --icon)    icon="$2";    shift 2 ;;
      --label)   label="$2";   shift 2 ;;
      *) echo "Unknown flag: $1" >&2; return 1 ;;
    esac
  done

  if [[ -z "$pattern" || -z "$color" || -z "$icon" || -z "$label" ]]; then
    echo "Usage: cmux-setup.sh add --pattern <pat> --color <hex> --icon <icon> --label <text>" >&2
    return 1
  fi

  validate_hex "$color"

  local new_rule tmp
  new_rule=$(jq -n \
    --arg p "$pattern" \
    --arg c "$color" \
    --arg i "$icon" \
    --arg l "$label" \
    '{pattern: $p, color: $c, icon: $i, label: $l}')

  tmp=$(mktemp)
  jq --argjson rule "$new_rule" '.rules += [$rule]' "$CONFIG_FILE" > "$tmp"
  mv "$tmp" "$CONFIG_FILE"

  echo "Added rule: $pattern -> $label ($color)"
}

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

  local before_count tmp after_count
  before_count=$(jq '.rules | length' "$CONFIG_FILE")

  tmp=$(mktemp)
  jq --arg p "$pattern" '.rules |= map(select(.pattern != $p))' "$CONFIG_FILE" > "$tmp"
  mv "$tmp" "$CONFIG_FILE"

  after_count=$(jq '.rules | length' "$CONFIG_FILE")

  if (( before_count == after_count )); then
    echo "No rule found with pattern: $pattern"
  else
    echo "Removed rule: $pattern"
  fi
}

# ---------------------------------------------------------------------------
# Shell hook
# ---------------------------------------------------------------------------

cmd_install_hook() {
  local zshrc="${HOME}/.zshrc"

  # Copy script to ~/.local/bin for a stable PATH-based location.
  # Avoids hardcoding an absolute path that breaks on plugin reinstall.
  local stable_dir="${HOME}/.local/bin"
  local script_src
  script_src="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  mkdir -p "$stable_dir"
  cp "$script_src" "${stable_dir}/cmux-setup.sh"
  chmod +x "${stable_dir}/cmux-setup.sh"
  echo "Copied script to ${stable_dir}/cmux-setup.sh"

  # Build the hook block. Variables inside the heredoc that should expand
  # at install time use $VAR; variables that must stay literal (run at
  # chpwd time) use \$VAR.
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
# Append to chpwd_functions (zsh hook array).
# Remove-then-append pattern handles both empty and populated arrays.
# NOTE: Do NOT use \${+functions[chpwd_functions]} -- that checks for a
# function named "chpwd_functions", not the array variable.
chpwd_functions=(\${chpwd_functions:#_cmux_setup_chpwd} _cmux_setup_chpwd)
${HOOK_END}
HOOKEOF
)

  # Idempotent: strip any existing sentinel block before appending.
  if [[ -f "$zshrc" ]] && grep -qF "$HOOK_START" "$zshrc"; then
    local tmp
    tmp=$(mktemp)
    sed "/${HOOK_START}/,/${HOOK_END}/d" "$zshrc" > "$tmp"
    mv "$tmp" "$zshrc"
  fi

  printf '\n%s\n' "$hook_block" >> "$zshrc"
  echo "Hook installed in ${zshrc}"
  echo "Run 'source ~/.zshrc' or open a new terminal to activate."
}

cmd_uninstall_hook() {
  local zshrc="${HOME}/.zshrc"

  if [[ ! -f "$zshrc" ]] || ! grep -qF "$HOOK_START" "$zshrc"; then
    echo "No cmux-setup hook found in ${zshrc}"
    return 0
  fi

  local tmp
  tmp=$(mktemp)
  sed "/${HOOK_START}/,/${HOOK_END}/d" "$zshrc" > "$tmp"
  mv "$tmp" "$zshrc"
  echo "Hook removed from ${zshrc}"
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

main() {
  local cmd="${1:-}"
  shift || true

  case "$cmd" in
    apply)          cmd_apply "$@" ;;
    list)           cmd_list "$@" ;;
    add)            cmd_add "$@" ;;
    remove)         cmd_remove "$@" ;;
    match)          cmd_match "$@" ;;
    install-hook)   cmd_install_hook "$@" ;;
    uninstall-hook) cmd_uninstall_hook "$@" ;;
    -h|--help|"")   usage ;;
    *) echo "Unknown command: $cmd" >&2; usage >&2; exit 1 ;;
  esac
}

main "$@"
