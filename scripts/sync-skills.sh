#!/usr/bin/env bash
set -euo pipefail

# Sync skills from this repo to ~/.claude/commands/ and scripts to ~/.local/bin/
# Run after editing skills to make changes available in new Claude sessions.

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_DIR="${REPO_DIR}/skills"
COMMANDS_DIR="${HOME}/.claude/commands"
BIN_DIR="${HOME}/.local/bin"

mkdir -p "$COMMANDS_DIR" "$BIN_DIR"
shopt -s nullglob

synced=0
for skill_dir in "$SKILLS_DIR"/*/; do
  name="$(basename "$skill_dir")"
  skill_file="${skill_dir}SKILL.md"

  if [[ -f "$skill_file" ]]; then
    cp "$skill_file" "${COMMANDS_DIR}/${name}.md"
    (( ++synced ))
  fi

  # Sync helper scripts if present
  for script in "${skill_dir}scripts/"*.sh; do
    [[ -f "$script" ]] || continue
    cp "$script" "${BIN_DIR}/$(basename "$script")"
    chmod +x "${BIN_DIR}/$(basename "$script")"
  done
done

echo "Synced ${synced} skills to ${COMMANDS_DIR}/"
