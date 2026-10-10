# The structure method: what is settled, what is not

`pipeline structure <selection>` reads each page's body into EDS shape, as one operation
applied until it has nothing left to do: cut a part of the page into bands, qualify each —
`section`, `block`, `default_content`, or `layout` (parts side by side) — and cut and
qualify again inside every section and layout. This note records how the method came to be,
what it was measured against, and where it stands — so that the next reader does not
re-derive it or trust it beyond what was measured. Dates: 2026-10-09/11. Bench: seven
sites × 10 pages (`judge-10`): wknd, aem.live, NASA, MDN, MIT, gov.uk, Synopsys.

## How the method was chosen

Five readings of the same 70 pages, in order, each a lab run before anything was built:

1. **A vision model alone** (Haiku 5.5 high, Sonnet 5.5 low) on screenshot strips with a
   pixel ruler, one JSON schema, full decomposition. Both found blocks the band method
   missed (heroes, carousels, cards) and agreed with each other on 30 of 41 bands; both
   placed boundaries ±30–80 px and could not name DOM anchors. Cost: Haiku $0.002/page,
   Sonnet $0.016/page.
2. **First level only, free**: cut the body into bands and name each `section | block |
   default_content`. Sonnet-low gave the author's cut on 9 of 10 wknd pages; it cut
   through a two-column article on the tenth (nothing in the prompt forbade it, and the
   schema had no way to say "two columns").
3. **The hybrid**: candidates from the visual tree's siblings (stacked, or side by side as
   one candidate with columns), drawn on the strips; the model merges and types. No cut
   through an element is possible; the layout is read off the siblings. Asking the kind of
   the *merged* band made Sonnet-low over-merge into "block"; asking the kind **per
   candidate** and deriving the merged kind in code (same kinds keep it, mixed make a
   section) removed that by construction. Haiku and Sonnet then agreed on 9 of 10 pages.
   Run on the six other sites with Haiku-high: 60 pages, 0 invalid, $0.082, 2.6 minutes.
   **This is the reference the pipeline was measured against.**
4. **A System 1 model (Clef) on the same candidates**: the questioning strategy below;
   kind 68 → 90 %, merge 85 %, 98 % repeatable; cost per page about Haiku's ($0.0015 vs
   $0.0014 — Clef's images cost what Haiku's thinking costs), three times faster.
5. **The pipeline's `structure`** = that strategy; 70 pages: kind 90 %, merge 85 %, 43
   pages identical to Haiku, ~6 k tokens/page at level 1.

The lab files are outside the repository (`~/repos/ai/migration-tests/_lab/{haiku-wknd,
hybrid,s1}`); their findings are copied into the migration project's `docs/research/`.

## The cut — the tree's, at every depth

- **Candidates** (`candidates`, `stack`): at the body, the tree's siblings, through wrapper
  chains (one child inside the range; or one child as tall as the range with nothing
  *beside* it — clear of it across and more than a sliver) to the first level with two or
  more children; siblings sharing a vertical range form one candidate with parts; gaps
  belong to the band above.
- **Inside a candidate** (`cut`), the same at every depth: its columns when its parts are
  side by side (two parts at least 120 px wide overlapping across by at most a quarter of
  the narrower — a grid's margin, not a layer); else its nodes stacked; else, for one node,
  through its wrappers to its siblings. One candidate of layers over each other passes into
  the layer with most content, the other layers carried along once and stacked with its
  children (a breadcrumb drawn over a section's top is kept, a background is dropped).
  Consecutive prose elements (`TEXT_TAGS`: paragraphs, headings, quotes, code, figures,
  images — not lists, links or spans, which can be a nav, tabs or cards) are one text run.
- **Looked at before asking**: every candidate's cut is computed first. Siblings side by
  side under wrappers make the candidate side by side; a column without content (the
  page's grid) is not a part; the reader is told the parts and, for a stack, how many parts
  of what are inside (`stack`: "three parts one above another: one of text, two other").

## Qualifying — the reader and the rules

- **Facts** (`facts`, `stateOf`), as words: position, height, background; the arrangement
  (a part 1.6× wider than its neighbour is the main column; equal widths are columns; else
  the leaves' columns, not a grid's; else a rail the dump set aside); parts side by side
  with their shares of the width; what is stacked inside; pictures (large image covering
  the band / N alike images / N images); text (none / short / a few lines / paragraphs);
  headings, links, inputs, embeds; 16 content snippets. A column sees only its own leaves,
  a side rail's included.
- **Questions** (`questions`), all yes/no, one request per candidate: `is_default`,
  `is_block`, `is_section` (the most probable wins), `title_above` (a heading introducing a
  component below), `is_layout` only when the parts are side by side, `merge` only when
  there is a candidate above in the same stack (columns are not a stack). Crops: the
  candidate at its own extent; with a merge question, the previous one above it too.
- **Rules** (`decide`, `derive`): a block under a heading that introduces it → section;
  side by side and `is_layout` ≥ 0.5 → layout; side by side and judged section → layout;
  one heading and nothing else → default; an image alone → block when ≥ 90 % of the page
  wide, else default; an empty candidate merges. A band merged from candidates of one kind
  keeps it; of mixed kinds, or of several containers, it is a section whose children are
  its members. Inside a container, default content next to default content is one run
  (EDS); at the first level the model's merges stand, for there the section breaks are.
- **Digging** (`reader`): every section and layout is cut and qualified again; nothing
  left to cut leaves it `unresolved`; one child makes it that child (`collapsed`). Default
  content with parts inside, one of them not text, is dug into to check (`checked`): what
  comes back all default content is one run again; a block inside makes it a section.
  `MAX_DEPTH` 12 is a guard; on the bench the trees end by depth 6.
- **What did not work**: a three-way `choice` (System 1 does not compose: 1 block found
  in 59); image-only or text-only input; dropping the content snippets (merge 85 → 78);
  dropping the pair image (merge 85 → 80); telling the reader what is stacked inside
  without checking (MDN's home page, three headed card grids, stayed "default content").

## Where it stands (2026-10-11, 70 pages)

- **Cost**: 895 questions, ~21 k tokens a page, ≈ $0.005 a page — level 1 alone was
  $0.0015. All 70 trees end; 6 containers are unresolved (MDN's sidebar, two code samples,
  MIT's related links and an image pair, one aem.live tutorial step) — the tree has no
  children to give there, often because the content sits in another subtree.
- **Level 1 against Haiku** (which had no layout kind: parts side by side were a section
  with a side layout or a block with columns): plain default content 110/115, plain blocks
  17/20, plain sections 9/15; merge 85 %. Haiku's side-by-side calls split three ways and
  the split is mostly a naming difference, not an error: a row of address columns is our
  layout and Haiku's columns block; a heading over a card row is our `s[d b]` and Haiku's
  section with columns. Haiku can confirm the plain cases and cannot judge the rest.
- **Read on the pages**: wknd Beervana `d b s[d l[d s[b d]]]` — title, hero, the title of
  the article, its facts column beside the main column of tabs and text; NASA's article
  page a layout of byline and article; MDN's home page `s[s[d b] s[d b] d]` on one run.
- **Unstable near ties**: one phrase added to a criterion ("a code sample") flipped MDN's
  home page back to default content and turned NASA's photo-with-caption into a block.
  Kind decisions where two probabilities lie within ~10 points move with wording; the
  measures over 255 candidates hardly move. Single pages cannot tell which wording is
  better: **a human reference is the next step**, and the review collects it.

## Artefacts

`pages/<id>/structure.candidates-system1.json` (schema `pages/structure@3`): `candidates`,
every one cut at any depth, with `parent`, `depth`, extent, parts, facts, state, answers,
decision and rule; `bands`, the tree: each node with members, kind, extent, `children`,
`unresolved`, `collapsed`, `checked`; `usage`. `pages/<id>/composition.json`: a section
per first-level band, its items the leaves of the tree under it in reading order —
flattening nested sections into EDS's one level is a later phase's. `migration.mjs
structure-review <selection>` → `views/structure-<selection>.html`: the first level solid,
deeper nodes dashed at their own extent, unresolved tinted red, the tree in letters
(`s[d l[d b]]`); a row per node with probabilities and the rule; a mark per node (ok, the
kind it should be, wrong cut) and a note, kept in the browser, exported as JSON.
