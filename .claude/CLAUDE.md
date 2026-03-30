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
- When skills change, follow the full publishing checklist in `.claude/rules/publishing.md`

## Local Installation

Claude Code does NOT follow symlinks in `~/.claude/commands/`. Use `scripts/sync-skills.sh` to copy skill files for local use:

```bash
./scripts/sync-skills.sh
```

This copies each skill's full directory to `~/.claude/skills/<name>/` (the native personal skills path). Claude Code discovers skills there automatically and sets `CLAUDE_SKILL_DIR` when loading them. Run after editing any skill to make changes available in new Claude sessions.

## Creating New Skills

Recommended workflow:

1. **Brainstorm** — use `superpowers:brainstorming` to design the skill (clarify scope, pick approach)
2. **Plan** — use `superpowers:writing-plans` to create an implementation plan
3. **Implement** — use `superpowers:subagent-driven-development` for parallel implementation
4. **Register** — tessl import, lint, update manifests, sync local (see `.claude/rules/adding-skills.md`)
5. **Evaluate** — use `skill-creator:skill-creator` to run test cases (with-skill vs baseline)
6. **Live test** — test on real content before shipping; eval frameworks miss platform-specific bugs and edge cases
7. **Ship** — feature branch → PR → squash merge → publish (see `.claude/rules/publishing.md`)

## Skill Quality (tessl)

Run `tessl skill review <SKILL.md>` before shipping — free, no auth needed. Scores three dimensions: Validation (deterministic), Description/Activation (LLM judge), Content/Implementation (LLM judge). Thresholds: 90%+ great, 70-89% good, <70% needs work. Use `--optimize` to auto-improve.

Key constraints from the Agent Skills spec (agentskills.io):
- `description` field: max 1024 characters — this is the trigger mechanism
- SKILL.md body: under 500 lines recommended
- Extract detailed reference material to `references/` for progressive disclosure

Install: `curl -fsSL https://get.tessl.io | sh`. GitHub Action `tesslio/skill-review@v1` can enforce quality gates on PRs (no auth required).

All skills lint clean. All published to tessl registry. Run `tessl skill lint skills/<name>` before publishing — catches orphaned references and spec violations.

## Available Skills

| Skill | Purpose |
|-------|---------|
| `memory-triage` | Review auto memory and promote findings to shared config |
| `demo-narrate` | End-to-end voice-over for demo videos |
| `ai-fluency-assessment` | AI fluency assessment using Anthropic's 4D framework |
| `gemini-icon-set` | Generate colorful icon sets using Google Imagen 4 |
| `video-digest` | Multimodal video summarization with timestamped YouTube links |
| `cdp-connect` | Connect to existing Chrome browser via CDP |
| `cdp-ext-pilot` | Launch Chrome with unpacked extension, open UI surfaces, test via CDP |
| `screencast` | Guided screen recording with ffmpeg; macOS interactive window/region selection |
| `cmux-demo` | Scripted cmux terminal demos with multi-pane layouts |
| `cmux-setup` | Manage cmux workspace colors via directory-pattern rules |
| `page-prep` | Detect and remove webpage overlays for clean interaction |
| `browser-universal` | Detect browser layer and load commands for layer-agnostic interaction |
| `slack-cdp` | Control Slack via CDP or headless API tokens |
| `news-digest` | Google News RSS digests with full article extraction via playwright-cli |
| `kite-teleport` | Teleport Kite task sessions to local Claude Code |
| `spectrum-2-web` | Design and build web UIs with Spectrum 2 + Spectrum Web Components |
| `domain-mask` | Mask URLs behind custom domains for screencasts and demos |
| `page-collect` | Extract structured resources (icons, metadata, text, forms, videos, socials) from any webpage |
| `browser-probe` | Detect CDN bot protection and produce browser recipes for playwright-cli |
