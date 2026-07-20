# RSS Curation Skill — Design Spec

**Date:** 2025-07-21
**Skill name:** `rss-curation`
**Location:** `skills/rss-curation/`

## Problem

The user follows ~12 mixed RSS feeds (tech blogs, aggregators, changelogs,
newsletters). Volume is too high to evaluate manually. They need automated
curation that surfaces relevant articles and builds a searchable knowledge
base over time.

## Architecture

Three-phase pipeline:

```
[Fetch] → [Score] → [Output]
```

### Fetch

A Node.js script (`rss-feed.mjs fetch`) reads `config.yaml`, fetches all
RSS feeds, parses XML, extracts article metadata (title, link, date,
summary, author, feed source). Deduplicates against the SQLite DB by URL.
Only new entries proceed to scoring.

### Score

An LLM (Gemini Flash for headless/cron, Claude for interactive) receives
the batch of new articles plus the user's interest profile. It returns a
relevance score (0–10) and a one-line rationale per article. Scores and
rationales are written to the DB.

### Output

1. **All** new articles are stored in the knowledge base regardless of
   score — the archive is complete.
2. A ranked digest (`digests/YYYY-MM-DD.md`) is generated with only
   high-scoring items (threshold configurable, default ≥6).

## Storage

**Root directory:** `~/repos/gc/catalan/notes/rss/`

```
rss/
├── config.yaml          # feed URLs + settings
├── profile.yaml         # interest profile (3 layers)
├── feeds.db             # SQLite knowledge base
└── digests/
    └── 2025-07-21.md
```

### SQLite Schema

```sql
CREATE TABLE articles (
  id            INTEGER PRIMARY KEY,
  url           TEXT UNIQUE,
  title         TEXT,
  author        TEXT,
  feed_name     TEXT,
  feed_url      TEXT,
  published_at  TEXT,       -- ISO 8601
  fetched_at    TEXT,
  summary       TEXT,       -- RSS description/summary
  content       TEXT,       -- full text if extracted
  score         REAL,       -- LLM relevance 0-10
  score_reason  TEXT,       -- one-line rationale
  tags          TEXT,       -- JSON array of topic tags
  feedback      TEXT        -- 'up', 'down', or NULL
);

CREATE VIRTUAL TABLE articles_fts USING fts5(
  title, summary, content, tags
);
```

Single table, single FTS index. No separate feed or tag tables (YAGNI).

## Interest Profile

Lives at `~/repos/gc/catalan/notes/rss/profile.yaml`. Three layers,
flattened into a single prompt context for scoring. Explicit interests
outweigh inferred; learned feedback fine-tunes both.

### Layer 1: Explicit (user-written)

```yaml
explicit:
  interests:
    - "AI agents and coding assistants"
    - "Web performance and browser APIs"
    # user fills these
  anti-interests:
    - "Cryptocurrency and blockchain"
    # topics to suppress
```

### Layer 2: Inferred (auto-populated)

Rebuilt periodically by scanning the user's environment: AGENTS.md,
recent git repos, notes repo topics. Stored as:

```yaml
inferred:
  sources:
    - "AGENTS.md conventions"
    - "recent git repos"
    - "notes repo topics"
  topics: []
```

### Layer 3: Learned (from feedback)

Accumulated from up/down signals in the DB. Updated via the `learn`
subcommand (deliberate, not automatic):

```yaml
learned:
  boost:
    - "CLI tooling"
  suppress:
    - "enterprise CMS"
  examples:
    liked:
      - title: "How we built X with AI agents"
        reason: "practical AI agent architecture"
    disliked:
      - title: "Top 10 AI startups to watch"
        reason: "listicle, no technical depth"
```

## Feedback Loop

Users give feedback naturally in conversation:

- "That WebGPU article was great" → `feedback --signal up`
- "I don't care about listicles" → `feedback --signal down`

The digest includes short IDs per article so feedback can reference them:
"thumbs up on #3 and #7".

Script subcommand:

```bash
node rss-feed.mjs feedback --url <url> --signal up|down --db feeds.db
```

**Profile learning** is a separate deliberate step:

```bash
node rss-feed.mjs learn --profile profile.yaml --db feeds.db
```

Reads all feedback, identifies topic patterns, updates the `learned`
section. The skill suggests running it after ~20+ feedback signals
accumulate. The user reviews changes before they affect scoring.

## Scheduled Runs

A cron job (or macOS launchd) triggers the headless pipeline.
Default frequency: **daily at 7:00 AM local time**.

1. `node rss-feed.mjs fetch --config config.yaml --db feeds.db`
2. `node rss-feed.mjs score --profile profile.yaml --db feeds.db`
   — calls Gemini Flash API
3. `node rss-feed.mjs digest --db feeds.db --out digests/`

No Claude conversation needed. Requires `GEMINI_API_KEY` in the
environment for headless scoring.

The `setup` subcommand generates a launchd plist (macOS) or crontab
entry and offers to install it. The schedule is also configurable in
`config.yaml` under `settings.schedule`.

## Digest Format

```markdown
# RSS Digest — 2025-07-21

> 47 new articles fetched, 8 passed your relevance threshold (≥6/10)

## ⭐ Top Picks

### #1 · Article title here (9.2)
**Source:** Blog Name · 3h ago
**Why:** One-line relevance rationale
**Tags:** tag1, tag2
[Read →](https://...)

### #2 · Another article (8.1)
**Source:** Blog Name · 5h ago
**Why:** One-line relevance rationale
**Tags:** tag1, tag2
[Read →](https://...)

---

## Also Noted (score 6-7)

- **Title** (6.4) — Source · [link] · reason
- **Title** (6.1) — Source · [link] · reason

---
*Feed: 👍 #id · 👎 #id — reply with feedback to improve future digests*
```

## Skill Modes

| Mode | Trigger | Description |
| ------ | --------- | ------------- |
| **digest** | "rss digest", "what's new" | Full pipeline: fetch → score → digest |
| **search** | "search feeds for X" | FTS5 query against knowledge base |
| **feedback** | "thumbs up #3" | Record feedback signal |
| **learn** | "update rss profile" | Aggregate feedback into profile |

First-run **setup** flow: creates `config.yaml` (user adds feed URLs),
bootstraps `profile.yaml` (explicit interests + environment scan).

## Script Subcommands

Single entry point: `rss-feed.mjs`

| Subcommand | Purpose |
| ------------ | --------- |
| `setup` | Create config + profile, initialize DB |
| `fetch` | Fetch feeds, dedup, store new articles |
| `score` | LLM-score unscored articles |
| `digest` | Generate markdown digest |
| `search` | FTS5 search the knowledge base |
| `feedback` | Record up/down signal |
| `learn` | Aggregate feedback into profile |

## Dependencies

- `fast-xml-parser` — RSS/Atom XML parsing
- `better-sqlite3` — SQLite with FTS5 support
- `js-yaml` — config/profile YAML parsing

Scoring LLM:

- **Headless (cron):** Gemini Flash via REST API (`GEMINI_API_KEY`)
- **Interactive:** Claude (the skill itself does the scoring)

## Decisions

- **SQLite over plain JSON:** FTS5 search, dedup performance, single
  portable file. JSON/JSONL degrades with thousands of articles.
- **LLM-as-judge over keyword scoring:** Understands nuance and context.
  Token cost is trivial for ~50-100 articles per run with Gemini Flash.
- **Single script with subcommands** over multiple scripts: simpler to
  maintain, shared DB/config handling.
- **Feedback is deliberate, not automatic:** The `learn` step requires
  explicit invocation so the user reviews what changed.
- **All articles stored regardless of score:** The knowledge base is a
  complete archive. Low-score articles are still searchable.
