# catalan-adobe/skills

Claude Code skills plugin. Each skill is a self-contained directory under `skills/`.

## Project Structure

```
.claude-plugin/          Plugin manifest (plugin.json, marketplace.json)
skills/<name>/SKILL.md   Skills (distributed with the plugin)
scripts/                 Hook and utility scripts (distributed with the plugin)
hooks/hooks.json         Plugin hook configuration (auto-discovered on install)
tests/<name>/            Tests (repo-only, NOT distributed with the plugin)
docs/plans/              Design specs
```

## Conventions

- Skills are pure prompt (SKILL.md) when possible — no dependencies
- Helper scripts go in `scripts/` at the repo root, referenced via `${CLAUDE_PLUGIN_ROOT}`
- Tests go in `tests/<skill-name>/`, never under `skills/` (anything under `skills/` ships to users)
- Design specs follow `docs/plans/YYYY-MM-DD-<topic>-design.md`
- Update README.md, plugin.json, and marketplace.json when adding a new skill

## Available Skills

| Skill | Purpose |
|-------|---------|
| `memory-triage` | Review auto memory and promote findings to shared config |
| `demo-narrate` | End-to-end voice-over for demo videos |
| `ai-fluency-assessment` | AI fluency assessment using Anthropic's 4D framework |
| `gemini-icon-set` | Generate colorful icon sets using Google Imagen 4 |
