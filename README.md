# catalan-adobe Skills

Claude Code skills marketplace by [@catalan-adobe](https://github.com/catalan-adobe).

## Installation

### As a marketplace (recommended)

Requires Claude Code with marketplace support. Register the marketplace
once, then install any plugin:

```
/plugin marketplace add catalan-adobe/skills
/plugin install catalan-skills@catalan-adobe-skills
```

If marketplace commands are not available in your version, use the
standalone installation below.

### As a standalone skill (no plugin needed)

Copy the skill file and script directly:

```bash
# Clone the repo
git clone https://github.com/catalan-adobe/skills.git /tmp/catalan-skills

# Copy the skill you want
cp /tmp/catalan-skills/skills/demo-narrate/SKILL.md \
   ~/.claude/commands/demo-narrate.md

# Copy the helper script
cp /tmp/catalan-skills/skills/demo-narrate/scripts/demo-narrate.sh \
   ~/.local/bin/demo-narrate.sh
chmod +x ~/.local/bin/demo-narrate.sh

# Ensure ~/.local/bin is in your PATH (add to ~/.zshrc if needed):
# export PATH="$HOME/.local/bin:$PATH"
```

## Available Skills

### ai-fluency-assessment

Assess your AI fluency using Anthropic's 4D framework (Dakan, Feller &
Anthropic, 2025). Scans Claude Code sessions, runs LLM-based behavior
classification on all messages, asks a self-assessment questionnaire for
6 unobservable behaviors, and generates a visual HTML report with scores
and actionable feedback.

**Dependencies:** Python 3.13+, uv (auto-installs assess.py deps)

See [SKILL.md](skills/ai-fluency-assessment/SKILL.md) for details.

### memory-triage

Review Claude Code auto memory accumulated during a task and promote
valuable findings to shared project config (CLAUDE.md, `.claude/rules/`,
or global CLAUDE.md). Prevents knowledge silos by surfacing debugging
gotchas, architecture decisions, and project conventions for the team.

**Dependencies:** none

See [SKILL.md](skills/memory-triage/SKILL.md) for details.

### demo-narrate

End-to-end voice-over generation for demo videos. Takes a silent screen
recording, analyzes it with parallel AI agents, writes a word-budgeted
narration script, generates per-act TTS audio (free, via edge-tts), and
merges everything onto the video.

**Dependencies:** ffmpeg (required), edge-tts (auto-installed)

See [SKILL.md](skills/demo-narrate/SKILL.md) for the
full pipeline documentation.

### gemini-icon-set

Generate production-quality colorful icon sets using Google Imagen 4.
Suggests icons based on project context, generates 1024px PNGs, removes
backgrounds, downscales to all target sizes (16-256px), and delivers an
interactive review gallery for iterative refinement. Five style presets:
kawaii, flat, glossy, sketch, pixel.

**Dependencies:** GEMINI_API_KEY, rembg (auto-installed), sips (macOS) or ImageMagick

See [SKILL.md](skills/gemini-icon-set/SKILL.md) for the full workflow.

### video-digest

Multimodal video summarization. Downloads a video (YouTube or any
yt-dlp-supported URL), extracts transcript (YouTube captions or
Whisper), pulls scene-detected keyframes, and produces a summary
with clickable timestamped YouTube links. Supports parallel chunk
analysis for long videos and adjustable depth (brief/detailed/full).

**Dependencies:** yt-dlp, ffmpeg (required); whisper-ctranslate2 (optional, auto-installed)

See [SKILL.md](skills/video-digest/SKILL.md) for the full pipeline.

### cdp-connect

Connect Claude Code to an existing Chrome browser via Chrome DevTools
Protocol. Zero dependencies — uses Node 22 built-in WebSocket. Navigate,
click, type, screenshot, evaluate JS, read accessibility tree, and
monitor console/network events against any Chrome running with
`--remote-debugging-port`.

**Dependencies:** Node 22+ (built-in WebSocket and fetch)

See [SKILL.md](skills/cdp-connect/SKILL.md) for the full command reference.

### cdp-ext-pilot

Launch Chrome with an unpacked extension loaded and test its UI via CDP.
Auto-installs Chrome for Testing if needed. Opens sidepanel, popup, or
options page and hands off to `cdp-connect` for interaction. Handles
Chrome 137+ branded build restrictions and sidepanel user gesture
requirements.

**Dependencies:** Node 22+, `cdp-connect` skill

See [SKILL.md](skills/cdp-ext-pilot/SKILL.md) for the full workflow.

### screencast

Guided screen recording from Claude Code. Pick a display, window, or
custom region, then start/stop recording on demand. Uses ffmpeg for
cross-platform support (macOS, Linux, Windows). Produces MP4 with
sensible defaults. Pairs with demo-narrate for voice-over.

**Dependencies:** ffmpeg (required), Node 22+

See [SKILL.md](skills/screencast/SKILL.md) for the full workflow.

### cmux-demo

Scripted cmux terminal demos and workflows. Produces a runnable bash
script and markdown playbook covering multi-pane IDE layouts, browser
previews, multi-agent orchestration with signal coordination, sidebar
metadata, visual effects, and pane lifecycle management.

**Dependencies:** cmux CLI

See [SKILL.md](skills/cmux-demo/SKILL.md) for the full workflow.

### cmux-setup

Manage cmux workspace visual configuration. Automatically colors
workspaces based on directory-pattern rules using a JSON config and a
zsh chpwd hook. Supports persistent setup (auto-apply on every cd) and
on-demand coloring. Most-specific pattern wins.

**Dependencies:** Node 22+, cmux CLI

See [SKILL.md](skills/cmux-setup/SKILL.md) for the full workflow.

### news-digest

Fetch and digest news from Google News RSS feeds and Google Alerts by
topic. Scans configured topics, deduplicates stories, and produces a
tight markdown digest. Use when you want a news summary, topic scan, or
daily digest of headlines.

### page-prep

Prepare webpages for clean interaction by detecting and removing disruptive
overlays (cookie banners, GDPR consent, modals, popups, paywalls). Uses a
cached database of 300+ known CMPs (Consent-O-Matic + EasyList) combined
with heuristic DOM scanning to produce portable JS recipes for any browser
tool (Playwright, CDP, cmux-browser). Supports both CSS hide (for screenshots)
and interactive dismiss (for automation) modes, plus MutationObserver watch
mode for long sessions.

**Dependencies:** Node 22+

See [SKILL.md](skills/page-prep/SKILL.md) for the full workflow.

### browser-universal

Detect available browser interaction layer (Playwright MCP, Slicc
playwright-cli, cmux-browser, CDP) and load the right commands. Other
skills depend on this instead of hardcoding a specific browser layer.
Supports layer preference, dynamic reference loading from source of truth,
and a universal verb mapping for navigate, snapshot, click, fill, eval,
screenshot, wait, and tab management.

**Dependencies:** none

See [SKILL.md](skills/browser-universal/SKILL.md) for details.

### slack-cdp

Control Slack via CDP or headless API tokens. Navigate channels,
read/send messages, search conversations, check unreads, and manage
status. Two modes: CDP (Slack desktop with `--remote-debugging-port`)
for full UI control, or headless (xoxp/xoxb token) for data operations
without Slack running.

**Dependencies:** Node 22+, `cdp-connect` skill (CDP mode only)

See [SKILL.md](skills/slack-cdp/SKILL.md) for details.

### kite-teleport

Teleport a Kite task session to local Claude Code. Takes a teleport
token generated by `/kite teleport` in Slack, fetches the converted
session from the Kite worker, places it in the Claude Code session
directory, and offers branch checkout.

**Dependencies:** curl, KITE_WORKER_URL env var

See [SKILL.md](skills/kite-teleport/SKILL.md) for details.

### spectrum-2-web

Design and build web UIs with Adobe Spectrum 2 design system. Outputs
vanilla CSS with Spectrum tokens (static pages) or Spectrum Web
Components (interactive apps). Recommends output tier based on
complexity.

See [SKILL.md](skills/spectrum-2-web/SKILL.md) for details.

## License

MIT
