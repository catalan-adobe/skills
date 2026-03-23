# Demo Narrate Reference

## Shell Script Commands

- `extract <video> [fps]` -- extract frames and contact sheets
- `tts-acts <dir> <timing.txt> [voice]` -- generate per-act audio
- `tts-acts --dry-run <dir> <timing.txt>` -- show budgets without TTS
- `merge-acts <video> <dir> <timing.txt> [out]` -- merge audio onto video
- `fade-intro <video> [secs] [out]` -- add fade-in from black
- `deps` -- check dependencies
- `voices` -- list available TTS voices
- `tts <file> [voice]` -- single-file TTS (manual workflow, not used by pipeline)
- `merge <video> <audio> [out]` -- single-file merge (manual workflow, not used by pipeline)

## Voice Options

Default voices for Step 4a preferences:

- **en-US-AriaNeural** -- warm female (default)
- **en-US-GuyNeural** -- male
- **en-US-JennyNeural** -- friendly female
- **en-GB-SoniaNeural** -- British

For the full list of available voices, run `"$NARRATE_SH" voices`.

## Output Directory Structure

```
<output_dir>/
  act1_opening.txt          <- plain text, spoken words only
  act1_opening.mp3          <- TTS audio for act 1
  act2_extraction.txt
  act2_extraction.mp3
  ...
  timing.txt                <- "filename offset_seconds" per line
  script_final.txt          <- master reference with all acts + metadata
```

## Standalone Installation

This skill can also be used without the full plugin:

1. Copy `SKILL.md` to `~/.claude/commands/demo-narrate.md`
2. Copy `scripts/demo-narrate.sh` to `~/.local/bin/demo-narrate.sh`
   and `chmod +x` it (must be on your PATH)
3. The fallback in the "Shell Script" section will find it via
   `command -v demo-narrate.sh` -- no path edits needed
