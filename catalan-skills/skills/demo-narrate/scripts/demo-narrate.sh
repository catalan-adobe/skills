#!/usr/bin/env bash
set -euo pipefail

# demo-narrate: Free pipeline to analyze demo videos and produce voice-over scripts.
#
# Workflow:
#   1. extract    → ffmpeg pulls timestamped contact sheets from your video
#   2. (Claude)   → read the sheets in Claude Code, iterate on a voice-over script
#   3. tts-acts   → edge-tts converts per-act scripts to individual audio clips
#   4. merge-acts → ffmpeg layers timed audio clips onto the original video
#
# Dependencies: ffmpeg (required), edge-tts (auto-installed via uv/pipx)

MAX_RATE=15   # max speed-up percentage before we ask for text trimming
SILENCE_GAP=1 # seconds of silence between acts

usage() {
  cat <<'EOF'
Usage: demo-narrate <command> [options]

Commands:
  extract <video> [fps]           Extract timestamped contact sheets (default: 1 fps)
  tts <script.txt> [voice]        Generate single voice-over audio from script
  tts-acts <acts-dir> <timing.txt> [voice]
                                  Generate per-act audio, auto-adjusting rate to fit
  tts-acts --dry-run <acts-dir> <timing.txt>
                                  Show word budgets without generating audio
  merge <video> <audio> [out]     Combine video with single audio file
  merge-acts <video> <acts-dir> <timing.txt> [out]
                                  Combine video with per-act audio at timed offsets
  fade-intro <video> [secs] [out] Add fade-in from black (freeze first frame)
  voices                          List available edge-tts voices
  deps                            Check and install dependencies

Timing file format (one line per act):
  <filename.mp3> <start_seconds>
  # Lines starting with # are ignored

  The max duration for each act is calculated as:
  (next_act_start - this_act_start - 1s silence gap).
  The last act has no upper bound (plays to end of video).

Workflow:
  1. demo-narrate extract my-demo.mp4          # or: extract my-demo.mp4 1
  2. In Claude Code: analyze contact sheets, write per-act scripts
  3. demo-narrate tts-acts ./narration/ ./narration/timing.txt
  4. demo-narrate merge-acts my-demo.mp4 ./narration/ ./narration/timing.txt

Optional:
  demo-narrate fade-intro my-demo.mp4 0.5      # add fade-in before step 4
  demo-narrate tts-acts --dry-run ./narration/ ./narration/timing.txt
EOF
}

ensure_ffmpeg() {
  if ! command -v ffmpeg &>/dev/null; then
    echo "Error: ffmpeg not found. Install with: brew install ffmpeg" >&2
    exit 1
  fi
}

ensure_edge_tts() {
  if command -v edge-tts &>/dev/null; then
    return 0
  fi

  echo "edge-tts not found. Installing..." >&2

  if command -v uv &>/dev/null; then
    uv tool install edge-tts 2>&1
  elif command -v pipx &>/dev/null; then
    pipx install edge-tts 2>&1
  else
    echo "Error: need uv or pipx to install edge-tts." >&2
    echo "  brew install uv   # then re-run" >&2
    exit 1
  fi

  if ! command -v edge-tts &>/dev/null; then
    echo "Error: edge-tts installed but not on PATH." >&2
    echo "  Check: uv tool dir / pipx list" >&2
    exit 1
  fi

  echo "edge-tts installed successfully." >&2
}

# Get audio duration in seconds (floating point)
get_duration() {
  ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" 2>/dev/null
}

# Get video framerate as a fraction string (e.g., "30000/1001")
get_fps() {
  ffprobe -v error -select_streams v:0 \
    -show_entries stream=r_frame_rate -of csv=p=0 "$1" 2>/dev/null
}

# Count files matching a glob pattern safely (no ls)
count_files() {
  local pattern="$1"
  local files=()
  # shellcheck disable=SC2206
  files=($pattern)
  if [[ -e "${files[0]}" ]]; then
    echo "${#files[@]}"
  else
    echo "0"
  fi
}

cmd_deps() {
  echo "Checking dependencies..."
  echo ""

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

  if command -v edge-tts &>/dev/null; then
    echo "  edge-tts: $(edge-tts --version 2>&1 || echo 'OK')"
  else
    echo "  edge-tts: NOT FOUND — will auto-install on first use"
  fi
}

cmd_extract() {
  local video="${1:?Usage: demo-narrate extract <video> [fps]}"
  local fps="${2:-1}"

  ensure_ffmpeg

  if [[ ! -f "$video" ]]; then
    echo "Error: file not found: $video" >&2
    exit 1
  fi

  # Output next to the video file, not in cwd
  local video_dir video_base outdir
  video_dir="$(cd "$(dirname "$video")" && pwd)"
  video_base="$(basename "${video%.*}")"
  outdir="${video_dir}/${video_base}_frames"

  mkdir -p "$outdir"

  local duration
  duration=$(ffprobe -v error -show_entries format=duration \
    -of csv=p=0 "$video" | cut -d. -f1)

  local frame_count
  frame_count=$(echo "$duration * $fps" | bc | cut -d. -f1)

  local interval
  interval=$(printf "%.1f" "$(echo "scale=2; 1 / $fps" | bc)")
  interval="every ${interval}s"

  echo "Video: $video (${duration}s)"
  echo "Extracting ~${frame_count} frames (${interval}, fps=${fps})..."
  echo ""

  # Individual frames with timestamps
  ffmpeg -y -loglevel error -i "$video" \
    -vf "fps=${fps},scale=640:-2,drawtext=text='%{pts\:hms}':x=10:y=10:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=5" \
    -q:v 2 \
    "${outdir}/frame_%04d.jpg"

  # Contact sheets: 5 columns x 4 rows = 20 frames per sheet
  ffmpeg -y -loglevel error -i "$video" \
    -vf "fps=${fps},scale=384:-2,drawtext=text='%{pts\:hms}':x=5:y=5:fontsize=14:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=3,tile=5x4" \
    "${outdir}/sheet_%03d.jpg"

  local sheet_count individual_count
  sheet_count=$(count_files "${outdir}/sheet_*.jpg")
  individual_count=$(count_files "${outdir}/frame_*.jpg")

  echo "Done: ${sheet_count} contact sheet(s), ${individual_count} individual frames"
  echo "Output: ${outdir}/"
}

cmd_tts() {
  local script_file="${1:?Usage: demo-narrate tts <script.txt> [voice]}"
  local voice="${2:-en-US-AriaNeural}"
  local output="${script_file%.*}_voiceover.mp3"

  if [[ ! -f "$script_file" ]]; then
    echo "Error: file not found: $script_file" >&2
    exit 1
  fi

  ensure_edge_tts

  echo "Voice: $voice"
  echo "Script: $script_file"
  edge-tts --file "$script_file" --voice "$voice" --write-media "$output"

  local dur
  dur=$(ffprobe -v error -show_entries format=duration \
    -of csv=p=0 "$output" 2>/dev/null | cut -d. -f1)
  echo "Audio: $output (${dur}s)"
}

# Parse timing file into parallel arrays.
# Sets: TIMING_FILES[], TIMING_OFFSETS[], TIMING_COUNT
parse_timing_file() {
  local timing_file="$1"
  TIMING_FILES=()
  TIMING_OFFSETS=()
  local line_num=0
  while IFS=$' \t' read -r filename offset_s; do
    line_num=$((line_num + 1))
    [[ -z "$filename" || "$filename" == "#"* ]] && continue
    # Validate offset is a number
    if ! [[ "$offset_s" =~ ^[0-9]+\.?[0-9]*$ ]]; then
      echo "Error: timing.txt line $line_num: invalid offset '$offset_s' (must be a number)" >&2
      exit 1
    fi
    TIMING_FILES+=("$filename")
    TIMING_OFFSETS+=("$offset_s")
  done < "$timing_file"
  TIMING_COUNT=${#TIMING_FILES[@]}
}

cmd_tts_acts_dry_run() {
  local acts_dir="$1"
  local timing_file="$2"
  local silence_gap=$SILENCE_GAP

  if [[ ! -d "$acts_dir" ]]; then
    echo "Error: directory not found: $acts_dir" >&2
    exit 1
  fi
  if [[ ! -f "$timing_file" ]]; then
    echo "Error: timing file not found: $timing_file" >&2
    exit 1
  fi

  parse_timing_file "$timing_file"

  if [[ $TIMING_COUNT -eq 0 ]]; then
    echo "Error: no entries in timing file" >&2
    exit 1
  fi

  echo "Dry run — word budgets (${silence_gap}s gap, ~2 words/sec):"
  echo ""

  for ((i = 0; i < TIMING_COUNT; i++)); do
    local mp3_name="${TIMING_FILES[i]}"
    local txt_name="${mp3_name%.mp3}.txt"
    local txt_path="${acts_dir}/${txt_name}"

    local max_label budget
    if (( i + 1 < TIMING_COUNT )); then
      local window
      window=$(echo "${TIMING_OFFSETS[i+1]} - ${TIMING_OFFSETS[i]}" | bc)
      local max_s
      max_s=$(echo "$window - $silence_gap" | bc)
      max_label="${max_s}s"
      budget="~$(echo "$max_s * 2" | bc | cut -d. -f1) words"
    else
      max_label="(none)"
      budget="no limit"
    fi

    local word_count="(missing)"
    if [[ -f "$txt_path" ]]; then
      word_count="$(wc -w < "$txt_path" | tr -d ' ') words"
    fi

    printf "  %-30s max %7s  budget: %-14s  current: %s\n" \
      "$txt_name" "$max_label" "$budget" "$word_count"
  done
}

cmd_tts_acts() {
  # Handle --dry-run flag
  if [[ "${1:-}" == "--dry-run" ]]; then
    shift
    local dr_dir="${1:?Usage: demo-narrate tts-acts --dry-run <acts-dir> <timing.txt>}"
    local dr_timing="${2:?Usage: demo-narrate tts-acts --dry-run <acts-dir> <timing.txt>}"
    cmd_tts_acts_dry_run "$dr_dir" "$dr_timing"
    return
  fi

  local acts_dir="${1:?Usage: demo-narrate tts-acts <acts-dir> <timing.txt> [voice]}"
  local timing_file="${2:?Usage: demo-narrate tts-acts <acts-dir> <timing.txt> [voice]}"
  local voice="${3:-en-US-AriaNeural}"
  local silence_gap=$SILENCE_GAP

  if [[ ! -d "$acts_dir" ]]; then
    echo "Error: directory not found: $acts_dir" >&2
    exit 1
  fi
  if [[ ! -f "$timing_file" ]]; then
    echo "Error: timing file not found: $timing_file" >&2
    exit 1
  fi

  ensure_edge_tts
  ensure_ffmpeg

  parse_timing_file "$timing_file"

  if [[ $TIMING_COUNT -eq 0 ]]; then
    echo "Error: no entries in timing file" >&2
    exit 1
  fi

  # Calculate max duration for each act (next_start - this_start - gap)
  local max_durs=()
  for ((i = 0; i < TIMING_COUNT; i++)); do
    if (( i + 1 < TIMING_COUNT )); then
      local max_dur
      max_dur=$(echo "${TIMING_OFFSETS[i+1]} - ${TIMING_OFFSETS[i]} - $silence_gap" | bc | cut -d. -f1)
      if (( max_dur < 1 )); then max_dur=1; fi
      max_durs+=("$max_dur")
    else
      max_durs+=("")  # last act: no upper bound
    fi
  done

  echo "Generating TTS for $TIMING_COUNT acts (voice: $voice, ${silence_gap}s gap)..."
  echo ""

  local has_errors=0
  for ((i = 0; i < TIMING_COUNT; i++)); do
    local mp3_name="${TIMING_FILES[i]}"
    local txt_name="${mp3_name%.mp3}.txt"
    local txt_path="${acts_dir}/${txt_name}"
    local mp3_path="${acts_dir}/${mp3_name}"
    local max="${max_durs[i]}"

    if [[ ! -f "$txt_path" ]]; then
      echo "  SKIP  ${txt_name} (file not found)"
      continue
    fi

    # First pass: generate at normal rate
    edge-tts --file "$txt_path" --voice "$voice" \
      --write-media "$mp3_path" 2>/dev/null

    local dur
    dur=$(get_duration "$mp3_path")

    # If no max (last act), just report and move on
    if [[ -z "$max" ]]; then
      printf "  OK    %-30s %5.1fs (last act, no limit)\n" "$txt_name" "$dur"
      continue
    fi

    local max_f="${max}.0"

    # Check if it fits
    if (( $(echo "$dur <= $max_f" | bc -l) )); then
      local margin
      margin=$(echo "$max_f - $dur" | bc)
      printf "  OK    %-30s %5.1fs / %ss (%.1fs margin)\n" \
        "$txt_name" "$dur" "$max" "$margin"
      continue
    fi

    # Doesn't fit — calculate needed rate increase
    local rate_pct
    rate_pct=$(echo "($dur / $max_f - 1) * 100" | bc -l | cut -d. -f1)

    if (( rate_pct > MAX_RATE )); then
      # Rate alone won't fix it — report the problem
      printf "  LONG  %-30s %5.1fs / %ss (needs +%s%%, max +%s%%)\n" \
        "$txt_name" "$dur" "$max" "$rate_pct" "$MAX_RATE"
      echo "        → Trim text in ${txt_name} and re-run" >&2
      has_errors=1
      continue
    fi

    # Try rate adjustment, escalating until it fits or we hit MAX_RATE
    local applied_rate=$rate_pct
    while true; do
      edge-tts --file "$txt_path" --voice "$voice" \
        --rate "+${applied_rate}%" --write-media "$mp3_path" 2>/dev/null
      dur=$(get_duration "$mp3_path")

      if (( $(echo "$dur <= $max_f" | bc -l) )); then
        break  # fits
      fi

      # Bump and retry
      applied_rate=$((applied_rate + 3))
      if (( applied_rate > MAX_RATE )); then
        # Exhausted rate budget — mark as LONG
        printf "  LONG  %-30s %5.1fs / %ss (still over at +%s%%)\n" \
          "$txt_name" "$dur" "$max" "$MAX_RATE"
        echo "        → Trim text in ${txt_name} and re-run" >&2
        has_errors=1
        break
      fi
    done

    # Report success if we broke out of the loop with a fit
    if (( $(echo "$dur <= $max_f" | bc -l) )); then
      local margin
      margin=$(echo "$max_f - $dur" | bc)
      printf "  RATE  %-30s %5.1fs / %ss (+%s%%, %.1fs margin)\n" \
        "$txt_name" "$dur" "$max" "$applied_rate" "$margin"
    fi
  done

  echo ""
  if (( has_errors )); then
    echo "Some acts are too long. Trim the marked text files and re-run."
    echo "Max rate adjustment: +${MAX_RATE}%"
    exit 1
  else
    echo "All acts fit within their windows."
  fi
}

cmd_merge() {
  local video="${1:?Usage: demo-narrate merge <video> <audio> [output]}"
  local audio="${2:?Usage: demo-narrate merge <video> <audio> [output]}"
  local output="${3:-${video%.*}_narrated.mp4}"

  ensure_ffmpeg

  for f in "$video" "$audio"; do
    if [[ ! -f "$f" ]]; then
      echo "Error: file not found: $f" >&2
      exit 1
    fi
  done

  echo "Merging: $(basename "$video") + $(basename "$audio")"
  ffmpeg -y -loglevel error -i "$video" -i "$audio" \
    -c:v copy -c:a aac -b:a 192k \
    -map 0:v:0 -map 1:a:0 \
    -shortest \
    "$output"

  local dur
  dur=$(ffprobe -v error -show_entries format=duration \
    -of csv=p=0 "$output" 2>/dev/null | cut -d. -f1)
  echo "Output: $output (${dur}s)"
}

cmd_merge_acts() {
  local video="${1:?Usage: demo-narrate merge-acts <video> <acts-dir> <timing.txt> [output]}"
  local acts_dir="${2:?Usage: demo-narrate merge-acts <video> <acts-dir> <timing.txt> [output]}"
  local timing_file="${3:?Usage: demo-narrate merge-acts <video> <acts-dir> <timing.txt> [output]}"
  local output="${4:-${video%.*}_narrated.mp4}"

  ensure_ffmpeg

  if [[ ! -f "$video" ]]; then
    echo "Error: video not found: $video" >&2
    exit 1
  fi
  if [[ ! -d "$acts_dir" ]]; then
    echo "Error: acts directory not found: $acts_dir" >&2
    exit 1
  fi
  if [[ ! -f "$timing_file" ]]; then
    echo "Error: timing file not found: $timing_file" >&2
    exit 1
  fi

  parse_timing_file "$timing_file"

  local inputs=() filters=() labels=() idx=1
  for ((i = 0; i < TIMING_COUNT; i++)); do
    local mp3="${acts_dir}/${TIMING_FILES[i]}"
    if [[ ! -f "$mp3" ]]; then
      echo "Warning: $mp3 not found, skipping" >&2
      continue
    fi
    local offset_ms
    offset_ms=$(echo "${TIMING_OFFSETS[i]} * 1000" | bc | cut -d. -f1)
    inputs+=(-i "$mp3")
    filters+=("[${idx}]adelay=${offset_ms}|${offset_ms}[a${idx}]")
    labels+=("[a${idx}]")
    idx=$((idx + 1))
  done

  local n_inputs=${#labels[@]}
  if [[ $n_inputs -eq 0 ]]; then
    echo "Error: no valid audio files found" >&2
    exit 1
  fi

  local filter_complex
  filter_complex="$(IFS=';'; echo "${filters[*]}"); "
  filter_complex+="$(IFS=''; echo "${labels[*]}")"
  filter_complex+="amix=inputs=${n_inputs}:duration=longest:dropout_transition=0:normalize=0[aout]"

  echo "Merging ${n_inputs} audio clips onto $(basename "$video")..."
  ffmpeg -y -loglevel error \
    -i "$video" "${inputs[@]}" \
    -filter_complex "$filter_complex" \
    -map 0:v -map "[aout]" \
    -c:v copy -c:a aac -b:a 192k -shortest \
    "$output"

  local dur
  dur=$(ffprobe -v error -show_entries format=duration \
    -of csv=p=0 "$output" 2>/dev/null | cut -d. -f1)
  echo "Output: $output (${dur}s)"
}

cmd_fade_intro() {
  local video="${1:?Usage: demo-narrate fade-intro <video> [fade_seconds] [output]}"
  local fade="${2:-0.5}"
  local output="${3:-${video%.*}_intro.mp4}"

  ensure_ffmpeg

  if [[ ! -f "$video" ]]; then
    echo "Error: file not found: $video" >&2
    exit 1
  fi

  local dur fps_str
  dur=$(get_duration "$video")
  fps_str=$(get_fps "$video")

  echo "Adding ${fade}s fade-in from black (freeze frame)..."
  echo "  Source: $(basename "$video") (${dur}s, ${fps_str} fps)"

  # Extract first frame (cleaned up on exit or error)
  local tmp_frame
  tmp_frame="$(mktemp /tmp/fade_frame_XXXXXX.jpg)"
  trap 'rm -f "$tmp_frame" 2>/dev/null' EXIT

  ffmpeg -y -loglevel error -i "$video" \
    -vf "select=eq(n\,0)" -vsync vfr -q:v 2 -frames:v 1 \
    "$tmp_frame"

  # Build the output in one pass:
  # - Input 0: frozen first frame looped for ${fade}s with fade-from-black
  # - Input 1: original video
  # - Use source video's fps for the intro to match
  ffmpeg -y -loglevel error \
    -loop 1 -t "$fade" -i "$tmp_frame" \
    -i "$video" \
    -filter_complex "\
      [0:v]fps=${fps_str},format=yuv420p,fade=t=in:st=0:d=${fade}[intro]; \
      [1:v]setpts=PTS-STARTPTS[main]; \
      [intro][main]concat=n=2:v=1:a=0[vout]" \
    -map "[vout]" \
    -c:v libx264 -preset fast -crf 18 \
    -movflags +faststart \
    "$output"

  local new_dur
  new_dur=$(get_duration "$output")
  echo "Output: $output (${new_dur}s = ${fade}s intro + ${dur}s video)"
  echo "  Note: video re-encoded (libx264 crf=18) for seamless concat"
  echo ""
  echo "Remember: shift all timing offsets by +${fade}s in your timing.txt"
}

cmd_voices() {
  ensure_edge_tts
  echo "Popular English voices for demo narration:"
  echo ""
  edge-tts --list-voices 2>/dev/null | grep -E "en-(US|GB)" | head -20
  echo ""
  echo "All voices: edge-tts --list-voices"
}

case "${1:-}" in
  extract)      shift; cmd_extract "$@" ;;
  tts)          shift; cmd_tts "$@" ;;
  tts-acts)     shift; cmd_tts_acts "$@" ;;
  merge)        shift; cmd_merge "$@" ;;
  merge-acts)   shift; cmd_merge_acts "$@" ;;
  fade-intro)   shift; cmd_fade_intro "$@" ;;
  voices)       cmd_voices ;;
  deps)         cmd_deps ;;
  -h|--help|help) usage ;;
  *) usage ;;
esac
