#!/usr/bin/env bash
set -euo pipefail

# Sync skills from this repo to ~/.claude/skills/
#
# Claude Code natively discovers skills at ~/.claude/skills/<name>/SKILL.md
# and makes them available as /<name> in all projects. This script copies
# the full skill directory so scripts, block-files, and references are
# co-located. CLAUDE_SKILL_DIR is set automatically by Claude Code when
# loading from this path.
#
# Run after editing skills to make changes available in new Claude sessions.

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_DIR="${REPO_DIR}/skills"
SYNC_DIR="${HOME}/.claude/skills"

mkdir -p "$SYNC_DIR"
shopt -s nullglob

synced=0
for skill_dir in "$SKILLS_DIR"/*/; do
  name="$(basename "$skill_dir")"
  skill_file="${skill_dir}SKILL.md"

  [[ -f "$skill_file" ]] || continue

  # Copy full skill directory (scripts, block-files, references, etc.)
  rm -rf "${SYNC_DIR:?}/${name}"
  cp -R "$skill_dir" "${SYNC_DIR}/${name}"

  (( ++synced ))
done

# Clean up legacy commands copies if present
COMMANDS_DIR="${HOME}/.claude/commands"
if [[ -d "$COMMANDS_DIR" ]]; then
  for skill_dir in "$SKILLS_DIR"/*/; do
    name="$(basename "$skill_dir")"
    rm -f "${COMMANDS_DIR}/${name}.md"
  done
fi

echo "Synced ${synced} skills to ${SYNC_DIR}/"
