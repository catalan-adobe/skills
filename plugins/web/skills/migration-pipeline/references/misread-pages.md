# Misread pages: how a plain render lies, and what to do

The capture reads a page three ways — the visual tree, the band dump, the screenshot — and
the picture checks the reading: a page where they disagree is flagged `misread`, with the
disagreement as its detail (`pages/<id>/pixel-check.json`, the report's "Picture"). Each
flag is one of a few things. The first six were met on seven sites and 560 pages; the
generic ones are now in the capture, the site-specific ones have a command. When the flag
is new, it belongs here once it is understood.

## The detail says what it is

**`content not painted in B6 (a broken image from cdn.example)`** — an asset on an origin
the cache does not store. `migration.mjs assets cdn.example`, then `pipeline cache fill`,
then `pipeline chrome`.

**`content not painted in B6 (an embed from www.youtube.com, not rendered offline)`** — a
third-party iframe; the cache is of the site, not the web. Nothing to fix: write it down.
The dump keeps the embed as a media leaf, so the structure still sees it.

**`content not painted in B7 (4 leaves)`** — content laid out and invisible: a
scroll-triggered reveal held closed (`transform`, `opacity`), an anti-flicker veil, an
accordion the page opens by script. Find the rule that hides it (`getComputedStyle` on a
leaf; the stylesheet rule by its class) and undo it for the capture:
`migration.mjs access rendering ".x { transform: none !important }" --note "…"`, then
`pipeline chrome`.

**`B2 claims rgb(255, 255, 255), shows rgb(253, 5, 3)`** — something paints that the DOM
does not declare: a `::before` artwork, a canvas, a video poster. The dump reads
pseudo-elements as large as their element; a smaller one, or a canvas, is a new case.

**`B3 claims rgb(23, 24, 32), shows rgb(255, 255, 255)`** — a background declared and not
painted: a panel clipped to nothing, a layer under another, a `mix-blend-mode`. A new
case: look, and name the mechanism.

**`213 px of ink outside every band`** — painted rows the dump gave no leaf: decorative
images without a box, a gap the analysis cut as empty. Usually harmless for structure;
note it when the ink is content.

## What the capture already does, and why

Each of these was a site's lie, met once, and made a rule for every site. Knowing them
tells you what a new flag is *not*.

- **Pinned to the top before every reading.** A side navigation scrolled its active item
  into view after the page was prepared; the tree was read at the top, the screenshot
  and the dump 234 px down. A dump taken scrolled fails the capture.
- **Images pinned to their chosen candidate before the screenshot.** A full-page shot
  lays the page out at the page's height; responsive images picked candidates never
  fetched online (broken offline) and the page grew 8 000 px under the readings. The
  readings are also taken again while the page grows; three times, then the page fails.
- **Animations and transitions frozen.** A reveal easing in over a second is read where
  it ends.
- **A clip-path leaving no area hides an element.** A mega menu's closed panel, laid
  out under the bar at 1280 × 370 and clipped by `inset(0 0 100%)`, had put a band edge
  mid-paragraph and a grey background on every article.
- **A fixed layer taller than a band is a curtain, not chrome.** A transparent 720 px
  veil promoted beside the header had made the header's box reach halfway down the page.
- **A pseudo-element's paint, as large as its element, is its background.** A hero
  drawn by `::before`; a 0 px menu underline is not.
- **A failed image is asked for once more.** A transient refusal is not what the page
  shows.

## How to look

1. `pipeline pixels` for the numbers; the report's "Picture" for the list; the structure
   review's red line on the page.
2. Open `shots/page.jpg` at the band's `y`. What is there — blank, a broken-image icon,
   a colour? Then the band's leaves in `band-capture.json` (`p` indexes `paths`): what the
   DOM says is there.
3. Open the page in the offline browser with the capture's config
   (`migration/.work/chrome/browser-config.json`) and ask the element: `getComputedStyle`,
   `checkVisibility()`, `complete` and `naturalWidth` on an image, the ancestors'
   `overflow`, `clip-path`, `transform`. The lie is in one of them.
4. Decide: generic (a rule any site could need — change the capture, bump
   `CAPTURE_VERSION`, recapture the bench) or this site's (a recipe fact — the command,
   then `pipeline chrome`; the flag should go).
5. Write what you did in the step's note. A flag that stays is a fact about the site
   the next level reads with.

## Measured

Seven sites, 560 pages, before and after one day of this: flags 9 → 4 (two embeds, one
pseudo-element case still to look at, one unclaimed ink); NASA's broken images 214 → 8
(all `secure.gravatar.com`, an origin to name), its re-read pages 18 → 0; aem.live's
home revealed by one rendering rule. Four sites never flagged a page.
