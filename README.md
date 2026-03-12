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

## License

MIT
