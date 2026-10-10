# The structure method: what is settled, what is not

`pipeline structure <selection>` reads each page's body into EDS shape: sections with a
layout at level 1, their items at level 2. This note records how the method came to be,
what it was measured against, and where it stands — so that the next reader does not
re-derive it or trust it beyond what was measured. Dates: 2026-10-09/10. Bench: seven
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

## Level 1 — settled

- **Candidates** (`candidates`): from the tree, through wrapper chains (one child inside
  the body, or one child covering it with slivers beside) to the first level with two or
  more children; siblings sharing a vertical range form one candidate with parts side by
  side; gaps belong to the band above.
- **Facts** (`facts`, `stateOf`), as words: position, height, background; layout from the
  parts' widths (a part 1.6× wider than its neighbour is the main column; equal widths are
  columns), else the leaves' columns (`columnsOf`, ignored when the band is a grid of alike
  images), else a rail the dump set aside; a side layout needs 300 px of height. Pictures:
  large image covering the band / N alike images of one size / N images. Text: none /
  short texts / a few lines / paragraphs. Headings, links, inputs, embeds; 16 content
  snippets.
- **Questions** (`questions`), all yes/no, one request per candidate, two crops (the band;
  the previous band above it): `is_default`, `is_block`, `is_section` (the three kinds as
  questions; the most probable wins), `title_above` (a heading introducing a component
  below → section), `merge` (do `previous` and `band` form one part for an author;
  threshold 0.75).
- **Rules** (`decide`): a side layout → section unless the model judged a block (a hero
  beside its text panel); equal columns judged default → block (columns); one heading and
  nothing else → default; an image alone → block when ≥ 90 % of the page wide, else
  default (an image in flow); an empty band → merged.
- **What did not work**: a three-way `choice` (System 1 does not compose: 1 block found
  in 59); image-only or text-only input; dropping the content snippets (merge 85 → 78);
  dropping the pair image (merge 85 → 80).

## Level 2 — built, not settled

What is built (`open`, the queue in `structurePage`): a section band is opened into its
main part's siblings (same wrapper walk; into a lone candidate as tall as the band when
the siblings fold into one); side columns set aside (narrower than 40 % of the container,
taller than 40 % of the band, starting in its top fifth, at an edge) and fed back as the
band's layout; consecutive runs of text elements (`TEXT_TAGS`) merged and typed default
content without asking; the other children asked the same five questions; inside a
section two children join only when of the same kind (a heading never joins the block it
introduces); members of a band merged at level 1 are children by construction; a child
that is a section again is opened once more (`MAX_DEPTH` 3). The composition's items are
the leaves of that tree plus the side columns.

What is not settled, and why it matters:

- **Level 2 is not level 1 again.** Inside a section EDS has *items*, not bands: runs of
  default content, blocks, and side columns that are layout. Reusing the band machinery
  found, one page at a time, where its assumptions do not hold (wrappers, side-column
  thresholds, merge semantics, the stop rule). Each fix was right; the sequence has no end.
- **The stop rule is a proxy.** A child is opened again when the model calls it a section.
  The judgement actually needed is *is this subtree one component, or a group of several?*
  — a component stops, a group opens. That question has not been asked as such.
- **EDS depth is fixed, not N.** Section → items → (inside a block) rows → cells. Level 3
  is block internals — alike children as rows, their children as cells — pure geometry
  and the start of the block vocabulary. Not begun.
- **Thresholds were set by eye** on three pages (NASA Chas Hoff, wknd Beervana, Synopsys
  offices); there is no reference for level 2 yet. The level-1 lesson applies: build the
  measurement first (a sample of opened sections with the right items marked), then set
  thresholds against it.

Proposed contract for the next iteration, not yet implemented: candidate kinds `text run |
subtree | side column`; one question per subtree, *one component or a group*; stop at a
component or a text run; block internals as a separate, structural pass.

## Artefacts

`pages/<id>/structure.candidates-system1.json` (schema `pages/structure@2`): `candidates`
with facts, state, answers, decision and rule; `bands` with members, kind, layout,
`children` (recursive) and `side`; `usage`. `pages/<id>/composition.json`: sections with
`style.layout`, items as leaves. `migration.mjs structure-review <selection>` →
`views/structure-<selection>.html`: candidate cuts dashed blue, bands by kind, children
dashed and inset by depth, side columns hatched; a row per candidate with probabilities
and the rule that changed the decision.
