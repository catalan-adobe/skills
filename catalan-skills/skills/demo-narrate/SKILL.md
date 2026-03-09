---
name: demo-narrate
description: Analyze a silent demo video and produce a timed voice-over with per-act audio clips merged onto the video. Takes a screen recording, extracts frames, uses parallel subagents with project context to describe each frame, writes a word-budgeted script structured into acts, generates TTS audio per act, and merges everything back. Fully end-to-end. Use when the user wants to narrate a demo, add voice-over to a screen recording, or improve a demo with AI narration.
---

# Demo Narrate

Analyze a silent demo/screen recording video and produce a voice-over
with per-act audio clips merged onto the video.

## Pipeline Overview

```
Video file
  0. Check dependencies (ffmpeg, edge-tts — auto-installed if missing)
  1. Extract timestamped contact sheets (default 1 FPS)
  2. Build context briefing from project (CLAUDE.md, recent commits, docs)
  3. Parallel subagents analyze contact sheets WITH context briefing
  4. Ask audience/tone, structure script into word-budgeted acts
  5. Generate TTS audio per act with automatic rate fitting
  6. Optionally add fade-in from black
  7. Merge per-act audio onto video at timed offsets
```

Everything runs within Claude Code. The only external dependencies are
ffmpeg and edge-tts (both auto-installed if missing).

## Shell Script

All ffmpeg and edge-tts operations go through the helper script bundled
with this skill at `scripts/demo-narrate.sh`.

**Locating the script:** The script lives relative to this SKILL.md
file. To find the absolute path, run:

```bash
find ~/.claude -path "*/demo-narrate/scripts/demo-narrate.sh" -type f 2>/dev/null | head -1
```

Store the result in a variable (e.g., `NARRATE_SH`) and use it for
all subsequent commands. If not found, the user may have installed
the skill standalone — ask them for the path.

Commands:
- `extract <video> [fps]` — extract frames and contact sheets
- `tts-acts <dir> <timing.txt> [voice]` — generate per-act audio
- `tts-acts --dry-run <dir> <timing.txt>` — show budgets without TTS
- `merge-acts <video> <dir> <timing.txt> [out]` — merge audio onto video
- `fade-intro <video> [secs] [out]` — add fade-in from black
- `deps` — check dependencies
- `voices` — list available TTS voices
- `tts <file> [voice]` — single-file TTS (legacy, for non-act workflows)
- `merge <video> <audio> [out]` — single-file merge (legacy)

## Execution

### Step 0: Check Dependencies

Locate the script and check dependencies:

```bash
NARRATE_SH="$(find ~/.claude -path "*/demo-narrate/scripts/demo-narrate.sh" -type f 2>/dev/null | head -1)"
"$NARRATE_SH" deps
```

The script auto-installs edge-tts via `uv tool install` or `pipx` on
first use.

If ffmpeg is missing, tell the user: `brew install ffmpeg`.
If both uv and pipx are missing: `brew install uv`.

### Step 1: Validate Input and Extract Frames

Confirm the video file exists and get its duration:

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 "<video>"
```

Extract frames at 1 FPS (default — good for UI demos). Only ask the
user about FPS if the video is unusually long (>5 minutes) or fast.

```bash
"$NARRATE_SH" extract "<video>"
```

Frames and contact sheets are created next to the video file in a
`<basename>_frames/` directory.

Report: filename, duration, frame count, sheet count.

### Step 2: Build Context Briefing

Before analyzing frames, gather project context so the analysis is
accurate — not generic. This is the difference between "a sidebar shows
some list items" and "the scoops panel shows six agents being created."

Build a briefing (~500 words max) by reading:
- The project's CLAUDE.md (architecture, vocabulary, key concepts)
- Recent git commits on the current branch (`git log --oneline -20`)
- Any design docs or plans referenced in commits
- Key source files relevant to the feature being demoed

The briefing should cover:
- What the product/feature does (2-3 sentences)
- Key vocabulary the UI uses (component names, panel labels, states)
- The workflow being demoed (phases, steps, expected visual sequence)
- What visual cues map to what concepts

Save the briefing to `<frames_dir>/briefing.txt` for reference.

### Step 3: Analyze Frames via Parallel Subagents

Spawn one Agent per contact sheet, ALL IN PARALLEL. Each agent gets
the contact sheet image AND the context briefing.

For each contact sheet (use `subagent_type="general-purpose"`):

```
Agent(
  subagent_type="general-purpose",
  description="Analyze contact sheet N",
  prompt="You are analyzing a contact sheet from a software demo video.
This is a RESEARCH-ONLY task — do not write any code or edit any files.

## Context Briefing
<PASTE THE FULL BRIEFING FROM STEP 2>

## Your Task
Read the image at <path>/sheet_NNN.jpg. This is a 5x4 grid of
timestamped screenshots (up to 20 frames). For EACH frame, output:

[TIMESTAMP] Description of what's visible and what's happening,
using the vocabulary from the briefing above.

Be specific about: which UI elements are active, what actions are
happening, what text is visible, what phase/step of the workflow
is in progress. Use the project's own terminology.

Save to <frames_dir>/sheet_NNN_analysis.txt"
)
```

After all agents complete, read and concatenate their analyses into
a single chronological timeline. Present it to the user.

### Step 4: Write the Voice-Over Script (Per-Act, Word-Budgeted)

This is the critical step. The script must be structured into **acts**
that fit within the video's time windows.

#### 4a. Ask preferences (one question, three decisions)

Before writing, ask the user a single combined question:

> "Before I write the script, three quick choices:
> 1. **Audience** — technical, product/general, or mixed?
> 2. **Voice** — en-US-AriaNeural (warm female, default), GuyNeural
>    (male), JennyNeural (friendly female), or en-GB-SoniaNeural (British)?
> 3. **Fade-in** — add a 0.5s fade-in from black? (recommended)"

Defaults if the user says "go with defaults": mixed, AriaNeural, yes.
These choices affect the script (audience), TTS (voice), and timing
file (fade shifts all offsets).

#### 4b. Define acts and write timing file

Group the chronological analysis into 4-8 natural acts based on what's
happening in the video (intro, phase transitions, key moments, closing).
Each act gets a time window (start-end seconds).

Create `<output_dir>/timing.txt` with one line per act.
Format: `<filename.mp3> <offset_seconds>`

Without fade-in:
```
act1_opening.mp3 0
act2_extraction.mp3 6
act3_decomposition.mp3 15
act4_parallel.mp3 25
act5_verification.mp3 40
act6_assembly.mp3 55
```

With 0.5s fade-in (all offsets shifted by +1, rounded up):
```
act1_opening.mp3 1
act2_extraction.mp3 7
act3_decomposition.mp3 16
act4_parallel.mp3 26
act5_verification.mp3 41
act6_assembly.mp3 56
```

**If using fade-intro (decided in Step 4a):** add the fade duration
to every offset. The fade prepends extra time to the video, so all
content shifts forward. Round fractional shifts up to the nearest
integer for simplicity.

#### 4c. Check word budgets

Edge-tts AriaNeural speaks at approximately **2 words per second**.
Each act must include a **1-second silence gap** before the next act
starts (breathing room for the viewer). The word budget per act:

```
max_audio = act_window - 1s
word_budget = max_audio x 2
```

A 10-second window gets 9s of audio = ~18 words. A 15-second window
gets 14s = ~28 words. Write slightly under budget — the `tts-acts`
command can speed up by up to +15% to compensate, but trimming text
is better than speeding up the voice.

Run `--dry-run` to see the budgets derived from timing.txt:

```bash
"$NARRATE_SH" tts-acts --dry-run "<output_dir>" "<output_dir>/timing.txt"
```

#### 4d. Write act scripts

For each act, write a plain text file containing ONLY the spoken words:
- No time codes, no headers, no markdown, no comments
- Just the narration text that will be read aloud
- Conversational tone, written for spoken delivery
- Each act file: `<output_dir>/act<N>_<label>.txt`

**Important:** The narration complements the visuals — it frames what
the viewer is seeing, it doesn't describe every pixel. Let the demo
carry the detail; the voice-over provides context and story.

#### 4e. Save master script

Also save `<output_dir>/script_final.txt` with all acts, their time
windows, word counts, and filenames for human reference.

#### 4f. Get user approval

Present the act structure with word counts and time windows. Ask
the user if the script reads well before generating audio. Iterate
if needed — changing text is free, re-generating audio costs time.

### Step 5: Generate Per-Act TTS Audio

Use the voice chosen in Step 4a (default: en-US-AriaNeural).

Generate all act audio files with automatic rate fitting:

```bash
"$NARRATE_SH" tts-acts "<output_dir>" "<output_dir>/timing.txt" <voice>
```

The command reads the timing file, calculates the max duration for
each act (next act's start - this act's start - 1s silence gap),
and generates TTS with automatic rate adjustment:

1. Generates at normal rate (+0%)
2. If audio exceeds the max duration, calculates the needed speed-up
3. If within +15%, regenerates with `--rate +N%`, escalating in +3%
   increments until it fits
4. If it exceeds +15% even after escalation, reports **LONG** — trim
   the text and re-run

Status labels in the output:
- **OK** — fits at normal rate, margin reported
- **RATE** — fits after speed-up, applied rate and margin reported
- **LONG** — text too long even at +15%, must be trimmed

The 1-second silence gap ensures acts never overlap. The last act
has no upper bound (plays to the end of the video).

If any act is marked LONG, trim its text file and re-run the same
command — it's idempotent and regenerates all acts.

### Step 6: Add Fade-In

Skip this step if the user declined fade-in in Step 4a.

```bash
"$NARRATE_SH" fade-intro "<video>"
```

Default is 0.5 seconds (pass a second argument to override, e.g., `1`).
This extracts the first frame, creates a frozen clip with a
fade-from-black effect, and concatenates it with the original video.
The output is slightly longer (re-encoded as libx264 crf=18 for
seamless concat).

**Important:** If using fade-intro, the timing offsets in timing.txt
must be shifted by the fade duration. The command reminds you of this.

### Step 7: Merge Audio onto Video

Merge all per-act audio clips onto the video at their timed offsets:

```bash
"$NARRATE_SH" merge-acts \
  "<video>" "<output_dir>" "<output_dir>/timing.txt" "<output_narrated.mp4>"
```

Use the fade-intro video if Step 6 was applied, not the original.

Verify the output:

```bash
ffprobe -v error -show_entries stream=codec_type,duration -of json "<output>"
```

Report: output file path, duration, file size. Open the file for the
user to review.

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

## Important Notes

- **2 words/second** is the key rate for edge-tts AriaNeural. Use this
  to calculate word budgets. Other voices may differ slightly.
- **1-second silence gap** between acts prevents overlap and gives the
  viewer breathing room. Enforced by `tts-acts`.
- **Plain text only** in act files. Any markdown, time codes, or headers
  will be read aloud by the TTS engine.
- **Context briefing** is what separates a useful narration from a
  generic screen description. Always gather project context before
  frame analysis.
- **Per-act audio** gives the user full control over timeline placement.
  The merge-acts command places clips at fixed offsets, but the user
  can also import individual clips into a video editor for fine-tuning.
- **normalize=0** on amix prevents volume from getting louder as acts
  finish. All clips play at consistent volume throughout the video.
- Contact sheets compress 20 frames into one image, keeping the number
  of subagents small (typically 2-5 for a demo video).
- edge-tts is free with no API key, account, or usage limits.
- If the user wants to skip TTS and record their own voice, stop after
  Step 4 — the per-act scripts are the deliverable.

## Standalone Installation

This skill can also be used without the full plugin:

1. Copy `SKILL.md` to `~/.claude/commands/demo-narrate.md`
2. Copy `scripts/demo-narrate.sh` somewhere on your PATH
3. Update the script path in the SKILL.md if needed
