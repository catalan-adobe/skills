# The migration data model

A migration moves a complete website from A (the source, live on the web) to B (an EDS
project). Everything the migration knows, decides and produces lives in one directory,
`migration/`, as JSON files with stated schemas, so that any client — the skill, a CLI, a
web service, a dashboard, another decomposition method — reads and writes the same data
through the same layer. Markdown exists only as a *view* or a *note*, and every one of
them is referenced from JSON.

The library under `scripts/lib/` is the only code that reads or writes `migration/`;
every other skill, script, dashboard or service is a client of it.

## 1. Principles

1. **One home per fact.** A fact is written in one file by one writer. Everything else
   that shows it is a view, regenerated.
2. **Every file has a class**, stated in the model and checked:
   - *decision* — authored by a person, or an agent standing in for one; irreplaceable;
   - *raw* — input from outside, kept for provenance, read once;
   - *derived* — rebuildable from the cache and the decisions, deletable at will;
   - *run* — the state of one execution, ephemeral;
   - *history* — append-only record of what happened.
   The invariant: **the cache and the decisions are the migration; the rest is rebuilt.**
3. **Every entity has an id**, and references are by id, never by string matching. Ids
   are a three-letter prefix and 12 hex of a sha1 (48 bits: no collision in practice at a
   hundred thousand pages): `mig-` the migration, `pag-` a page (of its canonical URL),
   `typ-` a type (of its identity), `frg-` a fragment (header, footer or inline), `sel-` a
   selection, `not-` a note; a run is `run-<compact time>-<step>`.
4. **Every file states its schema**: `"schema": "<unit>/<file>@<version>"`. A JSON Schema
   per file lives with the data layer; reading validates, writing validates.
5. **Per-entity facts live per entity.** Nothing about one page sits inside a site-level
   file; a site-level file may carry a *summary* of pages (counts, ids), never their
   content.
6. **Process state is derived.** Which steps are done, running, waiting is computed from
   the data and the runs, cached in one file for readers that cannot compute it.
7. **Big and small apart.** Bodies, trees, images in their own files, addressed by id;
   the tables stay small enough to read whole.
8. **Every derived file carries a `summary`**: one short paragraph, in words, of what it
   holds, written by its writer. A dashboard, a `--text` view, a note or an agent reads it
   first; a run's `summary` says what the run did.

## 2. The units

```text
migration/
  migration.json            the migration: source, target, settings, approvals     decision
  state.json                every step's state, computed                           derived
  runs/                     one file per execution of a step                        run/history
  website/                  the source site as a whole
    website.json            origin, scope, how it was discovered, languages, groups derived
    access.json             how to open a page: bot-protection recipe, overlays     decision
    fragments.json          the shared documents: header, footer (template), inline  derived
    chrome-candidates.json  what recurs across pages, with the rules' verdict, crops  derived
    chrome.json             a reader's choice of header and footer among them        decision
  pages/                    the pages
    pages.json              the table: one record per URL, with its verdict         derived+facts
    selections/<name>.json  a named set of page ids with its criteria               decision
    decisions.json          the operator's word on single pages: in or out, why     decision
    verdicts.json           a person's word on what a page is, for the bench         decision
    <id>/                   one page's artefacts
      composition.json      the page in EDS shape: fragments, sections, items     derived
      visual-tree.json      the rendered page measured by the page-tree bundle      derived
      band-capture.json     the page's content leaves and bands (the census's dump)  derived
      pixel-check.json      the screenshot's verdict on the band capture               derived
      triage.json           what a System 1 model saw: header, footer, broken, empty derived
      shots/                crops taken on this page                                evidence
  fragments/<id>/           a shared document's artefacts
      composition.json      the fragment in EDS shape (a header has its bands here) derived
      shots/                crops of the fragment on a page that carries it         evidence
  cache/                    the site's bodies and assets (the proxy's own layout)   raw
  elements/                 the site's vocabulary
    types.json              element types as a method found them: variants, sample  derived
    elements.json           what each type is in EDS terms: six kinds, one field    decision
    methods/<name>.json     a method's own knobs for this site                      decision
    inventory.json          the EDS reading: blocks, sections, fragments, coverage  derived
    evidence/<typeId>/      crops per type and variant                              evidence
  notes/                    words from people and agents
    notes.json              index: id, step, author, at, file, summary              history
    <id>.md                 the note
  views/                    rendered documents                                       derived
    report.md, report.html   the migration on one page, in words and as one HTML file
```

Four entities carry the domain — **migration**, **website**, **pages**, **elements** —
with **runs**, **notes**, **evidence** and **views** as supporting units. The target (B)
is a field of the migration today and becomes a unit of its own when the build phase
writes into it (layout contract, brand, blocks).

## 3. Each file

### migration.json — *decision*

```json
{
  "schema": "migration/migration@1",
  "id": "mig-5f2a9c1e3b7d",
  "created": "…",
  "source": { "origin": "https://www.example.com/", "scope": "https://www.example.com/",
              "assetOrigins": ["https://images.example.com"] },
  "target": { "repo": ".", "kind": "eds", "owner": null, "site": null },
  "plan": { "pages": 500, "selection": null },
  "settings": { "cacheAllUpTo": 500, "captureMinWidth": 250, "pace": 1500, "sessions": 4,
                "skills": { "repo": "adobe/skills", "ref": null } },
  "approvals": { "cache": ["sample-50"], "elements": true }
}
```

- `source.scope` bounds the website: only URLs under it are pages of the migration;
  groups are the first path segment below it; the rest is off-scope, recorded and not
  migrated. Explicit, default the origin — a migration of one section of a site is common.
- `source.assetOrigins`: other origins whose assets the pages use (an image CDN). The
  cache stores them too; without them an offline render shows empty image boxes. A
  decision taken on seeing the cache step's count of cross-origin assets, or a render.
- `plan` is how much to migrate: `pages` a budget (drives what `pick` proposes, what
  progress means, the estimate) until the operator decides *which* — then `selection`
  names the frozen selection and the count follows from it.
- `approvals` is the operator's recorded yes at the gated steps, with what was approved
  (selection names for `cache`, `true` for `elements`): what lets the state say
  `waiting-operator` and keeps an agent from going on alone.
- `settings`: `pace` (ms between two pages read from the live site: the only place the
  site is read, and bot detection watches it), `sessions` (browser sessions reading the
  *cache* side by side — chrome, later any offline step; the local proxy has no such
  limit), `captureMinWidth`, `cacheAllUpTo`, and the skills source — a setting of the
  migration, not of a step. `migration.mjs setting <name> <value>`.

### state.json — *derived*

The migration's global status — at the root, not among the runs. Per step `state`
(`done | ready | blocked | waiting-operator | running`), `blockedBy`, `note` (a short human
text: why it is not done), `progress`, the run id while running; a top-level `summary`;
`generatedAt`. Computed by the state function from the data and the runs; written so
dashboards and services need not compute it. Never read by a step to decide anything —
steps run the checks.

### runs/<runId>.json — *run*, then *history*

One shape for every background or foreground execution:

```json
{ "schema": "runs/run@1", "id": "r-20260922T101500-capture", "step": "capture",
  "state": "running", "started": "…", "finished": null, "pid": 4242,
  "total": 48, "done": 12, "failed": [], "current": "p-…",
  "input": { "selection": "sample-50", "minWidth": 250 },
  "summary": null }
```

`state`: `queued | running | done | stopped | failed`. Liveness is two signals, neither
tied to one kind of client: `pid` when the worker is a local process, and `updatedAt` as
a heartbeat the worker refreshes with its progress; a `running` run whose pid is dead or
whose heartbeat is older than a threshold reads as `interrupted` — computed, never
written. A finished run keeps its file: the runs directory is the migration's history
(the elements step's rules iterations are runs with a `summary` of types added and
removed; the cache's selections are runs). The newest run per step is what `state.json`
reports.

### website/website.json — *derived*

Origin and scope; how the URLs were discovered (sitemaps, crawl) and when; languages
seen; the URL groups (name, count, cached, captured) as a summary of `pages.json`;
counts. Rewritten by the pages layer when the table changes.

### website/access.json — *decision*

How to open a page of this site: the browser recipe (engine, headers, stealth, profile)
from the probe, the overlays and hide rules from the prep, the `rendering` rules a reader
found necessary for a plain render to show what a visitor sees (CSS applied before a page
is read: a scroll-triggered reveal held closed), the pages the recipe was verified on. One
file: a page is opened one way, wherever it is opened from; a capture older than it is
stale.

### website/fragments.json — *derived*

In EDS a header and a footer **are fragments** — documents of their own placed by the
template — and a banner reused across pages is a fragment placed by a block. One entity,
two placements. Every shared document the site has: `frg-` id, `placement` (`template`,
with a `part`: `header`, `footer`, or a named other; `inline`, with a `name`), a label, the
member selectors and optional members, page count, evidence, the method that found it,
and the candidates rejected. **One header is one document however many bands compose
it**; two template fragments of one part are two designs (a campaign microsite) and need
their own ids and labels. Which pages use a fragment is not stored here: the page says so
(its composition, summarised on its record), and "pages using X" is a query. Each
fragment has a composition like a page's under `fragments/<id>/` — a header's bands are
its sections, decomposable into blocks like any document.

### website/chrome-candidates.json — *derived*, website/chrome.json — *decision*

The chrome as a choice. The chrome step's engine lists what recurs across the pages at
a stable place — each candidate under an id that is the same on every run, with the
numbers the rules read (support, width share, text stability, height, position), the
rules' verdict (`header`, `footer`, `unplaced`, `rejected` with its reason) and a crop.
A reader — an agent at any tier, a person — may choose otherwise: `chrome.json` names a
part's members among those ids (none: the site has no such part), with who chose, when
and why. The choice is part of what a detection is of: a new one makes the detection
stale, and the next chrome run derives the fragments from it. Rules propose; a reader
decides; the data records both.

### pages/pages.json — *derived + facts*

The page table. One record per URL the migration knows:

```json
{ "id": "pag-3f9a2c7d1e4b", "url": "https://…", "group": "blogs",
  "discovered": { "from": "sitemap", "at": "…" },
  "http": { "status": 200, "contentType": "text/html" }, "redirect": null, "finalUrl": "…",
  "kind": "page",
  "verdict": { "status": "in", "reasons": [
    { "code": "no-footer", "kind": "flag", "by": "chrome", "at": "…", "detail": "…" } ] },
  "cache": { "at": "…", "path": "www.example.com_15600fa6/index.html", "selection": "sample-50" },
  "fragments": ["frg-header", "frg-footer", "frg-contact-cta"],
  "composition": { "method": "visual-tree", "at": "…", "sections": 7, "omitted": 2 } }
```

Discovery, HTTP, redirect, kind and cache are facts the proxy and the scan produced; the
`fragments` and `composition` fields are summaries of the page's own composition, maintained
by its writer. The class is mixed and said so: the record's facts are regenerable only by
re-caching, so the table is kept with the cache.

**The verdict** says whether the page is migrated and, above all, *why not*. `status` is
computed, never written by hand: `out` when an `exclude` reason stands, `undecided` for a
page in scope not yet chosen (`plan.selection` unset), else `in`; an operator decision
overrides. Each reason is a fact with a `code` from the schema's closed vocabulary — the
one place reasons are documented —, a `kind` (`exclude`: the page is out; `flag`: odd,
still in until someone decides), the unit that found it (`by`: `discover`, `plan`, `cache`,
`chrome`, `triage`, `composition`, `operator`) so that re-running a unit refreshes its
reasons and no other's, `at` and a `detail`. Two units may say the same thing about one
page by different means — `chrome` finds no header in the structure, `triage` sees none
in the picture — and both reasons stand side by side: agreement and disagreement are
read off the record, not decided for it. Codes: `off-scope` (not under `source.scope`),
`over-budget` (beyond `plan.pages` in the plan's selection), `not-a-page` (binary, asset),
`redirect`, `http-error`, `unreachable`, `duplicate` (same final URL as another page),
`no-header`, `no-footer`, `empty` (nothing between the chrome), `broken` (an error, a
blank page, a login or cookie wall or a bot check where content should be),
`too-tall` (taller than a browser screenshots whole, ~16 384 px: parked, no picture to
judge it by), `misread` (the screenshot disagrees with what the DOM claims is painted; the
detail says where), `operator`. `over-budget` exists only once `plan.selection` names the
frozen set.

### pages/decisions.json — *decision*

The operator's word on single pages, irreplaceable, merged into the record's verdict as a
reason `by: operator` that wins:

```json
{ "schema": "pages/decisions@1",
  "pages": {
    "pag-…": { "status": "out", "reason": "legal pages stay on the old site", "at": "…" },
    "pag-…": { "status": "in", "reason": "a missing footer is the template", "at": "…" } } }
```

`pages.json`'s `summary` counts by reason; `views/pages.md` lists excluded and flagged pages
by reason; a step's state note may cite them ("chrome: 2 pages without a footer").

### pages/selections/<name>.json — *decision*

```json
{ "schema": "pages/selection@1", "name": "sample-50", "created": "…",
  "criteria": { "count": 50, "excludeGroups": ["zh-tw"], "audit": 5 },
  "ids": ["p-…", "p-…"] }
```

A selection freezes the ids it chose and keeps the criteria that chose them, so it can be
read ("fifty pages, one per group") and remade.

### pages/verdicts.json — *decision*

Ground truth for the bench: a person's word on what a page is, from its body crop, in
half a minute — `sameAs` (an earlier page whose template this one repeats, or none),
a `problem` when the page cannot be judged as one (`capture-fault`: the picture is wrong;
`odd`: not of the site's kind — the other fields may then stay empty),
`category` (`document` · `bands` · `composed`: how much of the main content a plain
document expresses; side columns are said by the layout only),
`layout` (`single` · `main-left` · `main-right` · `both`: a side column persisting beside
the content), `constructs` (hero, cards, columns, accordion-tabs, carousel, form, table,
embed, cta-band, gallery, metadata-box, toc), a rough `bands` count, a note; with who
judged and when. Never derived, never read by a method; a method's reading of the same
pages is measured against it. The annotation sheet (`migration.mjs annotate <selection>`
→ `views/annotate-<selection>.html`) is the tool; `verdicts import` records its export.

### pages/<id>/composition.json — *derived*

The page in **EDS document shape** — the one structure every decomposition method writes,
whatever it does to get there, so the elements and block layers read one thing:

```json
{ "schema": "pages/composition@1",
  "method": { "name": "visual-tree", "version": "…", "at": "…", "inputs": "sha…" },
  "document": { "kind": "page", "id": "pag-…" },
  "fragments": [ { "ref": "frg-header", "selector": "…", "bounds": {…} },
                 { "ref": "frg-footer", "selector": "…", "bounds": {…} } ],
  "sections": [ { "id": "s1", "selector": "…", "bounds": {…}, "style": { "background": "…" },
                  "items": [
                    { "role": "content",  "selector": "…", "bounds": {…} },
                    { "role": "block",    "type": "t-…", "variant": "v-…", "selector": "…"},
                    { "role": "fragment", "ref": "f-…", "selector": "…", "bounds": {…} } ]}],
  "omitted":  [ { "selector": "…", "bounds": {…}, "reason": "hairline" } ] }
```

The depth is fixed by the schema, as an EDS document's is: the template-placed fragments
(header, footer) at the document level; sections in order, each with its style and its
items; an item is `content` (default content), a `block` (a type of the site's
vocabulary, with its variant) or a `fragment` (a shared document embedded here, which
has this same shape). A block never holds a block. A method that cannot yet tell section
boundaries writes one section. The `document` is a page or a fragment: a header's own
composition is its bands as sections.

`selector` is mandatory on every node — the universal locator any client can re-find.
`bounds` (the rendered rectangle) are present when the method rendered the page; crops,
position statistics and evidence use them and skip without them. `omitted` records what
the method saw and left out, with a reason, so coverage is honest across methods and
"where did my hero go" has an answer. `method` is the provenance; two methods' compositions
of one page may coexist as `composition.<method>.json`, and the page record says which is
current.

Mapping to a document is then mechanical: sections → sections, `block` → a block table,
`content` → default content, `fragment` → a fragment reference.

### pages/<id>/triage.json — *derived*

What a System 1 model saw on the page's screenshot, four questions and nothing else: a
site header at the very top, a site footer at the very bottom, a broken page (an error,
a blank, a login or cookie wall, a bot check) instead of content, an empty page (nothing
where the content should be: a listing a script never filled) — each a probability.
With `method` (name, model, when, the hash of the picture), `images` (how many slices,
at what scale and JPEG quality: a page scaled far down was not really seen) and `usage`.
The triage step reads the answers at a threshold (0.5) into reasons on the table by
`triage` — `no-header`, `no-footer`, `broken`, `empty`, each a flag — beside what `chrome`
found in the structure; the numbers stay here. Pages flagged by either are parked: not
read further until someone looks.

```json
{ "schema": "pages/triage@1",
  "method": { "name": "system1", "model": "@cf/cloudflare/clef", "at": "…", "inputs": "sha…" },
  "answers": { "header": 0.97, "footer": 0.91, "broken": 0.02, "empty": 0.03 },
  "images": { "slices": 3, "scale": 1, "quality": 80, "bytes": 310000 },
  "usage": { "inputTokens": 3100, "ms": 2400 } }
```

### elements/types.json — *derived*

The site's element types: id, identity, pages (count), instances, support, recurring,
height statistics, variants (children identities, counts), sample (page id + selector),
evidence paths, `mergedFrom`; fragments and their distinct contents; groups' saturation;
`rulesHash`, `compositionsAt`. No per-page content — the pages reference the types; "pages
with type X" is a query over compositions.

### elements/elements.json — *decision*

What each recurring type **is in EDS terms** — one file for all the words, keyed by type
id, six kinds each with its one field: `section` (with its `style` — section metadata),
`block` (its name), `default-content`, `fragment` (its name — the type is a shared
document), `wrapper` (no EDS element: a layout wrapper, look inside), `skip`; `null` while
undecided. A rerun of the vocabulary keeps what was decided and drops undecided orphans;
`header` and `footer` are never a name. Structured repeating content (cards, carousel,
tabs) is a block, never a wrapper. The decomposition reads this file: a section is
decomposed through and becomes a section with that style, a fragment becomes a fragment
item or document, a wrapper disappears, a skip goes to `omitted`.

### elements/methods/<name>.json — *decision*

A method's own knobs for this site — what adapts *how it reads a DOM*: identity
exclusions, noise classes, leaf tags, thresholds, merges, rejections by selector. Another
method has other knobs and its own file; `elements.json` is shared by all.

### elements/inventory.json — *derived*

The EDS reading of the site: blocks with their types, instances, pages, variants, sample
and evidence; section styles; inline fragments linked to their shared documents; default
content; wrappers; skipped; undecided; orphaned decisions; coverage read from the
compositions themselves — a page is fully read when it has a composition, every block
item's type is decided, nothing on it is undecided or skipped, and it is not empty.

### notes/ — *history*

Every piece of prose: what an agent decided and why, what the operator said, what a step
reports in words. `notes.json` indexes them (`id`, `step`, `author: agent | operator |
runner`, `at`, `file`, `summary`); the body is a Markdown file. `views/report.md` and
`views/report.html` are rendered from the notes and the data — never edited. The HTML
is one file without script, its images referenced relatively, so it opens from disk.

### views/ — *derived*

Rendered documents for people, regenerated by the layer that owns the data they show.
Each view is listed in the owning JSON (`"views": ["views/pages.md"]`) so a client knows
it exists and that it is disposable.

## 4. The access layer

`scripts/lib/` is the only code that reads or writes `migration/`:

- `schema.mjs` — the schema registry (`name@version`, a class each) and the validator every
  read and write goes through; `store.mjs` — `openStore(cwd)`: validated reads, validated
  atomic writes, ids.
- `migration.mjs` — `init`, `open`, `setting`, `plan`, `approve`.
- `runs.mjs` — `start`, `update`, `finish`, `list`, `newest`, `liveness`.
- `state.mjs` — `STEPS`, `compute(cwd, checks)`, `write`, `asText`.
- `pages.mjs` — the table: `upsert`, `setReasons`, `decide`, `rejudge`, `get`, `list`;
  `selections.mjs` — `create`, `read`, `list`, `pagesOf`; `composition.mjs` — `write`,
  `writeMany`, `read`, `writeFragment`, `readFragment`, `items`, `fragmentRefs`;
  `trees.mjs` — `write`, `read`, `head`, `list` (the visual tree, a method's artefact);
  `chrome.mjs` — `writeCandidates`, `readCandidates`, `choose`, `readChoice`, `candidateId`,
  `choiceHash`; `verdicts.mjs` — `upsert`, `read`, `importFile`; `bands.mjs` —
  `writeCapture`, `readCapture`, `upsertVerdicts`, `readVerdicts`, `importVerdicts`;
  `triage.mjs` — `write`, `read`, `list`, `flagsOf` (what a System 1 model saw).
- `website.mjs` — `refresh`, `writeAccess`/`readAccess`, `writeFragments`/`readFragments`,
  `pagesUsing`.
- `elements.mjs` — `writeTypes`/`readTypes`, `decide`, `undecided`, `writeMethod`/
  `readMethod`; `inventory.mjs` — `write`, `read`.
- `notes.mjs` — `add`, `list`, `body`; `views.mjs` — `renderReport`, `writeReport`, `write`.

Writes are atomic (temp file + rename), validated, stamped `updatedAt`. Steps call the
layer; so does the CLI (`scripts/migration.mjs`) and so would a service.

## 5. Process state, derived

A step is **done** when its outcome is on disk and valid — the checks — and its inputs
are not newer than it. The checks read the data layer, not file paths: `capture` is done
when every cached page of the approved selections has a tree at the current min-width;
`elements` when every cached page has a composition at the current rules hash; and so
on. Staleness
is a comparison of recorded hashes and times inside the data, not of file mtimes.
