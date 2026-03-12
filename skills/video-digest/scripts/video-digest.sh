#!/usr/bin/env bash
set -euo pipefail

# video-digest: Download and extract video content for AI summarization.
#
# Workflow:
#   1. download   → yt-dlp fetches video + metadata
#   2. transcript → YouTube captions or whisper-ctranslate2 transcription
#   3. frames     → ffmpeg scene detection + contact sheets
#   4. (Claude)   → parallel subagents analyze chunks
#
# Dependencies: yt-dlp (required), ffmpeg (required),
#               whisper-ctranslate2 (optional, auto-installed)

SCENE_THRESHOLD=0.3

usage() {
  cat <<'EOF'
Usage: video-digest <command> [options]

Commands:
  download <url> [workdir]        Download video + metadata + thumbnail
  transcript <workdir> [options]  Extract captions or transcribe audio
  frames <video> [threshold] [workdir]
                                  Scene-detect keyframes + contact sheets
  info <workdir>                  Show video metadata and chapters
  deps                            Check and report dependencies

Transcript options:
  --force-whisper                 Skip YouTube captions, use whisper-ctranslate2
  --lang LANG                    Language code (default: en)

Frames:
  threshold                       Scene detection sensitivity, 0.1-1.0 (default: 0.3)

Example workflow:
  video-digest deps
  video-digest download "https://youtube.com/watch?v=xxxxx"
  video-digest transcript ./video_digest_xxxxx/
  video-digest frames ./video_digest_xxxxx/*.mp4
  video-digest info ./video_digest_xxxxx/
EOF
}

ensure_ytdlp() {
  if ! command -v yt-dlp &>/dev/null; then
    echo "Error: yt-dlp not found. Install with: brew install yt-dlp" >&2
    exit 1
  fi
}

ensure_ffmpeg() {
  if ! command -v ffmpeg &>/dev/null; then
    echo "Error: ffmpeg not found. Install with: brew install ffmpeg" >&2
    exit 1
  fi
}

ensure_whisper_cli() {
  if command -v whisper-ctranslate2 &>/dev/null; then
    return 0
  fi

  echo "whisper-ctranslate2 not found. Installing..." >&2

  if command -v uv &>/dev/null; then
    uv tool install whisper-ctranslate2 >&2
  elif command -v pipx &>/dev/null; then
    pipx install whisper-ctranslate2 >&2
  else
    echo "Error: need uv or pipx to install whisper-ctranslate2." >&2
    echo "  brew install uv   # then re-run" >&2
    exit 1
  fi

  if ! command -v whisper-ctranslate2 &>/dev/null; then
    echo "Error: whisper-ctranslate2 installed but not on PATH." >&2
    exit 1
  fi

  echo "whisper-ctranslate2 installed successfully." >&2
}

# Get video duration in seconds
get_duration() {
  ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" 2>/dev/null
}

# Get video ID from first video or info.json in workdir
get_video_id() {
  local workdir="$1" f
  f=$(find "$workdir" -maxdepth 1 -type f \
    \( -name "*.mp4" -o -name "*.webm" -o -name "*.mkv" \) | head -1)
  if [[ -n "$f" ]]; then
    basename "$f" | sed 's/\.[^.]*$//'
    return
  fi
  f=$(find "$workdir" -maxdepth 1 -name "*.info.json" -type f | head -1)
  if [[ -n "$f" ]]; then
    basename "$f" .info.json
    return
  fi
}

# Count files matching a glob pattern
count_files() {
  local pattern="$1"
  local count=0
  local f
  for f in $pattern; do
    [[ -e "$f" ]] && (( count++ )) || true
  done
  echo "$count"
}

cmd_deps() {
  echo "Checking dependencies..."
  echo ""

  if command -v yt-dlp &>/dev/null; then
    echo "  yt-dlp: $(yt-dlp --version 2>&1)"
  else
    echo "  yt-dlp: NOT FOUND — brew install yt-dlp"
  fi

  if command -v ffmpeg &>/dev/null; then
    echo "  ffmpeg: $(ffmpeg -version 2>&1 | head -1)"
  else
    echo "  ffmpeg: NOT FOUND — brew install ffmpeg"
  fi

  if command -v ffprobe &>/dev/null; then
    echo "  ffprobe: OK"
  else
    echo "  ffprobe: NOT FOUND — comes with ffmpeg"
  fi

  if command -v whisper-ctranslate2 &>/dev/null; then
    echo "  whisper-ctranslate2: OK"
  else
    echo "  whisper-ctranslate2: NOT FOUND (optional — auto-installed with --force-whisper)"
  fi
}

cmd_download() {
  local url="${1:?Usage: video-digest download <url> [workdir]}"

  ensure_ytdlp

  # Get video ID for directory naming
  local video_id
  video_id=$(yt-dlp --print id --no-download "$url" 2>/dev/null || echo "video")

  local workdir="${2:-./video_digest_${video_id}}"
  mkdir -p "$workdir"

  echo "Downloading: $url"
  echo "Output: $workdir/"
  echo ""

  # Download video (capped at 1080p) + metadata + thumbnail
  yt-dlp \
    -f "bv*[height<=1080]+ba/b[height<=1080]" \
    --write-info-json \
    --write-thumbnail \
    --no-playlist \
    -o "${workdir}/%(id)s.%(ext)s" \
    "$url"

  # Report what we got
  local video_file
  video_file=$(find "$workdir" -maxdepth 1 -type f \
    \( -name "*.mp4" -o -name "*.webm" -o -name "*.mkv" \) | head -1)

  if [[ -z "$video_file" ]]; then
    echo "Error: no video file found after download" >&2
    exit 1
  fi

  local duration
  duration=$(get_duration "$video_file")
  local duration_int=${duration%.*}
  local minutes=$((duration_int / 60))
  local seconds=$((duration_int % 60))

  local info_json
  info_json=$(find "$workdir" -maxdepth 1 -name "*.info.json" -type f | head -1)
  local title="Unknown"
  local uploader="Unknown"
  if [[ -n "$info_json" && -f "$info_json" ]]; then
    title=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('title','Unknown'))" "$info_json")
    uploader=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('uploader','Unknown'))" "$info_json")
  fi

  local has_chapters="no"
  if [[ -n "$info_json" && -f "$info_json" ]]; then
    local chapter_count
    chapter_count=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get('chapters') or []))" "$info_json")
    if [[ "$chapter_count" -gt 0 ]]; then
      has_chapters="yes ($chapter_count chapters)"
    fi
  fi

  local file_size
  file_size=$(du -h "$video_file" | cut -f1)

  echo ""
  echo "Title: $title"
  echo "Channel: $uploader"
  echo "Duration: ${minutes}m${seconds}s"
  echo "Chapters: $has_chapters"
  echo "File: $(basename "$video_file") ($file_size)"
  echo "Workdir: $workdir"
}

cmd_transcript() {
  local workdir="${1:?Usage: video-digest transcript <workdir> [--force-whisper] [--lang LANG]}"
  shift

  local force_whisper=0
  local lang="en"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force-whisper) force_whisper=1; shift ;;
      --lang) lang="${2:?--lang requires a value}"; shift 2 ;;
      *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
  done

  if [[ ! -d "$workdir" ]]; then
    echo "Error: workdir not found: $workdir" >&2
    exit 1
  fi

  ensure_ffmpeg

  local transcript_file="${workdir}/transcript.txt"

  # Try YouTube captions first (unless --force-whisper)
  if [[ $force_whisper -eq 0 ]]; then
    local vid_id
    vid_id=$(get_video_id "$workdir")
    local vtt_pattern="${vid_id:-*}"

    local vtt_file
    vtt_file=$(find "$workdir" -maxdepth 1 -name "${vtt_pattern}*.vtt" -type f | head -1)

    # If no VTT exists, try downloading captions
    if [[ -z "$vtt_file" ]]; then
      ensure_ytdlp
      local info_json
      info_json=$(find "$workdir" -maxdepth 1 -name "${vtt_pattern}*.info.json" -type f | head -1)
      if [[ -n "$info_json" ]]; then
        local video_url
        video_url=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('webpage_url',''))" "$info_json")
        if [[ -n "$video_url" ]]; then
          echo "Fetching YouTube captions (lang: $lang)..."
          yt-dlp --write-subs --write-auto-subs \
            --sub-langs "${lang}*" \
            --skip-download \
            -o "${workdir}/%(id)s" \
            "$video_url" 2>/dev/null || true
          vtt_file=$(find "$workdir" -maxdepth 1 -name "${vtt_pattern}*.vtt" -type f | head -1)
        fi
      fi
    fi

    # Parse VTT if we got captions
    if [[ -n "$vtt_file" && -f "$vtt_file" ]]; then
      echo "Parsing captions: $(basename "$vtt_file")"
      # Convert VTT to timestamped plain text
      # YouTube auto-captions use rolling 3-block cycles with zero-duration
      # carry-over blocks. We skip zero-duration blocks and extract only the
      # NEW text (the line with <c> timing tags) from each real block, then
      # merge into sentences grouped every ~5 seconds.
      python3 -c "
import re, sys

raw = open(sys.argv[1], encoding='utf-8').read()
raw = re.sub(r'WEBVTT.*?\n\n', '', raw, flags=re.DOTALL)
raw = re.sub(r'&nbsp;', ' ', raw)

# Parse all cue blocks, skip zero-duration ones
phrases = []
for block in re.split(r'\n\n+', raw.strip()):
    block_lines = block.strip().split('\n')
    ts_line = None
    for line in block_lines:
        m = re.match(r'(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})', line)
        if m:
            ts_line = line
            start_str, end_str = m.group(1), m.group(2)
            break
    if not ts_line:
        continue

    # Parse start/end times
    def parse_ts(s):
        h, m2, rest = s.split(':')
        sec, ms = rest.split('.')
        return int(h)*3600 + int(m2)*60 + int(sec) + int(ms)/1000
    start_t = parse_ts(start_str)
    end_t = parse_ts(end_str)

    # Skip zero-duration carry-over blocks
    if end_t - start_t < 0.05:
        continue

    # Extract only the NEW text line (has <c> timing tags)
    text_lines = [l for l in block_lines if l.strip() and not re.match(r'\d{2}:\d{2}:', l)]
    new_text = None
    for tl in text_lines:
        if '<c>' in tl or re.search(r'<\d{2}:\d{2}', tl):
            new_text = re.sub(r'<[^>]+>', '', tl).strip()
            break
    # If no tagged line, use last non-empty text line
    if not new_text and text_lines:
        new_text = re.sub(r'<[^>]+>', '', text_lines[-1]).strip()
    if new_text:
        phrases.append((start_t, new_text))

# Merge phrases into ~5-second groups
output = []
if phrases:
    group_start = phrases[0][0]
    group_words = []
    for t, text in phrases:
        if t - group_start >= 5 and group_words:
            h = int(group_start) // 3600
            m2 = (int(group_start) % 3600) // 60
            s = int(group_start) % 60
            ts = f'{m2 + h*60:02d}:{s:02d}'
            output.append(f'[{ts}] {\" \".join(group_words)}')
            group_start = t
            group_words = []
        group_words.append(text)
    if group_words:
        h = int(group_start) // 3600
        m2 = (int(group_start) % 3600) // 60
        s = int(group_start) % 60
        ts = f'{m2 + h*60:02d}:{s:02d}'
        output.append(f'[{ts}] {\" \".join(group_words)}')

with open(sys.argv[2], 'w') as f:
    f.write('\n'.join(output) + '\n')
print(f'Transcript: {len(output)} lines')
" "$vtt_file" "$transcript_file"
      echo "Saved: $transcript_file"
      return 0
    fi

    echo "No YouTube captions found. Falling back to Whisper transcription..."
  fi

  # Whisper path
  ensure_whisper_cli

  # Extract audio
  local video_file
  video_file=$(find "$workdir" -maxdepth 1 -type f \
    \( -name "*.mp4" -o -name "*.webm" -o -name "*.mkv" \) | head -1)

  if [[ -z "$video_file" ]]; then
    echo "Error: no video file found in $workdir" >&2
    exit 1
  fi

  local audio_file="${workdir}/audio.wav"
  echo "Extracting audio..."
  ffmpeg -y -loglevel error -i "$video_file" \
    -vn -acodec pcm_s16le -ar 16000 -ac 1 "$audio_file"

  echo "Transcribing with whisper-ctranslate2 (lang: $lang)..."
  whisper-ctranslate2 "$audio_file" \
    --language "$lang" \
    --output_format srt \
    --output_dir "$workdir"

  # Convert SRT to our timestamped format
  local srt_file="${workdir}/audio.srt"
  if [[ -f "$srt_file" ]]; then
    python3 -c "
import re, sys

content = open(sys.argv[1], encoding='utf-8').read()
output = []
for block in re.split(r'\n\n+', content.strip()):
    lines = block.strip().split('\n')
    if len(lines) < 2:
        continue
    # Find timestamp line (HH:MM:SS,mmm --> HH:MM:SS,mmm)
    ts_match = re.match(r'(\d{2}):(\d{2}):(\d{2}),\d{3}\s*-->', lines[1] if len(lines) > 1 else '')
    if not ts_match:
        ts_match = re.match(r'(\d{2}):(\d{2}):(\d{2}),\d{3}\s*-->', lines[0])
        text_lines = lines[1:]
    else:
        text_lines = lines[2:]
    if ts_match and text_lines:
        h, m, s = int(ts_match.group(1)), int(ts_match.group(2)), int(ts_match.group(3))
        ts = f'{m + h*60:02d}:{s:02d}'
        text = ' '.join(l.strip() for l in text_lines if l.strip())
        if text:
            output.append(f'[{ts}] {text}')

with open(sys.argv[2], 'w') as f:
    f.write('\n'.join(output) + '\n')
print(f'Transcript: {len(output)} lines')
" "$srt_file" "$transcript_file"
    echo "Saved: $transcript_file"
    rm -f "$srt_file"
  else
    echo "Error: transcription produced no output" >&2
    exit 1
  fi

  # Clean up audio file (large)
  rm -f "$audio_file"
}

cmd_frames() {
  local video="${1:?Usage: video-digest frames <video> [threshold] [workdir]}"
  local threshold="${2:-$SCENE_THRESHOLD}"
  local workdir="${3:-$(dirname "$video")}"

  ensure_ffmpeg

  if [[ ! -f "$video" ]]; then
    echo "Error: file not found: $video" >&2
    exit 1
  fi

  if ! [[ "$threshold" =~ ^[0-9]*\.?[0-9]+$ ]]; then
    echo "Error: threshold must be a number, got: $threshold" >&2
    exit 1
  fi

  local frames_dir="${workdir}/frames"
  mkdir -p "$frames_dir"

  local duration
  duration=$(get_duration "$video")
  if [[ -z "$duration" ]]; then
    echo "Error: could not read video duration" >&2
    exit 1
  fi
  local duration_int=${duration%.*}

  echo "Video: $(basename "$video") (${duration_int}s)"
  echo "Scene threshold: $threshold"
  echo ""

  # Extract scene-detected keyframes with timestamps
  echo "Detecting scenes and extracting keyframes..."
  local need_fallback=0
  if ! ffmpeg -y -loglevel error -i "$video" \
    -vf "select=gt(scene\,$threshold),format=yuvj420p,scale=640:360,drawtext=text='%{pts\:hms}':x=10:y=10:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=5" \
    -vsync vfr -q:v 2 \
    "${frames_dir}/frame_%04d.jpg"; then
    echo "Scene detection failed, falling back to interval sampling..."
    need_fallback=1
  fi

  # Extract timecodes via ffmpeg showinfo filter (more reliable than ffprobe lavfi)
  ffmpeg -i "$video" \
    -vf "select=gt(scene\,$threshold),showinfo" \
    -vsync vfr -f null - 2>&1 | \
    sed -n 's/.*pts_time:\([0-9.]*\).*/\1/p' > "${frames_dir}/timecodes.txt" || true

  local frame_count
  frame_count=$(count_files "${frames_dir}/frame_*.jpg")

  # Auto-fallback to interval sampling when too few frames for the video length
  if [[ "$frame_count" -eq 0 ]]; then
    need_fallback=1
  elif [[ "$frame_count" -lt 5 && "$duration_int" -gt 120 ]]; then
    echo "Only $frame_count scene(s) detected — adding interval samples..."
    need_fallback=1
  fi

  if [[ "$need_fallback" -eq 1 ]]; then
    if [[ "$frame_count" -eq 0 ]]; then
      echo "No scenes detected at threshold $threshold."
    fi
    echo "Sampling 1 frame every 30 seconds..."
    local fps
    fps=$(echo "scale=4; 1/30" | bc)
    ffmpeg -y -loglevel error -i "$video" \
      -vf "fps=${fps},format=yuvj420p,scale=640:360,drawtext=text='%{pts\:hms}':x=10:y=10:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=5" \
      -q:v 2 \
      "${frames_dir}/frame_%04d.jpg"
    frame_count=$(count_files "${frames_dir}/frame_*.jpg")
  fi

  echo "Extracted $frame_count keyframes"

  # Build contact sheets
  local tile_spec
  if (( frame_count <= 4 )); then
    tile_spec="${frame_count}x1"
  elif (( frame_count <= 12 )); then
    tile_spec="4x$(( (frame_count + 3) / 4 ))"
  else
    tile_spec="5x4"
  fi

  # Build contact sheets — use interval sampling if fallback was triggered
  echo "Building contact sheets (${tile_spec})..."
  if [[ "$need_fallback" -eq 1 ]]; then
    local sheet_fps
    sheet_fps=$(echo "scale=4; 1/30" | bc)
    ffmpeg -y -loglevel error -i "$video" \
      -vf "fps=${sheet_fps},format=yuvj420p,scale=384:216,drawtext=text='%{pts\:hms}':x=5:y=5:fontsize=14:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=3,tile=${tile_spec}" \
      "${frames_dir}/sheet_%03d.jpg"
  else
    ffmpeg -y -loglevel error -i "$video" \
      -vf "select=gt(scene\,$threshold),format=yuvj420p,scale=384:216,drawtext=text='%{pts\:hms}':x=5:y=5:fontsize=14:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=3,tile=${tile_spec}" \
      -vsync vfr \
      "${frames_dir}/sheet_%03d.jpg"
  fi

  local sheet_count
  sheet_count=$(count_files "${frames_dir}/sheet_*.jpg")

  echo ""
  echo "Done: $frame_count keyframes, $sheet_count contact sheet(s)"
  echo "Output: $frames_dir/"

  if [[ "$frame_count" -lt 3 && "$duration_int" -gt 120 ]]; then
    echo ""
    echo "Note: very few frames even after interval fallback."
    echo "This may be a static video (e.g., podcast, radio studio)."
  fi
}

cmd_info() {
  local workdir="${1:?Usage: video-digest info <workdir>}"

  if [[ ! -d "$workdir" ]]; then
    echo "Error: workdir not found: $workdir" >&2
    exit 1
  fi

  local vid_id
  vid_id=$(get_video_id "$workdir")
  local info_json
  info_json=$(find "$workdir" -maxdepth 1 -name "${vid_id:-*}*.info.json" -type f | head -1)

  if [[ -z "$info_json" || ! -f "$info_json" ]]; then
    echo "Error: no info.json found in $workdir" >&2
    exit 1
  fi

  python3 -c "
import json, sys

d = json.load(open(sys.argv[1]))
dur = int(d.get('duration', 0))
mins, secs = divmod(dur, 60)
hours, mins = divmod(mins, 60)

print(f'Title: {d.get(\"title\", \"Unknown\")}')
print(f'Channel: {d.get(\"uploader\", \"Unknown\")}')
print(f'Duration: {hours}h{mins:02d}m{secs:02d}s' if hours else f'Duration: {mins}m{secs:02d}s')
print(f'Date: {d.get(\"upload_date\", \"Unknown\")}')
print(f'URL: {d.get(\"webpage_url\", \"Unknown\")}')
print(f'ID: {d.get(\"id\", \"Unknown\")}')
print()

chapters = d.get('chapters') or []
if chapters:
    print(f'Chapters ({len(chapters)}):')
    for ch in chapters:
        start = int(ch.get('start_time', 0))
        m, s = divmod(start, 60)
        print(f'  [{m:02d}:{s:02d}] {ch.get(\"title\", \"Untitled\")}')
else:
    print('Chapters: none')

print()
desc = d.get('description', '')
if desc:
    lines = desc.strip().split('\n')
    preview = '\n'.join(lines[:5])
    if len(lines) > 5:
        preview += f'\n  ... ({len(lines) - 5} more lines)'
    print(f'Description:\n  {preview}')
" "$info_json"
}

if [[ -z "${1:-}" ]]; then
  usage
  exit 0
fi

case "$1" in
  download)    shift; cmd_download "$@" ;;
  transcript)  shift; cmd_transcript "$@" ;;
  frames)      shift; cmd_frames "$@" ;;
  info)        shift; cmd_info "$@" ;;
  deps)        cmd_deps ;;
  -h|--help|help) usage ;;
  *)
    echo "Error: unknown command: $1" >&2
    usage >&2
    exit 1
    ;;
esac
