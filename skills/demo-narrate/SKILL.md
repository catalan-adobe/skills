---
name: demo-narrate
description: Use when the user wants to narrate a demo, add voice-over to a screen recording, or create AI narration for a silent video. End-to-end pipeline that extracts frames, analyzes with parallel subagents, writes a word-budgeted voice-over script, generates TTS audio per act, and merges everything back.
---

# Demo Narrate

Analyze a silent demo/screen recording video and produce a voice-over
with per-act audio clips merged onto the video.

## Pipeline Overview

```
0. Check dependencies (ffmpeg, edge-tts)
1. Extract timestamped contact sheets (1 FPS)
2. Build context briefing from project
3. Parallel subagents analyze contact sheets with briefing
4. Ask audience/tone, write word-budgeted act scripts
5. Generate TTS audio per act with rate fitting
6. Optionally add fade-in from black
7. Merge per-act audio onto video at timed offsets
```

## Shell Script

All ffmpeg and edge-tts operations go through the helper script bundled
with this skill at `scripts/demo-narrate.sh`.

**Locating the script:** Use `${CLAUDE_SKILL_DIR}` to resolve the
path relative to this SKILL.md:

```bash
NARRATE_SH="${CLAUDE_SKILL_DIR}/scripts/demo-narrate.sh"
```

If `CLAUDE_SKILL_DIR` is not set (older Claude Code or standalone
install), fall back to a search:

```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  NARRATE_SH="${CLAUDE_SKILL_DIR}/scripts/demo-narrate.sh"
else
  NARRATE_SH="$(command -v demo-narrate.sh 2>/dev/null || \
    find ~/.claude -path "*/demo-narrate/scripts/demo-narrate.sh" -type f 2>/dev/null | head -1)"
fi
if [[ -z "$NARRATE_SH" || ! -f "$NARRATE_SH" ]]; then
  echo "Error: demo-narrate.sh not found. Ask the user for the path." >&2
fi
```

Store the result in `NARRATE_SH` and use it for all subsequent commands.

See `references/REFERENCE.md` for the full command reference.

## Execution

### Step 0: Check Dependencies

Locate the script (see "Shell Script" above) and check dependencies:

```bash
NARRATE_SH="${CLAUDE_SKILL_DIR}/scripts/demo-narrate.sh"
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

Extract frames at 1 FPS into `<basename>_frames/` (contact sheets of up to 20 frames each):

```bash
"$NARRATE_SH" extract "<video>"
```

Report: filename, duration, frame count, sheet count.

### Step 2: Build Context Briefing

Build a ~500-word briefing from CLAUDE.md, recent commits (`git log --oneline -20`), and relevant source files so frame analysis uses the project's own terminology instead of generic descriptions. Save to `<frames_dir>/briefing.txt`.

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

If a subagent fails or returns an empty analysis, re-run it
individually. The pipeline can proceed with partial analysis,
but gaps will produce weaker narration for those time segments.

### Output Directory

Create an output directory for narration artifacts next to the video:
`<basename>_narration/`. This is where timing.txt, per-act scripts,
and generated audio will live. All subsequent steps refer to this
as `<output_dir>`.

```bash
mkdir -p "<video_dir>/<basename>_narration"
```

### Step 4: Write the Voice-Over Script (Per-Act, Word-Budgeted)

This is the critical step. The script must be structured into **acts**
that fit within the video's time windows.

#### 4a. Ask preferences (one question, three decisions)

Ask the user all three at once:
- **Audience** — technical / product / mixed (default: mixed)
- **Voice** — see `references/REFERENCE.md` or `"$NARRATE_SH" voices` (default: AriaNeural)
- **Fade-in** — 0.5s fade from black? (default: yes)

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

With 0.5s fade-in (each offset + 0.5):
```
act1_opening.mp3 0.5
act2_extraction.mp3 6.5
act3_decomposition.mp3 15.5
act4_parallel.mp3 25.5
act5_verification.mp3 40.5
act6_assembly.mp3 55.5
```

**If using fade-intro (decided in Step 4a):** add the fade duration
to every offset. The fade prepends extra time to the video, so all
content shifts forward. Fractional offsets are supported in
timing.txt (the script accepts floats), so use exact values like
`0.5` instead of rounding up to integers.

#### 4c. Check word budgets

Edge-tts AriaNeural speaks at approximately **2 words per second**.
Use this for initial budgeting — the `tts-acts` command measures
actual duration and adjusts rate, so the budget is a starting point.
Other voices may differ (GuyNeural is ~10% slower).

Each act must include a **1-second silence gap** before the next act
starts (breathing room for the viewer). The word budget per act:

```
max_audio = act_window - 1s
word_budget = max_audio x 2
```

A 10-second window gets 9s of audio = ~18 words. A 15-second window
gets 14s = ~28 words. **For the last act**, use the remaining video
time as the budget: `(video_duration - last_act_start - 1) x 2`.
Audio past the video end gets silently truncated.

Write slightly under budget — the `tts-acts` command can speed up
by up to +15% to compensate, but trimming text is better than
speeding up the voice.

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

1. Generates at normal rate (+0%) as a measurement pass
2. If audio exceeds the max duration, calculates the exact speed-up needed
3. If the needed speed-up is within +15%, regenerates at that rate
   (and escalates in +3% increments if edge-tts undershoots)
4. If it needs more than +15%, reports **LONG** immediately — trim
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

Verify that timing.txt offsets already account for the fade duration
(done in Step 4b). The command output will remind you of the shift.

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

See `references/REFERENCE.md` for output directory structure, voice
options, and standalone installation instructions.
