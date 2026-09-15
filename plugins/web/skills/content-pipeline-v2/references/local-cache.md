# The local cache

Once the `cache` step has run, the site lives under `migration/cache/.page-cache/`: the
pages the operator approved, plus every script, style, image, font and fragment the browser
fetched while rendering them. Later steps read the cache, never the site. The origin owes
us nothing more; hitting it again is slower, bot-prone, and gives a different page than the
one the analysis is based on.

## What is in it

- One body per response, at `<host>_<hash>/<path>` (`index.html` for directories), with a
  sidecar `<path>.json` holding the status and response headers.
- `migration/cache/cache.md` lists the pages by selection with their status; the inventory
  `migration/urls/urls.json` carries `cache.path` and `cache.verified` per URL.
- Redirects and 404s are stored as such. A page that never got visited has no file.

## How to read it

```bash
node <skill>/scripts/status.mjs cache ls [--group <g>] [--kind <k>]   cached URLs
node <skill>/scripts/status.mjs cache has <url>                       exit 0 when stored
node <skill>/scripts/status.mjs cache get <url> [--headers]           the stored body
```

`get` prints the body exactly as the site sent it. It is the fastest way to grep a page or
count something across the corpus: `cache ls | while read u; do … cache get "$u" …; done`.

## How to render it in the browser

```bash
node <skill>/scripts/status.mjs cache serve          start (or reuse) the offline server
node <skill>/scripts/status.mjs cache url <url>...   the address to open for each page
```

`serve` picks a free port, starts the page-cache proxy in offline mode, records it in
`migration/.work/cache-server.json` and reuses it on every later call — never start it any
other way, never pick a port. It also writes `migration/.work/cache-browser-config.json`
(printed as `browserConfig`): the probe's playwright-cli config plus `network.allowedOrigins`
set to the proxy alone. Open every browser session on the cache with it — nothing then
leaves the machine, no analytics beacon to the site's real tracking, no live CDN:

```bash
ADDRESS=$(node <skill>/scripts/status.mjs cache url <url>)
playwright-cli --config=migration/.work/cache-browser-config.json open "$ADDRESS"
```

`--config` is given once, on `open`; later commands in the session (`goto`, `eval`,
`screenshot`, `close`) take none. `cache url` already starts the server. The proxy serves a
copy of each body with same-host absolute URLs rewritten to relative, so scripts and styles
resolve through the proxy too.

Every page the browser loads through the server comes from disk. A URL that is not cached
gets a **504** and no request leaves the machine: that means "not cached", never "go and
fetch it". If the analysis needs a page that is missing, that is a `cache` step question
(approve a subset, run `warm.mjs`), not something to fetch by hand.

`status.mjs` shows the server (`cache server: running on … · N stored responses`) and the
dashboard links to its `/__status` (hits, misses, stored count). `cache stop` ends it.

## Limits

- Only responses from the site's own host are stored. Images or scripts on another host —
  a brand image CDN, a search or video service, fonts — are not in the cache: with the
  browser config above they fail to load (a render shows the layout without them); without
  it they are fetched live. The browser's `requests` log shows what a page tried to reach.
- Hover- or click-only content (mega-menus, tabs) was not rendered during caching unless
  the page fetched it up front.
- One selection at a time was verified; the inventory says which pages carry
  `cache.verified: true`.
