---
name: gemini-icon-set
description: >
  Generate production-quality colorful icon sets using Google Imagen 4.
  Use this skill when the user needs custom app icons, emoji-style icons,
  cartoon icons, or any colorful icon set. Takes a project description,
  suggests icons, generates 1024px PNGs via Imagen 4, removes backgrounds,
  downscales to all target sizes, and delivers a review gallery for
  iterative refinement. Trigger on: "icon set", "generate icons",
  "app icons", "custom icons", "colorful icons", "cartoon icons",
  "emoji icons", "make icons", "icon generation", "imagen icons",
  or any request for a set of colorful visual assets.
---

# Gemini Icon Set

Generate production-quality colorful icon sets using Google Imagen 4.
Claude handles the creative work (suggesting icons, crafting prompts,
reviewing). The bundled shell script handles the mechanical work (API
calls, image processing, gallery).

## Pipeline Overview

```
Project description
  0. Check dependencies (rembg, sips — auto-installed if missing)
  1. Understand the project — gather context, aesthetic preferences
  2. Suggest 12-20 icons organized by category
  3. User confirms/adjusts icon list, choose style preset
  4. Generate 1024px PNGs via Imagen 4, remove backgrounds, downscale
  5. Open gallery — user marks: keep / retry / drop / add new
  6. Regenerate retries + new icons, rebuild gallery
  7. Repeat 5-6 until satisfied
  8. Deliver final set with manifest
```

Everything runs within Claude Code. The only external dependencies are
a `GEMINI_API_KEY` and `rembg` (auto-installed if missing).

## Shell Script

All Imagen 4 API calls, background removal, downscaling, and gallery
generation go through the helper script bundled with this skill at
`scripts/gemini-icon-set.sh`.

**Locating the script:** Use `${CLAUDE_SKILL_DIR}` to resolve the
path relative to this SKILL.md:

```bash
ICON_SH="${CLAUDE_SKILL_DIR}/scripts/gemini-icon-set.sh"
```

If `CLAUDE_SKILL_DIR` is not set (older Claude Code or standalone
install), fall back to a search:

```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  ICON_SH="${CLAUDE_SKILL_DIR}/scripts/gemini-icon-set.sh"
else
  ICON_SH="$(command -v gemini-icon-set.sh 2>/dev/null || \
    find ~/.claude -path "*/gemini-icon-set/scripts/gemini-icon-set.sh" -type f 2>/dev/null | head -1)"
fi
if [[ -z "$ICON_SH" || ! -f "$ICON_SH" ]]; then
  echo "Error: gemini-icon-set.sh not found. Ask the user for the path." >&2
fi
```

Store the result in `ICON_SH` and use it for all subsequent commands.

Commands:
- `check-deps` -- check and install dependencies (rembg, sips/ImageMagick)
- `generate <manifest.json>` -- generate 1024px PNGs from manifest
- `process <output-dir>` -- remove backgrounds + downscale to all sizes
- `gallery <output-dir> [title]` -- build self-contained HTML review gallery

## Execution

### Step 0: Check Dependencies

Locate the script (see "Shell Script" above) and check dependencies:

```bash
ICON_SH="${CLAUDE_SKILL_DIR}/scripts/gemini-icon-set.sh"
"$ICON_SH" check-deps
```

The script auto-installs rembg via `uv tool install "rembg[cpu,cli]"`
if missing. It also checks for `sips` (macOS) or `convert`
(ImageMagick), `curl`, `python3`, and `base64`.

If `uv` is missing, tell the user: `brew install uv`.

### Step 1: Understand the Project

Ask the user about their project. One question at a time, don't
over-interview. Gather:

- What's the project/app? (industry, name, vibe)
- What aesthetic? (cute, professional, playful, minimal)
- Roughly how many icons? (typical: 12-20)
- Output directory? (default: `./icons`)

A brief like "ice cream shop app, fun and colorful" is enough to
proceed. Don't block on getting perfect answers.

### Step 2: Suggest Icons

Based on the project description, organize suggestions into categories:

- **Navigation** -- home, back, menu, search, settings
- **Actions** -- add, edit, delete, share, download
- **Status** -- success, error, warning, loading, favorite
- **Domain-specific** -- icons unique to the user's project

Present the list as a table with icon name, category, and a short
description. Let the user add, remove, or rename before generating.

### Step 3: Choose Style

Present the 5 presets as a table:

| Preset | Description | Best For |
|--------|-------------|----------|
| kawaii | Cute cartoon with bold brown outline, soft pastels | Fun apps, kids, food |
| flat | Clean vector, minimal shadows, bold colors | Business, productivity |
| glossy | Rounded 3D, saturated colors, soft reflections | Games, premium apps |
| sketch | Hand-drawn pencil lines, warm organic feel | Creative, artsy apps |
| pixel | Retro 8-bit, crisp edges, limited palette | Games, retro themes |

All presets append: `centered on pure white background, single object, no text, no words, no letters, app icon style`

The user can also provide a fully custom style prompt. If they do,
append the same white-background suffix for consistency.

### Step 4: Generate

#### 4a. Write the manifest

Write `manifest.json` to the output directory:

```json
{
  "style": "<selected preset prompt or custom>",
  "output": "<output directory>",
  "icons": {
    "icon-name": "description of this specific icon",
    "another-icon": "description of another icon"
  }
}
```

Icon names should be lowercase kebab-case (e.g., `ice-cream-cone`,
`shopping-cart`). These become the PNG filenames.

#### 4b. Run the pipeline

```bash
"$ICON_SH" generate manifest.json
"$ICON_SH" process <output-dir>
"$ICON_SH" gallery <output-dir> "<project name> Icons"
```

The `generate` command:
- Constructs each prompt as: `{style prefix}, {icon description}`
- Calls the Imagen 4 API with retries (3 attempts, exponential backoff)
- Skips icons whose PNGs already exist in `originals/`
- Outputs 1024x1024 PNGs to `{output_dir}/originals/`

The `process` command:
- Runs `rembg` on each PNG in `originals/` to `nobg/`
- Downscales to: 16, 24, 32, 48, 64, 96, 128, 256px
- Uses `sips -z` (macOS) or `convert -filter Lanczos -resize`
- Organizes by size: `{output_dir}/{size}/{name}.png`

The `gallery` command:
- Builds self-contained HTML with all PNGs base64-inlined
- Sections: all icons at 96px, scaling test (16-256px), dark background
- No external dependencies, works on `file://`

#### 4c. Open the gallery

Open the gallery HTML for the user to review:

```bash
open "<output-dir>/gallery.html"
```

### Step 5: Review

Ask the user to review the gallery. For each icon, they can mark:

- **keep** -- icon is good as-is
- **retry** -- regenerate this icon (style or description needs adjustment)
- **drop** -- remove from the set entirely
- **add** -- new icon to include in the set

### Step 6: Iterate

For **retries**: delete the specific PNGs from `originals/`, `nobg/`,
and all size directories, then re-run generate + process + gallery.
The script skips existing files, so only deleted (missing) ones are
regenerated.

```bash
rm -f "<output-dir>/originals/<name>.png"
rm -f "<output-dir>/nobg/<name>.png"
for size in 16 24 32 48 64 96 128 256; do
  rm -f "<output-dir>/$size/<name>.png"
done
```

For **new icons**: add them to `manifest.json` and re-run the full
pipeline. Existing icons are skipped automatically.

For **drops**: remove the icon from `manifest.json` and delete its
PNGs from all directories.

Re-run generate + process + gallery after changes, then open the
gallery again. Repeat Steps 5-6 until the user is satisfied.

### Step 7: Deliver

Present a final summary:

- Total icon count and style used
- Output directory path
- Gallery HTML path (for sharing or archiving)
- Manifest path (for reproducibility)
- Size directory listing with file counts

```
Final Set: 16 icons, kawaii style
Output:    ./icons/
Gallery:   ./icons/gallery.html
Manifest:  ./icons/manifest.json
Sizes:     16px, 24px, 32px, 48px, 64px, 96px, 128px, 256px (16 files each)
```

See [the styles reference](references/STYLES.md) for style preset prompts, manifest format, and output directory structure.

## Important Notes

- **GEMINI_API_KEY** must be set in the environment or in a `.env`
  file in the current directory. The script reads it automatically.
- **API rate:** Imagen 4 takes ~3-5 seconds per image with a ~20%
  timeout rate. The script retries up to 3 times with exponential
  backoff (3s, 9s, 27s).
- **Skip existing:** The `generate` command skips icons whose PNGs
  already exist in `originals/`. Delete a PNG to force regeneration.
- **Background removal:** `rembg` produces clean cutouts for cartoon
  styles. Results may vary for photorealistic styles.
- **Downscaling:** Lanczos resampling preserves quality down to 16px
  for simple icon shapes. Complex details may blur at small sizes.
- **Gallery inlining:** PNGs are base64-encoded directly into the
  HTML so the gallery works anywhere without a server.
- **No SVG:** This skill generates raster PNGs. For SVG icon
  generation, use the `gemini-svg-creator` or `icon-set-generator`
  skills instead.

## Standalone Installation

This skill can also be used without the full plugin:

1. Copy `SKILL.md` to `~/.claude/commands/gemini-icon-set.md`
2. Copy `scripts/gemini-icon-set.sh` to `~/.local/bin/gemini-icon-set.sh`
   and `chmod +x` it (must be on your PATH)
3. The fallback in the "Shell Script" section will find it via
   `command -v gemini-icon-set.sh` -- no path edits needed
