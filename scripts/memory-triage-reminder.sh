#!/bin/bash
set -euo pipefail

# Memory Triage Reminder — Stop hook script
#
# Fires when Claude finishes responding. If the session has non-empty
# auto memory AND the last message indicates branch completion (PR
# created, merged, etc.), blocks Claude from stopping and suggests
# running the memory-triage skill.
#
# Requires: jq

if ! command -v jq &>/dev/null; then
  exit 0
fi

INPUT=$(cat)

# Prevent infinite loop: if we already triggered, don't trigger again
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then
  exit 0
fi

CWD=$(echo "$INPUT" | jq -r '.cwd // ""')

# Use jq for pattern matching — safe against special characters in the message
HAS_SIGNAL=$(echo "$INPUT" | jq -r '
  .last_assistant_message // "" |
  test("gh pr create|pull request.{0,20}created|PR #[0-9]|merged.{0,20}branch|branch.{0,20}merged|pushed.{0,20}remote|ready for review|opened a pull request"; "i")
')

if [[ "$HAS_SIGNAL" != "true" ]]; then
  exit 0
fi

# Resolve memory directory from git repo root or cwd
# Use pwd -P to resolve symlinks (macOS /var -> /private/var)
if command -v git &>/dev/null && git -C "$CWD" rev-parse --git-dir &>/dev/null 2>&1; then
  PROJECT_ROOT=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null)
else
  PROJECT_ROOT=$(cd "$CWD" && pwd -P)
fi

# Encode path the way Claude Code does: leading / removed, / replaced with -
ENCODED_PATH=$(echo "$PROJECT_ROOT" | sed 's|^/||; s|/|-|g')
MEMORY_DIR="$HOME/.claude/projects/-${ENCODED_PATH}/memory"

if [[ ! -d "$MEMORY_DIR" ]]; then
  exit 0
fi

# Check for non-empty .md files
HAS_CONTENT=false
for md_file in "$MEMORY_DIR"/*.md; do
  [[ -f "$md_file" ]] || continue
  if [[ -s "$md_file" ]]; then
    HAS_CONTENT=true
    break
  fi
done

if [[ "$HAS_CONTENT" != "true" ]]; then
  exit 0
fi

# All conditions met: block stop and suggest triage
jq -n '{
  decision: "block",
  reason: "You have auto memory entries for this project. Before wrapping up, run the memory-triage skill to review them and promote any valuable findings to the shared project config (CLAUDE.md or .claude/rules/)."
}'
