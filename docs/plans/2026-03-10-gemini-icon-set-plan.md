# gemini-icon-set Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a Claude Code skill that generates colorful icon sets using Google's Imagen 4 model, with background removal, multi-size scaling, and an iterative review gallery.

**Architecture:** Two files — `SKILL.md` (Claude's orchestration prompt) and `scripts/gemini-icon-set.sh` (shell script handling API calls, image processing, and gallery generation). Follows the `demo-narrate` pattern: Claude does the creative work, the script does the mechanical work.

**Tech Stack:** Bash, curl, python3 (base64 decode + gallery HTML), rembg (bg removal), sips/ImageMagick (scaling)

---

## File Structure

| File | Purpose |
|------|---------|
| Create: `skills/gemini-icon-set/SKILL.md` | Workflow prompt — project understanding, icon suggestions, style selection, review loop |
| Create: `scripts/gemini-icon-set.sh` | Shell script — check-deps, generate, process, gallery subcommands |
| Modify: `.claude/CLAUDE.md` | Add skill to Available Skills table |
| Modify: `.claude-plugin/plugin.json` | Add skill to plugin description and keywords |
| Modify: `README.md` | Add skill documentation section |

---

## Chunk 1: Shell Script

### Task 1: Script skeleton with check-deps and usage

**Files:**
- Create: `scripts/gemini-icon-set.sh`

- [ ] **Step 1: Create the script with shebang, usage, and check-deps**

```bash
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
      val=$(grep -E '^GEMINI_API_KEY=' "$env_file" 2>/dev/null | head -1 | cut -d= -f2-)
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
```

- [ ] **Step 2: Add the subcommand dispatcher at the bottom**

```bash
# --- Main dispatcher ---
case "${1:-}" in
  check-deps) shift; cmd_check_deps "$@" ;;
  generate)   shift; cmd_generate "$@" ;;
  process)    shift; cmd_process "$@" ;;
  gallery)    shift; cmd_gallery "$@" ;;
  -h|--help|"") usage ;;
  *) echo "Unknown command: $1" >&2; usage >&2; exit 1 ;;
esac
```

- [ ] **Step 3: Make executable and test check-deps**

Run: `chmod +x scripts/gemini-icon-set.sh && scripts/gemini-icon-set.sh check-deps`
Expected: all dependencies listed as OK (rembg installed in previous session)

- [ ] **Step 4: Commit**

```bash
git add scripts/gemini-icon-set.sh
git commit -m "feat(gemini-icon-set): add script skeleton with check-deps"
```

### Task 2: generate subcommand

**Files:**
- Modify: `scripts/gemini-icon-set.sh`

- [ ] **Step 1: Add cmd_generate function**

```bash
# --- generate ---
cmd_generate() {
  local manifest="${1:?Usage: gemini-icon-set generate <manifest.json>}"
  [[ -f "$manifest" ]] || { echo "Error: manifest not found: $manifest" >&2; exit 1; }

  resolve_api_key

  local style output_dir
  style=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['style'])" "$manifest")
  output_dir=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('output','./icons'))" "$manifest")
  mkdir -p "$output_dir/originals"

  local total count=0 failed=0
  total=$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))['icons']))" "$manifest")

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
  [[ $failed -gt 0 ]] && echo "Warning: $failed icon(s) failed. Re-run to retry (existing files are skipped)."
  return 0
}
```

- [ ] **Step 2: Test with a minimal manifest**

Create `/tmp/test-manifest.json`:
```json
{"style": "cute kawaii cartoon icon, flat vector illustration, bold dark brown outline, centered on pure white background, single object, no text, app icon style", "output": "/tmp/test-icons", "icons": {"test-cone": "ice cream cone with two scoops"}}
```

Run: `scripts/gemini-icon-set.sh generate /tmp/test-manifest.json`
Expected: `[1/1] test-cone ... OK`, file at `/tmp/test-icons/originals/test-cone.png`

- [ ] **Step 3: Verify skip behavior**

Run same command again.
Expected: `[1/1] test-cone — exists, skipping`

- [ ] **Step 4: Commit**

```bash
git add scripts/gemini-icon-set.sh
git commit -m "feat(gemini-icon-set): add generate subcommand with retries"
```

### Task 3: process subcommand

**Files:**
- Modify: `scripts/gemini-icon-set.sh`

- [ ] **Step 1: Add cmd_process function**

```bash
# --- process ---
cmd_process() {
  local dir="${1:?Usage: gemini-icon-set process <output-dir>}"
  local originals="$dir/originals"
  [[ -d "$originals" ]] || { echo "Error: no originals/ directory in $dir" >&2; exit 1; }

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
```

- [ ] **Step 2: Test on the test icon**

Run: `scripts/gemini-icon-set.sh process /tmp/test-icons`
Expected: nobg/ created, size directories (16-256) each contain test-cone.png

- [ ] **Step 3: Commit**

```bash
git add scripts/gemini-icon-set.sh
git commit -m "feat(gemini-icon-set): add process subcommand (rembg + scaling)"
```

### Task 4: gallery subcommand

**Files:**
- Modify: `scripts/gemini-icon-set.sh`

- [ ] **Step 1: Add cmd_gallery function**

```bash
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
        review_cards += f'<div class="card"><img src="data:image/png;base64,{b64}" width="{review_size}" height="{review_size}"><span class="label">{label}</span><span class="file">{name}</span></div>\n'

# Build scaling rows
scaling_html = ""
for name in icon_names[:6]:
    cells = ""
    for s in sizes:
        b64 = load_b64(os.path.join(out_dir, str(s), f"{name}.png"))
        if b64:
            cells += f'<td><img src="data:image/png;base64,{b64}" width="{s}" height="{s}"><br><span class="sz">{s}</span></td>'
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
        dark_cards += f'<div class="card dark"><img src="data:image/png;base64,{b64}" width="{review_size}" height="{review_size}"><span class="label">{label}</span></div>\n'

html = f'''<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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
```

- [ ] **Step 2: Test gallery on test output**

Run: `scripts/gemini-icon-set.sh gallery /tmp/test-icons "Test Icons" && open /tmp/test-icons/gallery.html`
Expected: HTML gallery opens with the test cone icon at all sizes

- [ ] **Step 3: Commit**

```bash
git add scripts/gemini-icon-set.sh
git commit -m "feat(gemini-icon-set): add gallery subcommand (inlined HTML)"
```

---

## Chunk 2: SKILL.md

### Task 5: Create the skill prompt

**Files:**
- Create: `skills/gemini-icon-set/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

The skill follows the same structure as `demo-narrate`: frontmatter, overview, shell script location, and step-by-step workflow. Content is fully specified in the design spec — implement all 9 workflow steps, 5 style presets, manifest format, and the review loop.

Key sections:
- Frontmatter (name, description with trigger words)
- Overview and pipeline diagram
- Shell Script location (CLAUDE_SKILL_DIR pattern from demo-narrate)
- Step 0: Check Dependencies
- Step 1: Understand the Project (ask context, aesthetic)
- Step 2: Suggest Icons (categorized, 12-20 icons)
- Step 3: Choose Style (5 presets table + custom option)
- Step 4: Generate (write manifest.json, run generate + process + gallery)
- Step 5: Review (open gallery, collect keep/retry/drop/add)
- Step 6: Iterate (update manifest, regenerate failures, rebuild gallery)
- Step 7: Deliver (final gallery, manifest, summary)
- Manifest format reference
- Style presets reference (all 5 with full prompt text)
- Output structure reference

- [ ] **Step 2: Test that the skill file is discoverable**

Run: `ls skills/gemini-icon-set/SKILL.md`
Expected: file exists

- [ ] **Step 3: Commit**

```bash
git add skills/gemini-icon-set/SKILL.md
git commit -m "feat(gemini-icon-set): add skill prompt (SKILL.md)"
```

---

## Chunk 3: Plugin Metadata & Docs

### Task 6: Update plugin manifests and docs

**Files:**
- Modify: `.claude/CLAUDE.md`
- Modify: `.claude-plugin/plugin.json`
- Modify: `README.md`

- [ ] **Step 1: Add to CLAUDE.md skills table**

Add row: `| gemini-icon-set | Generate colorful icon sets using Google Imagen 4 |`

- [ ] **Step 2: Update plugin.json**

Add `gemini-icon-set` to description and keywords.

- [ ] **Step 3: Update README.md**

Add `### gemini-icon-set` section with description, dependencies, and link to SKILL.md.

- [ ] **Step 4: Commit**

```bash
git add .claude/CLAUDE.md .claude-plugin/plugin.json README.md
git commit -m "docs: add gemini-icon-set to plugin manifests and README"
```

---

## Chunk 4: End-to-End Test

### Task 7: Manual integration test

- [ ] **Step 1: Run the full pipeline on a small test set**

Create a 3-icon manifest and run:
```bash
scripts/gemini-icon-set.sh check-deps
scripts/gemini-icon-set.sh generate /tmp/e2e-manifest.json
scripts/gemini-icon-set.sh process /tmp/e2e-icons
scripts/gemini-icon-set.sh gallery /tmp/e2e-icons "E2E Test"
open /tmp/e2e-icons/gallery.html
```

Verify: originals (1024px), nobg, all 8 size directories, gallery HTML renders correctly in browser.

- [ ] **Step 2: Test retry behavior**

Delete one original PNG, re-run generate. Verify it regenerates only the missing icon.

- [ ] **Step 3: Test on Linux/non-macOS path**

Verify the ImageMagick fallback path in `cmd_process` by checking the conditional logic. (Full Linux testing is out of scope for now.)
