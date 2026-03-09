# catalan-adobe Skills

Claude Code skills marketplace by [@anthropic-catalan](https://github.com/catalan-adobe).

## Installation

### As a marketplace (recommended)

Register the marketplace once, then install any plugin:

```
/plugin marketplace add catalan-adobe/skills
/plugin install catalan-skills@catalan-adobe-skills
```

### As a standalone skill (no plugin needed)

Copy the skill file and script directly:

```bash
# Clone the repo
git clone https://github.com/catalan-adobe/skills.git /tmp/catalan-skills

# Copy the skill you want
cp /tmp/catalan-skills/catalan-skills/skills/demo-narrate/SKILL.md \
   ~/.claude/commands/demo-narrate.md

# Copy the helper script
cp /tmp/catalan-skills/catalan-skills/skills/demo-narrate/scripts/demo-narrate.sh \
   ~/.local/bin/demo-narrate.sh
chmod +x ~/.local/bin/demo-narrate.sh
```

## Available Skills

### demo-narrate

End-to-end voice-over generation for demo videos. Takes a silent screen
recording, analyzes it with parallel AI agents, writes a word-budgeted
narration script, generates per-act TTS audio (free, via edge-tts), and
merges everything onto the video.

**Dependencies:** ffmpeg (required), edge-tts (auto-installed)

## License

MIT
