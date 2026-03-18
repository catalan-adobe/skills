# Skill Evaluation Against Anthropic's Guide to Building Skills for Claude

**Date:** 2026-03-18
**Reference:** [The Complete Guide to Building Skill for Claude](https://resources.anthropic.com/hubfs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf) (Anthropic, 2026)
**Scope:** All 9 skills in `catalan-adobe/skills`

## Overall Score: 4.3 / 5 — Production-Quality, Well-Architected Collection

This is a mature, thoughtfully designed skill repository with clear evidence of real-world iteration. The skills demonstrate deep understanding of how agents consume instructions and where they fail without guardrails.

## Skills Evaluated

| Skill | Purpose |
|-------|---------|
| `ai-fluency-assessment` | AI fluency assessment using Anthropic's 4D framework |
| `cdp-connect` | Connect to existing Chrome browser via CDP |
| `cmux-demo` | Scripted cmux terminal demos with multi-pane layouts |
| `cmux-setup` | Manage cmux workspace colors via directory-pattern rules |
| `demo-narrate` | End-to-end voice-over for demo videos |
| `gemini-icon-set` | Generate colorful icon sets using Google Imagen 4 |
| `memory-triage` | Review auto memory and promote findings to shared config |
| `screencast` | Guided screen recording with ffmpeg |
| `video-digest` | Multimodal video summarization with timestamped YouTube links |

## Detailed Assessment

### 1. Skill Structure & Organization ⭐⭐⭐⭐⭐

**Guide recommendation:** Self-contained skills with clear separation between prompt (SKILL.md), helper scripts, and reference material. Progressive disclosure — descriptions in system prompt, full instructions loaded on-demand.

**Findings:**
- Every skill follows the `SKILL.md` + `scripts/` + optional `references/` pattern consistently
- Scripts handle mechanical work; SKILL.md is pure prompt — the ideal split
- `cmux-demo` correctly uses `references/cmux-reference.md` for large reference material
- Standalone installation instructions in every skill — excellent portability
- Clean separation: tests in `tests/`, docs in `docs/plans/`, never shipped to users

### 2. Frontmatter & Descriptions ⭐⭐⭐⭐½

**Guide recommendation:** Descriptions are the trigger mechanism — specific about *when* to use the skill, not just *what* it does. Include trigger phrases.

**Strengths:**
- Descriptions are rich, specific, and include trigger phrases (e.g., `video-digest` lists "tl;dw", "summarize this video", YouTube URL pasting)
- `cmux-demo` leads with "ESSENTIAL for any cmux terminal demo" — correctly signals urgency to the agent
- `cdp-connect` includes port number `9222` as a trigger — thoughtful detail
- Names are all valid kebab-case, matching directory names

**Caveat:** Some descriptions are long (e.g., `cmux-demo` at ~600 characters). While within the 1024-char limit, overly long descriptions in the system prompt compete for attention. A few could be tightened without losing trigger coverage.

### 3. Script Locator Pattern ⭐⭐⭐⭐⭐

**Guide recommendation:** Skills should work across environments. Use `CLAUDE_SKILL_DIR` with fallbacks.

**Findings:** Every script-backed skill uses the identical pattern:
```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  SCRIPT="${CLAUDE_SKILL_DIR}/scripts/..."
else
  SCRIPT="$(command -v ... || find ~/.claude ...)"
fi
```

Clean, defensive, and consistent across all skills.

### 4. Step-by-Step Workflow Instructions ⭐⭐⭐⭐⭐

**Guide recommendation:** Break complex tasks into numbered steps. Be explicit about what to do at each step, including error handling and edge cases.

**Strengths:**
- Every multi-step skill uses `### Step N:` format consistently
- `demo-narrate` has a 7-step pipeline with sub-steps (4a–4f) — thorough without being overwhelming
- `video-digest` handles short vs. long videos with different paths — the agent knows when to skip subagents
- `gemini-icon-set` has a full iteration loop (generate → review → retry/drop/add → regenerate)
- Edge cases explicitly handled (e.g., "If very few frames extracted, suggest lowering threshold")

**Standout:** `cmux-demo` includes a **gotchas table** with correct vs. incorrect patterns — one of the most effective techniques for preventing agent mistakes.

### 5. Agent Autonomy Calibration ⭐⭐⭐⭐

**Guide recommendation:** Specify when the agent should act autonomously vs. ask the user. Over-autonomy leads to wrong outputs; over-caution leads to annoying interruptions.

**Strengths:**
- `gemini-icon-set`: "Don't over-interview. A brief like 'ice cream shop app, fun and colorful' is enough to proceed."
- `demo-narrate`: Asks one combined question for three decisions instead of three separate questions
- `cmux-demo`: "Don't over-interview" repeated — clearly an encountered failure mode
- `memory-triage`: Clear decision boundaries — the agent classifies, the user decides
- `screencast`: Offers interactive vs. manual selection paths

**Room for improvement:** `ai-fluency-assessment` could be slightly more autonomous in the questionnaire step — e.g., allowing batch responses.

### 6. Error Handling & Dependency Management ⭐⭐⭐⭐⭐

**Guide recommendation:** Gracefully handle missing dependencies, failed steps, and unexpected states.

**Strengths:**
- Every skill with external deps has a `deps` or `check-deps` command as Step 0
- Auto-installation where possible (`uv tool install`, `uv pip install`)
- Fallback alternatives documented (e.g., `cmux-demo` missing-tool table with alternatives)
- `video-digest`: Auto-engages whisper if YouTube captions unavailable
- `demo-narrate`: "If a subagent fails, re-run individually — pipeline tolerates partial results"
- `screencast`: Handles dead processes, already-running recordings, macOS permissions

### 7. Output Quality Specification ⭐⭐⭐⭐½

**Guide recommendation:** Specify exactly what the output should look like — format, structure, design details.

**Strengths:**
- `ai-fluency-assessment` specifies exact CSS colors, fonts, report structure, heuristic bar formatting
- `gemini-icon-set` defines manifest JSON schema, output directory structure, gallery HTML requirements
- `cmux-demo` requires dual output (runnable script + markdown playbook) with exact formatting conventions
- `video-digest` has a full markdown template with image references and YouTube deep-link format

**Minor gap:** `memory-triage` output format is well-specified but could include more guidance on merging entries into existing CLAUDE.md sections without duplication.

### 8. Parallel Subagent Usage ⭐⭐⭐⭐⭐

**Guide recommendation:** Leverage parallel execution for independent tasks. Be explicit about what each subagent receives and produces.

**Findings:**
- `demo-narrate`: Contact sheet analysis spawned in parallel, each with context briefing
- `video-digest`: Chunk analysis in parallel, with explicit contact-sheet-to-chunk mapping
- Both include exact subagent prompts with `subagent_type`, description, and full instructions

Textbook parallel decomposition.

### 9. Iterative Refinement Loops ⭐⭐⭐⭐⭐

**Guide recommendation:** Creative/generative skills should support iteration — the first output is rarely perfect.

**Findings:**
- `gemini-icon-set`: Full review loop (keep/retry/drop/add) with idempotent regeneration
- `cmux-demo`: 6-step pipeline ending with "iterate based on feedback"
- `demo-narrate`: Script approval step before TTS generation ("changing text is free, re-generating audio costs time")
- `demo-narrate`: `tts-acts` is idempotent — re-run after trimming text

### 10. Hook Integration ⭐⭐⭐⭐

The `memory-triage` Stop hook nudges users to triage memory when finishing work. The 5-second timeout is appropriate. Smart use of hooks to bridge the gap between session-local knowledge and shared project config.

## Scorecard

| Criterion | Score | Notes |
|-----------|-------|-------|
| Structure & Organization | ⭐⭐⭐⭐⭐ | Textbook layout, consistent conventions |
| Descriptions & Triggers | ⭐⭐⭐⭐½ | Rich and specific; a few could be more concise |
| Step-by-Step Instructions | ⭐⭐⭐⭐⭐ | Numbered steps, sub-steps, edge cases covered |
| Error Handling | ⭐⭐⭐⭐⭐ | Auto-install, fallbacks, partial-failure tolerance |
| Agent Autonomy Calibration | ⭐⭐⭐⭐ | Good "don't over-interview" guidance throughout |
| Output Specification | ⭐⭐⭐⭐½ | Very precise for visual outputs; minor gaps elsewhere |
| Parallel Execution | ⭐⭐⭐⭐⭐ | Expert-level subagent decomposition |
| Iteration Support | ⭐⭐⭐⭐⭐ | Review loops, idempotent regeneration |
| Testing & Evaluation | ⭐⭐⭐ | Framework described but underimplemented |
| Composability | ⭐⭐⭐½ | Mentioned but not formalized |

## Recommended Improvements

### 1. Testing & Evaluation Framework (Priority: High)

The `skill-conventions.md` describes a 3-test-prompt evaluation workflow, but the `tests/` directory is sparse (only screencast and memory-triage). Add automated test scripts for more skills to catch regressions.

### 2. Compatibility Metadata (Priority: Medium)

No skills use the `compatibility` frontmatter field. Skills with platform requirements should declare them:
- `screencast`: macOS-only interactive features (pick-window, pick-region)
- `cmux-demo`, `cmux-setup`: Requires cmux
- `gemini-icon-set`: Requires `GEMINI_API_KEY`
- `ai-fluency-assessment`: Requires `ANTHROPIC_API_KEY` (or regex-only mode)

### 3. Graceful Degradation (Priority: Medium)

`cmux-demo` handles missing tools excellently (alternatives table). Other skills are more binary. Consider:
- `video-digest`: Transcript-only mode without frame extraction
- `demo-narrate`: Script-only output without TTS (partially addressed with "stop after Step 4")
- `ai-fluency-assessment`: Already has `--regex-only` fallback — good example for others

### 4. Context Window Awareness (Priority: Low)

Larger skills (`cmux-demo`, `demo-narrate`, `ai-fluency-assessment`) are 200–350 lines each. When multiple skills load simultaneously, this pressures the context window. Consider moving more sections to `references/` files loaded on-demand — `cmux-demo` already does this well and should be the model.

### 5. Cross-Skill Composition (Priority: Low)

`screencast` mentions pairing with `demo-narrate`, but there's no explicit handoff mechanism. Add brief sections documenting what each skill produces that another consumes:
- `screencast` → produces MP4 → consumed by `demo-narrate`
- `demo-narrate` → produces narrated MP4 → could feed into `video-digest` for verification
- `cdp-connect` → could be used by `screencast` for browser-specific recording workflows
