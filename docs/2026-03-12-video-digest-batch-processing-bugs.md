# video-digest.sh — Known Bugs from Batch Processing

Discovered while running 34 parallel digest agents against a single-creator YouTube playlist (Nate B Jones, all talking-head format, mostly VP9 webm). Date: 2026-03-12.

## Bug 1: VTT file collision in shared workdirs

**Severity:** High (produces wrong transcripts silently)

**Trigger:** Multiple agents share the same base workdir (e.g., `/tmp/video-digests/`).

**Root cause:** The `transcript` command uses `find "$workdir" -name "*.vtt" | head -1` to locate the caption file. When multiple videos download VTTs to the same directory, this grabs whichever file `find` returns first (alphabetical), not the target video's file.

**Impact:** Agents silently analyze the wrong transcript. Multiple agents independently discovered and worked around this.

**Fix:** Filter by video ID: `find "$workdir" -name "${video_id}*.vtt" | head -1`. The same issue affects the `info` command's `.info.json` lookup.

**Workaround (agents used):** Create an isolated subdirectory per video and copy/download files there before running `transcript` and `info`.

## Bug 2: ffmpeg mjpeg encoder fails on VP9/webm with non-full-range YUV

**Severity:** Medium (frame extraction fails, but transcript-only analysis still works)

**Trigger:** Input video is VP9-encoded webm (common YouTube format when yt-dlp picks best quality).

**Root cause:** The `frames` command uses `scale=640:-2` with the mjpeg encoder, which fails with:

```
[swscaler] Warning: deprecated pixel format used
Error initializing output stream -- Error while opening encoder for output stream
```

The VP9 codec outputs `tv` (limited) range YUV, but mjpeg expects `pc` (full) range. The `-2` auto-height calculation also occasionally produces odd dimensions that mjpeg rejects.

**Fix:** Add `format=yuvj420p` to the filter chain and use explicit dimensions instead of `-2`:

```bash
# Before (fails on webm):
-vf "select='gt(scene,${threshold})',scale=640:-2,drawtext=..."

# After (works on all formats):
-vf "select='gt(scene,${threshold})',format=yuvj420p,scale=640:360,drawtext=..."
```

**Workaround (agents used):** Transcode webm→mp4 first, or run ffmpeg directly with `format=yuvj420p` and fixed `640:360` dimensions.

## Bug 3: Interval-sampling fallback unreachable under `set -e`

**Severity:** Medium (loses fallback behavior for talking-head videos)

**Trigger:** Scene detection finds 0 scenes AND the mjpeg encoder fails (Bug 2).

**Root cause:** The script has fallback logic to use interval sampling (`fps=1/30`) when scene detection produces too few frames. However, when the ffmpeg command fails due to Bug 2, `set -e` causes the script to exit immediately before reaching the fallback check.

**Fix:** Wrap the scene-detection ffmpeg call in a conditional:

```bash
if ! ffmpeg ... scene_detection_command ...; then
  echo "Scene detection failed, falling back to interval sampling"
  # interval sampling logic here
fi
```

Or use `|| true` on the ffmpeg call and check output frame count afterward.

## Optimization: Skip frames for talking-head channels

**Not a bug, but a significant performance opportunity.**

33 of 34 videos from this channel had zero useful scene detections (single camera, static background, no slides or screen shares). Frame extraction added no information but consumed ~40% of processing time per video.

**Suggestion:** Add a `--transcript-only` flag that skips the `frames` step entirely. The SKILL.md could instruct agents to use this flag when the channel is known to be talking-head format, or after the first video in a batch confirms the format.

```bash
"$DIGEST_SH" download "$url" "$workdir"
"$DIGEST_SH" transcript "$workdir"  # only this
# skip: "$DIGEST_SH" frames ...
```

Alternatively, detect the format from the first contact sheet and auto-skip for subsequent videos in the same playlist.
