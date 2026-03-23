# Subagent Prompt Template

Spawn one Agent per chunk using this template. Replace all `<placeholder>` values
with actual data from the chunk being analyzed.

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
