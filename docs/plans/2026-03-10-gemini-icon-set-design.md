# Design: gemini-icon-set Skill

**Date:** 2026-03-10
**Status:** Approved

## Purpose

Generate production-quality colorful icon sets using Google's Imagen 4
model. Takes a project description, suggests icons, generates 1024px PNGs,
removes backgrounds, downscales to target sizes, and delivers a review
gallery for iterative refinement.

## Architecture

Two files:

```
skills/gemini-icon-set/SKILL.md              — Workflow (prompt-only)
scripts/gemini-icon-set.sh                   — API calls, image processing, gallery
```

Claude handles creative work (suggesting icons, crafting prompts, reviewing).
The script handles mechanical work (API, rembg, scaling, HTML gallery).

## Workflow

```
1. Understand project — gather context, aesthetic preferences
2. Suggest 12-20 icons organized by category
3. User confirms/adjusts icon list
4. Define style prompt (shared prefix for consistency)
5. Script generates all icons → rembg → downscale → build gallery
6. Open gallery — user marks: keep / retry / drop / add new
7. Script regenerates retries + new icons → rebuild gallery
8. Repeat 6-7 until satisfied
9. Deliver final set with manifest
```

## Script Design

Single script with subcommands:

| Command | Input | Output |
|---------|-------|--------|
| `check-deps` | — | Installs rembg if missing, checks sips/ImageMagick |
| `generate` | JSON manifest file | 1024px PNGs in `originals/` |
| `process` | Directory of PNGs | Background-removed + scaled PNGs by size |
| `gallery` | Directory of PNGs | Inlined HTML gallery |

### generate subcommand

- Reads a JSON manifest: `{"style": "...", "icons": {"name": "description", ...}}`
- Calls `imagen-4.0-generate-001:predict` endpoint
- Constructs prompt: `{style prefix}, {icon description}`
- Retries up to 3 times with exponential backoff (3s, 9s, 27s)
- Reads `GEMINI_API_KEY` from `.env` in current directory or `$GEMINI_API_KEY`
- Outputs one PNG per icon to `{output_dir}/originals/{name}.png`

### process subcommand

- Runs `rembg i` on each PNG in `originals/` → saves to `nobg/`
- Downscales each nobg PNG to: 16, 24, 32, 48, 64, 96, 128, 256px
- Uses `sips -z` (macOS) or `convert -filter Lanczos -resize` (ImageMagick)
- Organizes by size: `{output_dir}/{size}/{name}.png`

### gallery subcommand

- Builds self-contained HTML with all PNGs base64-inlined
- Sections: all icons at 96px, scaling test (16-256px), dark background
- No external dependencies, works on `file://`
- Shows style metadata and generation info

### check-deps subcommand

- Checks for `rembg` → `uv tool install "rembg[cpu,cli]"` if missing
- Checks for `sips` (macOS) or `convert` (ImageMagick)
- Checks for `curl`, `python3`, `base64`
- Exits with error message if uncorrectable dependency missing

## Style Presets

| Preset | Prompt Prefix |
|--------|--------------|
| kawaii | `cute kawaii cartoon icon, flat vector illustration, bold dark brown outline, soft pastel colors` |
| flat | `flat design icon, clean vector style, minimal shadows, bold colors, simple geometric shapes` |
| glossy | `glossy 3D icon, rounded shapes, bright saturated colors, soft highlights and reflections` |
| sketch | `hand-drawn sketch icon, pencil line art style, warm paper texture feel, loose organic lines` |
| pixel | `pixel art icon, retro 8-bit style, crisp edges, limited color palette, nostalgic game aesthetic` |

All presets append: `centered on pure white background, single object, no text, no words, no letters, app icon style`

Custom prefix also supported.

## API Details

- **Model:** `imagen-4.0-generate-001`
- **Endpoint:** `POST https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key={KEY}`
- **Request body:** `{"instances":[{"prompt":"..."}],"parameters":{"sampleCount":1,"aspectRatio":"1:1","personGeneration":"dont_allow"}}`
- **Response:** `predictions[0].bytesBase64Encoded` → base64-decoded PNG
- **Rate:** ~3-5 seconds per image; ~20% timeout rate requires retries

## Output Structure

```
{output_dir}/
├── manifest.json     # Names, prompts, style, timestamps
├── gallery.html      # Inlined review gallery
├── originals/        # 1024x1024 source PNGs
├── nobg/             # Background-removed PNGs
├── 256/
├── 128/
├── 96/
├── 64/
├── 48/
├── 32/
├── 24/
└── 16/
```

## Requirements

- `GEMINI_API_KEY` in `.env` or environment
- macOS (`sips`) or ImageMagick (`convert`)
- `rembg` — auto-installed via `uv tool install`
- `curl`, `python3` — assumed present

## Scope Boundaries

Does NOT do:
- SVG generation (use icon-set-generator or gemini-svg-creator)
- LoRA training or fine-tuning
- Composable/layered icon assembly
- Imagen 4 Ultra (could be added later)

## Validation

Tested during research session (2026-03-10):
- Imagen 4 produces consistent kawaii cartoon icons
- rembg + Lanczos downscaling preserves quality to 16px
- ~20% API timeout rate handled by retries
- `.env` hook protection requires sourcing from external scripts
- Gallery must inline base64 PNGs (fetch fails on file://)
