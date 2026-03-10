#!/bin/bash
set -euo pipefail

# Tests for memory-triage-reminder.sh
#
# Uses a temp directory with fake memory files to test all conditions.
# Exit code 0 = all tests pass, non-zero = failure.

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$SCRIPT_DIR/scripts/memory-triage-reminder.sh"

PASS=0
FAIL=0
TESTS=0

# Setup: create a temp project with memory
TMPDIR=$(mktemp -d)
FAKE_PROJECT="$TMPDIR/fake-project"
mkdir -p "$FAKE_PROJECT"
git -C "$FAKE_PROJECT" init -q

# Use git's resolved path (handles macOS /var -> /private/var symlink)
PROJECT_ROOT=$(git -C "$FAKE_PROJECT" rev-parse --show-toplevel)
ENCODED=$(echo "$PROJECT_ROOT" | sed 's|^/||; s|/|-|g')
MEMORY_DIR="$HOME/.claude/projects/-${ENCODED}/memory"
mkdir -p "$MEMORY_DIR"
echo "## Test Finding" > "$MEMORY_DIR/MEMORY.md"

cleanup() {
  rm -rf "$TMPDIR"
  rm -rf "$MEMORY_DIR"
  rmdir "$HOME/.claude/projects/-${ENCODED}" 2>/dev/null || true
}
trap cleanup EXIT

run_test() {
  local name="$1"
  local input="$2"
  local expect_trigger="$3"

  TESTS=$((TESTS + 1))

  OUTPUT=$(echo "$input" | "$HOOK" 2>/dev/null || true)

  if [[ "$expect_trigger" == "true" ]]; then
    if echo "$OUTPUT" | jq -e '.decision == "block"' &>/dev/null; then
      PASS=$((PASS + 1))
      echo "  PASS: $name"
    else
      FAIL=$((FAIL + 1))
      echo "  FAIL: $name (expected trigger, got: $OUTPUT)"
    fi
  else
    if [[ -z "$OUTPUT" ]]; then
      PASS=$((PASS + 1))
      echo "  PASS: $name"
    else
      FAIL=$((FAIL + 1))
      echo "  FAIL: $name (expected no trigger, got: $OUTPUT)"
    fi
  fi
}

make_input() {
  local stop_active="${1:-false}"
  local message="${2:-}"
  local cwd="${3:-$FAKE_PROJECT}"
  jq -n \
    --argjson stop_active "$stop_active" \
    --arg message "$message" \
    --arg cwd "$cwd" \
    '{stop_hook_active: $stop_active, last_assistant_message: $message, cwd: $cwd}'
}

echo "=== Memory Triage Reminder Hook Tests ==="
echo ""
echo "--- Completion signal detection ---"

run_test "gh pr create triggers" \
  "$(make_input false "I ran gh pr create and it succeeded.")" \
  true

run_test "pull request created triggers" \
  "$(make_input false "The pull request was created successfully.")" \
  true

run_test "PR #42 triggers" \
  "$(make_input false "Done, see PR #42 for the changes.")" \
  true

run_test "merged branch triggers" \
  "$(make_input false "I merged the branch into main.")" \
  true

run_test "branch merged triggers" \
  "$(make_input false "The feature branch was merged.")" \
  true

run_test "pushed to remote triggers" \
  "$(make_input false "Changes pushed to remote successfully.")" \
  true

run_test "ready for review triggers" \
  "$(make_input false "The PR is ready for review.")" \
  true

run_test "opened a pull request triggers" \
  "$(make_input false "I opened a pull request for this feature.")" \
  true

run_test "case insensitive: PULL REQUEST CREATED" \
  "$(make_input false "THE PULL REQUEST WAS CREATED.")" \
  true

echo ""
echo "--- Should NOT trigger ---"

run_test "normal response (no signal)" \
  "$(make_input false "I updated the function to use snake_case.")" \
  false

run_test "stop_hook_active prevents loop" \
  "$(make_input true "I ran gh pr create and it succeeded.")" \
  false

run_test "partial match: 'pull request' without 'created'" \
  "$(make_input false "I reviewed the pull request comments.")" \
  false

run_test "partial match: 'merged' without 'branch'" \
  "$(make_input false "I merged the two config objects together.")" \
  false

echo ""
echo "--- Memory directory conditions ---"

# Remove memory to test no-memory case
rm "$MEMORY_DIR/MEMORY.md"

run_test "no memory files: no trigger" \
  "$(make_input false "I ran gh pr create and it succeeded.")" \
  false

# Create empty memory file
touch "$MEMORY_DIR/MEMORY.md"

run_test "empty memory file: no trigger" \
  "$(make_input false "I ran gh pr create and it succeeded.")" \
  false

# Restore non-empty memory
echo "## Real finding" > "$MEMORY_DIR/MEMORY.md"

echo ""
echo "--- Non-git directory ---"

NO_GIT_DIR="$TMPDIR/no-git-project"
mkdir -p "$NO_GIT_DIR"
# Use pwd -P to resolve symlinks, matching what the hook does for non-git dirs
NO_GIT_DIR_RESOLVED=$(cd "$NO_GIT_DIR" && pwd -P)
ENCODED_NG=$(echo "$NO_GIT_DIR_RESOLVED" | sed 's|^/||; s|/|-|g')
MEMORY_DIR_NG="$HOME/.claude/projects/-${ENCODED_NG}/memory"
mkdir -p "$MEMORY_DIR_NG"
echo "## Finding" > "$MEMORY_DIR_NG/MEMORY.md"

run_test "non-git project with memory triggers" \
  "$(make_input false "The pull request was created." "$NO_GIT_DIR")" \
  true

rm -rf "$MEMORY_DIR_NG"
rmdir "$HOME/.claude/projects/-${ENCODED_NG}" 2>/dev/null || true

echo ""
echo "--- Special characters in message ---"

run_test "message with regex metacharacters" \
  "$(make_input false 'PR #42 created: fixes [bug] with (parens) and $vars and *stars*')" \
  true

run_test "message with quotes and backslashes" \
  "$(make_input false 'The pull request was created with title "fix: handle \n in strings"')" \
  true

echo ""
echo "=== Results: $PASS/$TESTS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
