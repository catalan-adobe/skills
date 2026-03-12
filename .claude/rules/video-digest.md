# video-digest Skill

## Architecture

- Shell script (`video-digest.sh`) handles all external tool calls (yt-dlp, ffmpeg, whisper)
- SKILL.md orchestrates the pipeline and subagent dispatch
- YouTube captions first, Whisper fallback — captions are instant and free
- Scene detection (`select=gt(scene,0.3)`) over perceptual hashing — zero extra deps
- Contact sheets (5x4 grids) for token-efficient frame analysis
- Short videos (< 10 min) skip chunking; long videos use parallel subagents per chapter

## Known Bugs (resolved in code, documented here to prevent regressions)

- YouTube auto-caption VTT has rolling 3-block cycles with zero-duration carry-over blocks — naive parsing produces 5-6x duplication. Fix: skip zero-duration blocks, extract `<c>`-tagged text, merge into ~5s groups.
- `ffprobe -f lavfi "movie=<path>"` produces empty results for timecodes. Fix: use `ffmpeg -vf "select=...,showinfo" -f null -` and parse `pts_time:` from stderr.
- Fixed-camera content (podcast, talking head) yields < 5 frames even at low thresholds. Fix: auto-fallback to interval sampling (1 frame/30s) when < 5 scenes on > 2 min video.

## Frame Analysis Value

- Talking-head videos: frames confirm visual format but add little content value
- Tutorial/demo videos: frames surface slides, code, UI state, dashboards — details absent from audio
- Always send contact sheets to subagents regardless — agents report what they see (or don't see)
