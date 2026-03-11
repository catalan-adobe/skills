# Shell Script Rules

## macOS Compatibility

- `grep -P` (Perl regex) does NOT work on macOS BSD grep — use `sed` or `grep -oE`
- `ffprobe -f lavfi "movie=<path>"` is unreliable — prefer `ffmpeg ... showinfo` + parse stderr
- `shellcheck` passes clean but won't catch macOS-specific runtime failures — always test on macOS

## YouTube VTT Parsing

YouTube auto-captions use a rolling 3-block cycle with zero-duration carry-over blocks. Naive parsing produces 5-6x duplicated lines. To parse correctly:
1. Skip blocks where `end - start < 0.05s` (carry-over blocks)
2. Extract only the line with `<c>` timing tags (the new text)
3. Merge phrases into ~5-second groups for readable output

## whisper-ctranslate2 (not faster-whisper)

`faster-whisper` is a Python library with no CLI. The CLI tool is `whisper-ctranslate2`, which wraps it. Install: `uv tool install whisper-ctranslate2`. Use `--output_format srt` (not `txt`) to get timestamps.
