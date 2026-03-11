#!/usr/bin/env bash
set -euo pipefail

# gemini-icon-set: Generate colorful icon sets using Google Imagen 4.
#
# Subcommands:
#   check-deps              Check and install dependencies
#   generate <manifest>     Generate PNGs from a JSON manifest
#   process <dir>           Remove backgrounds + downscale to target sizes
#   gallery <dir> [title]   Build inlined HTML review gallery
#
# Dependencies: curl, python3, rembg (auto-installed), sips or ImageMagick

SIZES=(16 24 32 48 64 96 128 256)
MAX_RETRIES=3
API_MODEL="imagen-4.0-generate-001"
API_BASE="https://generativelanguage.googleapis.com/v1beta/models"

usage() {
  cat <<'EOF'
Usage: gemini-icon-set <command> [options]

Commands:
  check-deps                    Check and install dependencies (rembg)
  generate <manifest.json>      Generate 1024px PNGs from icon manifest
  process <output-dir>          Remove backgrounds + downscale all PNGs
  gallery <output-dir> [title]  Build HTML review gallery

Manifest format (JSON):
  {
    "style": "prompt prefix for all icons",
    "output": "./icons",
    "icons": {
      "icon-name": "description of this specific icon",
      ...
    }
  }

Environment:
  GEMINI_API_KEY    Required. Set in .env or export directly.

Sizes generated: 16 24 32 48 64 96 128 256 px
EOF
}

# --- Resolve API key ---
resolve_api_key() {
  if [[ -n "${GEMINI_API_KEY:-}" ]]; then
    return
  fi
  local env_file
  for env_file in ".env" "../.env" "../../.env"; do
    if [[ -f "$env_file" ]]; then
      local val
      val=$(grep -E '^GEMINI_API_KEY=' "$env_file" 2>/dev/null \
        | head -1 | cut -d= -f2-)
      if [[ -n "$val" ]]; then
        export GEMINI_API_KEY="$val"
        return
      fi
    fi
  done
  echo "Error: GEMINI_API_KEY not found in environment or .env" >&2
  exit 1
}

# --- check-deps ---
cmd_check_deps() {
  local ok=true

  printf "curl:        "
  command -v curl >/dev/null && echo "OK" || { echo "MISSING"; ok=false; }

  printf "python3:     "
  command -v python3 >/dev/null && echo "OK" || { echo "MISSING"; ok=false; }

  printf "rembg:       "
  if command -v rembg >/dev/null; then
    echo "OK"
  else
    echo "MISSING — installing via uv tool..."
    if command -v uv >/dev/null; then
      uv tool install "rembg[cpu,cli]" 2>&1 | tail -1
    elif command -v pipx >/dev/null; then
      pipx install "rembg[cpu,cli]" 2>&1 | tail -1
    else
      echo "Error: neither uv nor pipx found. Install with: brew install uv" >&2
      ok=false
    fi
  fi

  printf "image scaler: "
  if command -v sips >/dev/null; then
    echo "OK (sips — macOS)"
  elif command -v convert >/dev/null; then
    echo "OK (ImageMagick)"
  else
    echo "MISSING — install ImageMagick: brew install imagemagick"
    ok=false
  fi

  if $ok; then
    echo "All dependencies OK."
  else
    echo "Some dependencies missing. See above." >&2
    exit 1
  fi
}

# --- generate ---
cmd_generate() {
  local manifest="${1:?Usage: gemini-icon-set generate <manifest.json>}"
  [[ -f "$manifest" ]] || {
    echo "Error: manifest not found: $manifest" >&2
    exit 1
  }

  resolve_api_key

  local style output_dir
  style=$(python3 -c \
    "import json,sys; print(json.load(open(sys.argv[1]))['style'])" \
    "$manifest")
  output_dir=$(python3 -c \
    "import json,sys; print(json.load(open(sys.argv[1])).get('output','./icons'))" \
    "$manifest")
  mkdir -p "$output_dir/originals"

  local total count=0 failed=0
  total=$(python3 -c \
    "import json,sys; print(len(json.load(open(sys.argv[1]))['icons']))" \
    "$manifest")

  python3 -c "
import json, sys
m = json.load(open(sys.argv[1]))
for name, desc in sorted(m['icons'].items()):
    print(f'{name}\t{desc}')
" "$manifest" | while IFS=$'\t' read -r name desc; do
    count=$((count + 1))
    local prompt="$style, $desc"
    local outfile="$output_dir/originals/$name.png"

    if [[ -f "$outfile" ]]; then
      echo "[$count/$total] $name — exists, skipping"
      continue
    fi

    echo -n "[$count/$total] $name ... "
    local attempt ok=false
    for attempt in $(seq 1 $MAX_RETRIES); do
      local backoff=$(( 3 ** attempt ))
      local resp
      resp=$(curl -s --max-time 90 \
        "${API_BASE}/${API_MODEL}:predict?key=${GEMINI_API_KEY}" \
        -H 'Content-Type: application/json' \
        -d "$(python3 -c "
import json, sys
print(json.dumps({
    'instances': [{'prompt': sys.stdin.read().strip()}],
    'parameters': {
        'sampleCount': 1,
        'aspectRatio': '1:1',
        'personGeneration': 'dont_allow'
    }
}))" <<< "$prompt")")

      if python3 -c "
import sys, json, base64
r = json.load(sys.stdin)
img = r['predictions'][0]['bytesBase64Encoded']
with open('$outfile', 'wb') as f:
    f.write(base64.b64decode(img))
" <<< "$resp" 2>/dev/null; then
        ok=true
        break
      fi

      if [[ $attempt -lt $MAX_RETRIES ]]; then
        echo -n "retry($attempt)... "
        sleep "$backoff"
      fi
    done

    if $ok; then
      echo "OK"
    else
      echo "FAILED after $MAX_RETRIES attempts"
      failed=$((failed + 1))
    fi
  done

  echo ""
  echo "Generated in: $output_dir/originals/"
  [[ $failed -gt 0 ]] && \
    echo "Warning: $failed icon(s) failed. Re-run to retry (existing files are skipped)."
  return 0
}

# --- process ---
cmd_process() {
  local dir="${1:?Usage: gemini-icon-set process <output-dir>}"
  local originals="$dir/originals"
  [[ -d "$originals" ]] || {
    echo "Error: no originals/ directory in $dir" >&2
    exit 1
  }

  local nobg_dir="$dir/nobg"
  mkdir -p "$nobg_dir"

  echo "=== Phase 1: Background removal ==="
  for f in "$originals"/*.png; do
    [[ -f "$f" ]] || continue
    local name
    name=$(basename "$f")
    if [[ -f "$nobg_dir/$name" ]]; then
      echo "  $name — exists, skipping"
      continue
    fi
    echo -n "  $name ... "
    if rembg i "$f" "$nobg_dir/$name" 2>/dev/null; then
      echo "OK"
    else
      echo "FAILED"
    fi
  done

  echo ""
  echo "=== Phase 2: Downscale to target sizes ==="
  local scale_cmd
  if command -v sips >/dev/null; then
    scale_cmd="sips"
  elif command -v convert >/dev/null; then
    scale_cmd="magick"
  else
    echo "Error: no image scaler found (sips or ImageMagick)" >&2
    exit 1
  fi

  for size in "${SIZES[@]}"; do
    local size_dir="$dir/$size"
    mkdir -p "$size_dir"
  done

  for f in "$nobg_dir"/*.png; do
    [[ -f "$f" ]] || continue
    local name
    name=$(basename "$f" .png)
    echo -n "  $name: "
    for size in "${SIZES[@]}"; do
      local out="$dir/$size/$name.png"
      if [[ -f "$out" ]]; then
        echo -n "${size}skip "
        continue
      fi
      if [[ "$scale_cmd" == "sips" ]]; then
        sips -z "$size" "$size" "$f" --out "$out" >/dev/null 2>&1
      else
        convert "$f" -filter Lanczos -resize "${size}x${size}" "$out"
      fi
      echo -n "${size} "
    done
    echo ""
  done

  echo ""
  echo "Done! Sizes: ${SIZES[*]}"
}

# --- gallery ---
cmd_gallery() {
  local dir="${1:?Usage: gemini-icon-set gallery <output-dir> [title]}"
  local title="${2:-Icon Set}"

  python3 - "$dir" "$title" << 'PYEOF'
import os, sys, base64, glob, json
from datetime import date

out_dir = sys.argv[1]
title = sys.argv[2]
sizes = [16, 24, 32, 48, 64, 96, 128, 256]
review_size = 96

# Find icons from the 96/ directory (or largest available)
src_dir = None
for s in [96, 128, 256, 64, 48, 32]:
    d = os.path.join(out_dir, str(s))
    if os.path.isdir(d) and glob.glob(os.path.join(d, "*.png")):
        src_dir = d
        break
if not src_dir:
    orig = os.path.join(out_dir, "originals")
    if os.path.isdir(orig):
        src_dir = orig
    else:
        print("Error: no PNG directories found", file=sys.stderr)
        sys.exit(1)

icon_names = sorted(
    os.path.splitext(f)[0]
    for f in os.listdir(src_dir)
    if f.endswith(".png")
)

def load_b64(path):
    if os.path.exists(path):
        with open(path, "rb") as f:
            return base64.b64encode(f.read()).decode()
    return None

# Load manifest metadata if available
style_info = ""
manifest = os.path.join(out_dir, "manifest.json")
if os.path.exists(manifest):
    with open(manifest) as f:
        m = json.load(f)
    style_info = m.get("style", "")[:80]

# Build review cards (96px)
review_cards = ""
for name in icon_names:
    b64 = load_b64(os.path.join(out_dir, str(review_size), f"{name}.png"))
    if not b64:
        b64 = load_b64(os.path.join(src_dir, f"{name}.png"))
    if b64:
        label = name.replace("-", " ").title()
        review_cards += (
            f'<div class="card">'
            f'<img src="data:image/png;base64,{b64}" '
            f'width="{review_size}" height="{review_size}">'
            f'<span class="label">{label}</span>'
            f'<span class="file">{name}</span></div>\n'
        )

# Build scaling rows (first 6 icons at all sizes)
scaling_html = ""
for name in icon_names[:6]:
    cells = ""
    for s in sizes:
        b64 = load_b64(os.path.join(out_dir, str(s), f"{name}.png"))
        if b64:
            cells += (
                f'<td><img src="data:image/png;base64,{b64}" '
                f'width="{s}" height="{s}"><br>'
                f'<span class="sz">{s}</span></td>'
            )
    if cells:
        label = name.replace("-", " ").title()
        scaling_html += f'<tr><th class="rn">{label}</th>{cells}</tr>\n'

# Build dark section cards
dark_cards = ""
for name in icon_names:
    b64 = load_b64(os.path.join(out_dir, str(review_size), f"{name}.png"))
    if not b64:
        b64 = load_b64(os.path.join(src_dir, f"{name}.png"))
    if b64:
        label = name.replace("-", " ").title()
        dark_cards += (
            f'<div class="card dark">'
            f'<img src="data:image/png;base64,{b64}" '
            f'width="{review_size}" height="{review_size}">'
            f'<span class="label">{label}</span></div>\n'
        )

html = f'''<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{font-family:-apple-system,system-ui,sans-serif;padding:2rem;max-width:1200px;margin:0 auto;background:#faf8f5;color:#1a1a1a}}
h1{{font-size:1.5rem;font-weight:600;margin-bottom:.25rem}}
.sub{{color:#666;font-size:.9rem;margin-bottom:2rem}}
.meta{{background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:1rem;margin-bottom:2rem;font-size:.85rem;color:#444;display:flex;flex-wrap:wrap;gap:.5rem 1.5rem}}
.meta strong{{color:#1a1a1a}}
h2{{font-size:1.1rem;font-weight:600;margin:2rem 0 .75rem;padding-bottom:.5rem;border-bottom:1px solid #e5e5e5}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px}}
.card{{display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px 8px;border-radius:10px;background:#fff;border:1px solid #e5e5e5;transition:all .15s}}
.card:hover{{border-color:#999;transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,.08)}}
.card img{{border-radius:4px}}
.card .label{{font-size:.75rem;font-weight:600;color:#333;text-align:center}}
.card .file{{font-size:.6rem;color:#aaa;font-family:monospace}}
.card.dark{{background:#2a2a2a;border-color:#333}}
.card.dark .label{{color:#ddd}}
table{{border-collapse:collapse;width:100%;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06);margin-top:.75rem}}
th,td{{padding:12px 8px;text-align:center;vertical-align:bottom;border-bottom:1px solid #eee}}
th.rn{{text-align:left;font-size:.8rem;white-space:nowrap;min-width:110px}}
thead th{{background:#333;color:#fff;font-size:.75rem}}
.sz{{font-size:.6rem;color:#999}}
.dark-section{{background:#1a1a1a;border-radius:12px;padding:2rem;margin-top:2rem}}
.dark-section h2{{color:#fff;border-bottom-color:#333}}
.info{{text-align:center;margin-top:2rem;padding:1rem;background:#fff;border-radius:8px;font-size:.85rem;color:#666}}
</style></head><body>
<h1>{title}</h1>
<p class="sub">{len(icon_names)} icons &middot; Imagen 4.0 &middot; {date.today()}</p>
<div class="meta">
<span><strong>Model:</strong> Imagen 4.0</span>
<span><strong>Pipeline:</strong> generate &rarr; rembg &rarr; Lanczos downscale</span>
<span><strong>Sizes:</strong> {", ".join(str(s) for s in sizes)}px</span>
</div>
<h2>All Icons ({review_size}px)</h2>
<div class="grid">{review_cards}</div>
<h2>Size Scaling (16&ndash;256px)</h2>
<table><thead><tr><th>Icon</th>{"".join(f"<th>{s}px</th>" for s in sizes)}</tr></thead>
<tbody>{scaling_html}</tbody></table>
<div class="dark-section">
<h2>Dark Background</h2>
<div class="grid">{dark_cards}</div>
</div>
<div class="info">
Generated with <strong>gemini-icon-set</strong> skill &middot;
<a href="https://github.com/catalan-adobe/skills">catalan-adobe/skills</a>
</div>
</body></html>'''

gallery_path = os.path.join(out_dir, "gallery.html")
with open(gallery_path, "w") as f:
    f.write(html)
print(f"Gallery: {gallery_path} ({len(icon_names)} icons)")
PYEOF
}

# --- Main dispatcher ---
case "${1:-}" in
  check-deps) shift; cmd_check_deps "$@" ;;
  generate)   shift; cmd_generate "$@" ;;
  process)    shift; cmd_process "$@" ;;
  gallery)    shift; cmd_gallery "$@" ;;
  -h|--help|"") usage ;;
  *) echo "Unknown command: $1" >&2; usage >&2; exit 1 ;;
esac
