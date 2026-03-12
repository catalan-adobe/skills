# catalan-adobe/skills

Claude Code skills plugin. Each skill is a self-contained directory under `skills/`.

## Project Structure

```
.claude-plugin/                    Plugin manifest (plugin.json, marketplace.json)
skills/<name>/SKILL.md             Skill prompt (distributed with the plugin)
skills/<name>/scripts/             Helper scripts bundled with the skill
skills/<name>/references/          Reference docs loaded on demand
hooks/hooks.json                   Plugin hook configuration (auto-discovered on install)
tests/<name>/                      Tests (repo-only, NOT distributed with the plugin)
docs/plans/                        Design specs and implementation plans
```

## Conventions

- Skills are pure prompt (SKILL.md) when possible — no dependencies
- Helper scripts go in `skills/<name>/scripts/`, referenced via `${CLAUDE_SKILL_DIR}/scripts/`
- SKILL.md must include a fallback search if `CLAUDE_SKILL_DIR` is not set
- Tests go in `tests/<skill-name>/`, never under `skills/` (anything under `skills/` ships to users)
- Design specs follow `docs/plans/YYYY-MM-DD-<topic>-design.md`
- Update README.md, plugin.json, and marketplace.json when adding a new skill

## Local Installation

Claude Code does NOT follow symlinks in `~/.claude/commands/`. Use `scripts/sync-skills.sh` to copy skill files for local use:

```bash
./scripts/sync-skills.sh
```

This copies `skills/<name>/SKILL.md` → `~/.claude/commands/<name>.md` and helper scripts → `~/.local/bin/`. Run after editing any skill to make changes available in new Claude sessions. Auto-discovers all skills — no manual steps when adding a new skill.

## Creating New Skills

Recommended workflow:

1. **Brainstorm** — use `superpowers:brainstorming` to design the skill (clarify scope, pick approach)
2. **Plan** — use `superpowers:writing-plans` to create an implementation plan
3. **Implement** — use `superpowers:subagent-driven-development` for parallel implementation
4. **Evaluate** — use `skill-creator:skill-creator` to run test cases (with-skill vs baseline)
5. **Live test** — test on real content before shipping; eval frameworks miss platform-specific bugs and edge cases
6. **Ship** — feature branch → PR → squash merge

## Available Skills

| Skill | Purpose |
|-------|---------|
| `memory-triage` | Review auto memory and promote findings to shared config |
| `demo-narrate` | End-to-end voice-over for demo videos |
| `ai-fluency-assessment` | AI fluency assessment using Anthropic's 4D framework |
| `gemini-icon-set` | Generate colorful icon sets using Google Imagen 4 |
| `video-digest` | Multimodal video summarization with timestamped YouTube links |
