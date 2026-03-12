---
name: video-digest
description: Summarize any video by analyzing both audio and visuals. Downloads via yt-dlp, extracts transcript (YouTube captions or Whisper), pulls scene-detected keyframes, and produces a multimodal summary with clickable timestamped YouTube links. Use this skill whenever the user wants to summarize a YouTube video, digest a talk or tutorial, get notes from a video, extract key points from a recording, or says things like "tl;dw", "summarize this video", "what's in this video", or pastes a YouTube URL and asks for a summary. Also triggers for non-YouTube URLs that yt-dlp supports.
---

# Video Digest

Summarize a video by combining audio transcript with visual frame
analysis. Produces a markdown summary with clickable timestamped
links back to the source video.

## Pipeline Overview

```
Video URL (or local file)
  0. Check dependencies (yt-dlp, ffmpeg)
  1. Download video + metadata
  2. Extract transcript (YouTube captions first, Whisper fallback)
  3. Extract keyframes via scene detection
  4. Segment into chapters or time-based chunks
  5. Parallel subagents analyze chunks (frames + transcript)
  6. Synthesize final summary
  7. Write markdown file + print stdout preview
```

## Shell Script

All yt-dlp, ffmpeg, and whisper operations go through the helper
script bundled with this skill at `scripts/video-digest.sh`.

**Locating the script:**

```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  DIGEST_SH="${CLAUDE_SKILL_DIR}/scripts/video-digest.sh"
else
  DIGEST_SH="$(command -v video-digest.sh 2>/dev/null || \
    find ~/.claude -path "*/video-digest/scripts/video-digest.sh" -type f 2>/dev/null | head -1)"
fi
if [[ -z "$DIGEST_SH" || ! -f "$DIGEST_SH" ]]; then
  echo "Error: video-digest.sh not found. Ask the user for the path." >&2
fi
```

Store the result in `DIGEST_SH` and use it for all subsequent commands.

Commands:
- `deps` — check and report dependency status
- `download <url> [workdir]` — download video + metadata + thumbnail
- `transcript <workdir> [--force-whisper] [--lang LANG]` — extract captions or transcribe
- `frames <video> [threshold] [workdir]` — scene-detect keyframes + contact sheets
- `info <workdir>` — parse metadata, report title/duration/chapters

## User Flags

Parse these from the user's message or ask if ambiguous:

| Flag | Default | Purpose |
|------|---------|---------|
| `--depth` | `detailed` | `brief`, `detailed`, or `full` |
| `--force-whisper` | off | Skip YouTube captions, transcribe with whisper-ctranslate2 |
| `--scene-threshold` | `0.3` | ffmpeg scene detection sensitivity (0.1-1.0) |
| `--lang` | `en` | Subtitle/transcription language code |

## Execution

### Step 0: Check Dependencies

Locate the script and check dependencies:

```bash
"$DIGEST_SH" deps
```

**If any required dependency is missing, stop and offer to install:**

```bash
brew install yt-dlp ffmpeg
```

Do NOT proceed to Step 1 until both yt-dlp and ffmpeg are confirmed
available. Re-run `deps` after installation to verify.

**Optional:** whisper-ctranslate2 (only needed with `--force-whisper`).
Auto-installed on first use via `uv tool install whisper-ctranslate2`.

### Step 1: Download Video

Ask the user for the video URL if not already provided. Then download:

```bash
"$DIGEST_SH" download "<url>" "<workdir>"
```

The work directory defaults to `./video_digest_<video_id>/` in the
current working directory. The script downloads:
- Video file (capped at 1080p)
- Metadata JSON (title, chapters, description, duration, uploader)
- Thumbnail

After download, report to the user:
- Title, channel, duration
- Whether chapters are available
- File size

### Steps 2 & 3: Extract Transcript + Keyframes (PARALLEL)

Steps 2 and 3 are independent — run them simultaneously using
two Bash tool calls in the same message. This saves significant
time, especially on longer videos where both operations are slow.

#### Step 2: Extract Transcript

```bash
"$DIGEST_SH" transcript "<workdir>" [--force-whisper] [--lang en]
```

**Default path:** Extracts YouTube captions (manual preferred over
auto-generated). Parses the VTT file into timestamped segments.

**`--force-whisper` path:** Extracts audio as WAV, transcribes with
whisper-ctranslate2 (faster-whisper backend). Produces timestamped SRT
which is converted to our format automatically.

**Auto-fallback:** If no YouTube captions exist and `--force-whisper`
was not specified, the script auto-engages Whisper and prints a
notice. Inform the user this is happening and that it takes longer.

The transcript is saved as `<workdir>/transcript.txt` with timestamps:
```
[00:00:05] Welcome to this talk about...
[00:00:12] Today we'll cover three topics...
```

#### Step 3: Extract Keyframes

```bash
"$DIGEST_SH" frames "<workdir>/<video_file>" [threshold] "<workdir>"
```

Default scene threshold is 0.3 (tunable by user). The script:
1. Extracts frames at scene boundaries with burned-in timestamps
2. Records timecodes to `<workdir>/frames/timecodes.txt`
3. Assembles contact sheets (5x4 grids, up to 20 frames each)

Report: number of keyframes extracted, number of contact sheets.

If very few frames are extracted (< 5 for a video > 2 minutes),
suggest the user lower the threshold: "Only N frames detected.
Try `--scene-threshold 0.2` for more granularity?"

### Step 4: Segment into Chapters

Parse the metadata JSON for chapter information:

```bash
"$DIGEST_SH" info "<workdir>"
```

**Short videos (< 10 minutes):** Skip chunking entirely. Read the
full transcript AND every contact sheet image (using the Read tool)
in a single analysis pass (Step 5 without subagents). This avoids
unnecessary overhead for content that fits in one context window.

**Longer videos with chapters:** Use chapters as segment boundaries.
Map each frame and transcript segment to its chapter by timecode.

**Longer videos without chapters:** Split into chunks of approximately
10 minutes. Align chunk boundaries to the nearest extracted keyframe
timecode so each chunk starts on a clean visual break.

For each chunk, prepare:
- The transcript segment (lines within the time window)
- The contact sheet(s) covering that time window
- Chapter title (or "Part N: MM:SS - MM:SS" for auto-chunks)

### Step 5: Parallel Subagent Analysis

For short videos (< 10 min), analyze directly without subagents —
read the transcript and ALL contact sheets yourself (use the Read
tool on each sheet image) and produce the summary inline. While
analyzing, identify notable frames for the screenshot gallery
(same criteria as subagents — see below). Skip to Step 6.

For longer videos, spawn one Agent per chunk, ALL IN PARALLEL.
Each subagent MUST receive both the transcript segment AND the
contact sheet image path(s) for its chunk. Never skip the visual
frames — even talking-head videos have moments where on-screen
text, graphics, or body language adds context the audio misses.

**Mapping contact sheets to chunks:** Contact sheets are numbered
sequentially (sheet_001.jpg, sheet_002.jpg, ...) with up to 20
frames each at 30-second intervals. Use the burned-in timestamps
on the frames to determine which sheet(s) cover each chunk's time
window. A chunk may span parts of two sheets — include both.

For each chunk:

```
Agent(
  subagent_type="general-purpose",
  description="Analyze: <chapter_title>",
  prompt="You are analyzing a segment of a video for summarization.
This is a RESEARCH-ONLY task — do not write any code or edit files.

## Video Info
Title: <title>
Channel: <channel>
Segment: <start> - <end> (<chapter_title>)
Summary depth: <brief|detailed|full>

## Transcript
<timestamped transcript lines for this segment>

## Visual Frames
IMPORTANT: You MUST read the contact sheet image(s) listed below
using the Read tool before writing your summary. These are scene-
detected keyframes with burned-in timestamps from this segment.

Contact sheet(s) for this segment:
- <absolute_path_to_sheet_NNN.jpg>

After reading, note what is visible: slides, code, diagrams, UI
state, text overlays, presenter gestures, or scene changes. If
the visuals are mostly static (e.g., talking head), say so briefly
and focus on the transcript — but still read the image to confirm.

## Task
Produce a section summary combining what is said (transcript) with
what is shown (frames). Adapt to the requested depth:

- brief: 1-2 sentences capturing the main point
- detailed: key topics, sub-points, and notable visual elements
- full: comprehensive notes including specific details, quotes,
  code snippets, diagram descriptions, and all visual context

For ALL depth levels, include:
- The most important timestamp(s) worth jumping to
- Any visual elements that add context beyond the audio
  (slides, diagrams, code, demos, UI, whiteboard)

Format your output as:
### <chapter_title> [MM:SS]
<summary content>

**Key moments:**
- [MM:SS] <description>

**Notable frames** (ONLY if genuinely important visual content —
diagrams, key slides, code, demos, charts, significant UI state):
- [MM:SS] what makes this frame important

Be aggressive: most frames are NOT notable. A talking head, generic
title slide, or static screen is NOT notable. Only flag frames where
the visual IS the content a reader would want to see.

Save output to <workdir>/chunk_<N>_summary.txt"
)
```

After all agents complete, read their outputs. If any failed,
re-run individually — the pipeline tolerates partial results but
flag gaps to the user.

### Step 6: Synthesize Final Summary

Combine all chunk summaries into a cohesive document. The video
URL is needed for timestamp links — extract the video ID from the
metadata JSON.

Build YouTube deep links using the format:
`https://youtube.com/watch?v=<VIDEO_ID>&t=<SECONDS>`

**Prepare assets directory:**

Create `<workdir>/assets/` and populate it:

1. **Thumbnail:** Find the downloaded thumbnail in workdir (usually
   `<id>.webp` or `<id>.jpg` from `--write-thumbnail`). Copy to
   `assets/<video_id>_thumbnail.jpg`, converting if needed:
   ```bash
   ffmpeg -y -loglevel error -i "<workdir>/<thumbnail>" "<workdir>/assets/<video_id>_thumbnail.jpg"
   ```
2. **Screenshots:** Collect notable frames flagged by subagents (or
   from your own analysis for short videos). Match their timestamps
   against `frames/timecodes.txt` (line N = `frame_<N zero-padded
   to 4>.jpg`) to find the closest frame file. Copy selected frames
   to `assets/<video_id>_screenshot_01.jpg`, `<video_id>_screenshot_02.jpg`, etc.

   Apply aggressive filtering — only include frames where the visual
   is genuinely important: architecture diagrams, key slides, code
   demos, charts, significant UI states. Skip talking heads, generic
   titles, and static screens. Aim for 3-8 screenshots even for long
   videos. If no frames are notable, omit the Screenshots section.

For local files (no yt-dlp download), omit the URL line and thumbnail
if no thumbnail was downloaded.

Structure the final markdown:

```markdown
# Video Digest: <Title>

**Channel:** <uploader> | **Duration:** <duration> | **Date:** <date>\
**URL:** <source-url>

![Video thumbnail](assets/<video_id>_thumbnail.jpg)

## tl;dw
<2-3 sentence overview — always present regardless of depth>

## Contents
- [Chapter Title](#section-anchor) ([MM:SS](youtube-deep-link))
- ...

## <Chapter Title>
<section summary with inline timestamp links>

...

## Key Moments
- [MM:SS](youtube-deep-link) — <description>
- ...

## Screenshots

> Curated frames — only visually significant moments.

![<description>](assets/<video_id>_screenshot_01.jpg)
*[MM:SS](youtube-deep-link) — <description>*

...
```

For `brief` depth: tl;dw + Contents with one-line descriptions only.
For `detailed` depth: full structure as above.
For `full` depth: full structure plus exhaustive notes per section.

The Screenshots section is included at ALL depth levels when notable
frames exist. Omit it entirely if no frames were flagged as notable.

### Step 7: Output

Save the full summary to `<workdir>/digest.md`.

Print a condensed preview to stdout:

```
Video Digest: <Title>
Duration: MM:SS | Sections: N | Frames analyzed: N | Screenshots: N

tl;dw
<2-3 sentence overview>

Sections
- [00:00 - Introduction](https://youtube.com/watch?v=xxx&t=0)
- [05:23 - Setting up the project](https://youtube.com/watch?v=xxx&t=323)
- ...

Full summary: <workdir>/digest.md
Assets: <workdir>/assets/
```

## Important Notes

- **Transcript is primary, frames are supplementary.** The audio
  carries most of the information in talks and tutorials. Frames
  add context that audio alone misses: slides, code, diagrams,
  demos, facial expressions, visual transitions.
- **Contact sheets compress tokens.** A 5x4 grid of 20 frames in
  one image is far more token-efficient than 20 separate images.
  This is the same pattern used by demo-narrate.
- **Scene detection threshold 0.3** is the sweet spot for most
  content. Lower values (0.1-0.2) for screencast/slides with
  subtle changes. Higher (0.5+) for fast-cut video.
- **YouTube deep links** use `&t=<seconds>` format. Convert
  MM:SS timestamps to total seconds for the URL parameter.
- **Non-YouTube URLs** work if yt-dlp supports them, but
  timestamp links will only be generated for YouTube URLs.
- **Local files** are supported — skip the download step and
  go straight to transcript + frames extraction. No timestamp
  links for local files.

## Standalone Installation

1. Copy `SKILL.md` to `~/.claude/commands/video-digest.md`
2. Copy `scripts/video-digest.sh` to `~/.local/bin/video-digest.sh`
   and `chmod +x` it
3. The fallback search will find it via `command -v video-digest.sh`
