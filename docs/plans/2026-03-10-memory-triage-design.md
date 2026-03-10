# Memory Triage Skill Design

Date: 2026-03-10

## Problem

Claude Code's auto memory (`MEMORY.md` + topic files) accumulates knowledge
during a task but is machine-local and per-user. Valuable findings (debugging
gotchas, architecture decisions, CI workarounds) stay invisible to teammates.
Personal memory can also silently contradict shared project config, causing
inconsistencies across developers.

The discipline of reviewing memory and promoting useful entries to shared
project configuration (CLAUDE.md, `.claude/rules/`) is easy to skip. This
skill automates the review process.

## Design

### Scope

Triages the full auto memory directory for the current project:
- `MEMORY.md` (the index file)
- All topic files linked from MEMORY.md (e.g., `debugging.md`, `patterns.md`)

### Interaction Flow

1. **Discover** — Locate and read the project's auto memory directory
   (`~/.claude/projects/<project>/memory/`). If empty or missing, report
   "No memory to triage" and stop.

2. **Classify** — Parse each distinct entry (using markdown headers/bullets
   as boundaries). Classify as:
   - **Promote candidate**: project knowledge useful to any developer
     (debugging gotchas, architecture decisions, CI workarounds, API quirks,
     build commands)
   - **Ephemeral**: task-specific state, intermediate debugging steps,
     personal workflow notes, non-generalizable file paths

3. **Present candidates** — Show promote candidates grouped by theme. For
   each, display the entry and a one-line rationale. End with a count of
   filtered ephemeral entries and offer to show them.

4. **Triage decisions** — For each candidate (or group), ask:
   - **Promote** — then ask target:
     - Project `CLAUDE.md` (or `.claude/CLAUDE.md`)
     - A `.claude/rules/<topic>.md` file
     - Global `~/.claude/CLAUDE.md`
   - **Discard** — skip it
   - **Show filtered** — reveal ephemeral entries for rescue

5. **Apply** — Append promoted entries to chosen target files. Create target
   if it doesn't exist. Report summary of what was promoted and where.

### Constraints

- No deletion of memory files (leave as-is)
- No git commits (user decides when to commit)
- No worktree requirement (works in any project context)
- Read-only with respect to memory files; write-only to target config files

### Trigger: Plugin Stop Hook

Bundled with the plugin at `hooks/hooks.json`. Fires on every `Stop` event
and checks two conditions before triggering:

1. **Completion signal** — `last_assistant_message` matches strong patterns:
   `gh pr create`, "pull request created", "PR #N", "merged branch",
   "pushed to remote", "ready for review"
2. **Non-empty memory** — the project's auto memory directory has `.md`
   files with content

If both conditions are met, the hook returns `decision: "block"` with a
reason that tells Claude to invoke the memory-triage skill.

Safety: checks `stop_hook_active` to prevent infinite loops. 5-second
timeout to avoid blocking.

Script: `scripts/memory-triage-reminder.sh`

## Implementation

```
skills/memory-triage/SKILL.md     <- the skill (pure prompt, no deps)
hooks/hooks.json                  <- Stop hook configuration
scripts/memory-triage-reminder.sh <- hook script (bash + jq)
```
