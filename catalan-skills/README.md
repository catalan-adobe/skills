# catalan-skills

Claude Code plugin with workflow automation skills.

## Skills

### demo-narrate

Analyze a silent demo video and produce a timed voice-over with per-act
audio clips merged onto the video. End-to-end pipeline:

1. Extract timestamped contact sheets from the video
2. Build context briefing from your project (CLAUDE.md, commits, docs)
3. Parallel AI agents analyze frames with domain-aware context
4. Structure narration into word-budgeted acts with timing constraints
5. Generate TTS audio per act with automatic rate fitting
6. Optionally add fade-in from black
7. Merge all audio onto the video at timed offsets

**Dependencies:** ffmpeg, edge-tts (auto-installed)

**Voice:** Uses Microsoft Edge TTS (free, no API key). Default voice:
en-US-AriaNeural.
