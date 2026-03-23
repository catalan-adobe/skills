# Gemini Icon Set Reference

## Manifest Format

The manifest is the contract between Claude and the script. Structure:

```json
{
  "style": "cute kawaii cartoon icon, flat vector illustration, bold dark brown outline, soft pastel colors, centered on pure white background, single object, no text, no words, no letters, app icon style",
  "output": "./icons",
  "icons": {
    "ice-cream-cone": "a single scoop ice cream cone with sprinkles",
    "milkshake": "a tall milkshake glass with whipped cream and a straw",
    "waffle": "a golden waffle with butter and syrup"
  }
}
```

- `style` -- full prompt prefix applied to every icon
- `output` -- directory where all outputs are written
- `icons` -- map of kebab-case name to icon-specific description

The final prompt sent to Imagen 4 for each icon is:
`{style}, {icon description}`

## Style Presets

| Preset | Full Prompt Prefix |
|--------|-------------------|
| kawaii | `cute kawaii cartoon icon, flat vector illustration, bold dark brown outline, soft pastel colors, centered on pure white background, single object, no text, no words, no letters, app icon style` |
| flat | `flat design icon, clean vector style, minimal shadows, bold colors, simple geometric shapes, centered on pure white background, single object, no text, no words, no letters, app icon style` |
| glossy | `glossy 3D icon, rounded shapes, bright saturated colors, soft highlights and reflections, centered on pure white background, single object, no text, no words, no letters, app icon style` |
| sketch | `hand-drawn sketch icon, pencil line art style, warm paper texture feel, loose organic lines, centered on pure white background, single object, no text, no words, no letters, app icon style` |
| pixel | `pixel art icon, retro 8-bit style, crisp edges, limited color palette, nostalgic game aesthetic, centered on pure white background, single object, no text, no words, no letters, app icon style` |

## Output Structure

```
{output_dir}/
  manifest.json       # Names, prompts, style
  gallery.html        # Self-contained review gallery (base64-inlined)
  originals/          # 1024x1024 source PNGs from Imagen 4
  nobg/               # Background-removed PNGs
  256/
  128/
  96/
  64/
  48/
  32/
  24/
  16/
```

Each size directory contains one PNG per icon, named by the kebab-case
key from the manifest (e.g., `ice-cream-cone.png`).
