# Skill Conventions

## Structure

- `SKILL.md` = pure prompt; bundled scripts handle mechanical work
- Scripts live at `scripts/<skill-name>.sh` inside the skill directory (not skill root — tessl warns about files outside `scripts/`, `references/`, `assets/`)
- Locate scripts via `${CLAUDE_SKILL_DIR}/scripts/` with fallback search
- Keep SKILL.md under ~500 lines; extract reference material to `references/`
- Reference `references/` files with markdown link syntax `[label](references/FILE.md)`, not backtick code spans — tessl only recognizes markdown links as entrypoint references
- For large reference files (>300 lines), include a table of contents

## Script Patterns

- Subcommand pattern: `check-deps`, `generate`, `process`, `gallery`
- Auto-install dependencies (e.g., `uv tool install` for Python tools)
- JSON manifest as contract between Claude and script
- Gallery/preview HTML must inline base64 assets (fetch fails on `file://`)

## Dual-Output Skills

Skills that generate user artifacts should produce both:
1. A runnable script (self-contained, no runtime dependency on the skill)
2. A human-readable reference doc (playbook, guide, etc.)

The generated script should **copy** utility functions inline rather
than sourcing the skill's library at runtime.

## Evaluation

### Workflow
1. 3 test prompts covering different complexity levels
2. Spawn with-skill + without-skill (baseline) agents in parallel
3. Grade with assertions + qualitative review agents
4. Iterate based on findings, re-run

### Known Issues
- `skill-creator` `run_loop` with Opus shows ~6% recall (undertriggering)
  — Claude decides it can handle tasks without consulting the skill
- Manually optimizing descriptions works better: lead with what the skill
  provides that the agent can't figure out alone, emphasize what baselines
  get wrong
- Qualitative review agents hallucinate tool correctness for unfamiliar
  CLIs — always verify reviewer claims against actual `<tool> help` output
- Baselines learn tool basics from help text; skill value is in advanced
  patterns, gotcha avoidance, and structural conventions
