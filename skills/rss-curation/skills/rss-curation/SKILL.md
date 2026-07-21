---
name: rss-curation
description: >
  Follow RSS feeds and curate them with LLM-scored relevance. Builds a
  searchable SQLite knowledge base, produces ranked daily digests, and
  learns your interests from feedback. Use when the user wants to check
  their feeds, search past articles, give feedback, star articles, or
  update their interest profile. Triggers on: "rss digest", "what's new
  in my feeds", "search my feeds for X", "thumbs up on #3", "star #1",
  "update rss profile", "/rss-curation", "rss search", "curate my feeds",
  "show starred articles".
---

# RSS Curation

Curate RSS feeds with LLM-scored relevance, build a searchable knowledge
base, and produce ranked digests that improve over time via feedback.

## Script Location

```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  RSS_SCRIPTS="${CLAUDE_SKILL_DIR}/scripts"
else
  RSS_SCRIPTS="$(find ~/.claude -path "*/rss-curation/scripts" \
    -type d 2>/dev/null | head -1)"
fi
if [[ -z "$RSS_SCRIPTS" || ! -d "$RSS_SCRIPTS" ]]; then
  echo "Error: rss-curation scripts not found." >&2
  exit 1
fi
```

## First-Run Setup

Install dependencies:

```bash
cd "$RSS_SCRIPTS" && [ -d node_modules ] || npm install
```

If no data directory exists yet, help the user set up:

1. Ask where they want their data directory
2. Run setup:

```bash
cd "$RSS_SCRIPTS" && node rss-feed.mjs setup --data-dir "$DATA_DIR"
```

1. Help the user edit `config.yaml` to add their RSS/Atom feed URLs
2. Help the user fill in `profile.yaml` with their explicit interests
3. Optionally scan AGENTS.md and recent repos to populate the inferred layer

## Data Paths

All data lives in the configured `data_dir`:

- `config.yaml` — feed URLs and settings
- `profile.yaml` — 3-layer interest profile
- `feeds.db` — SQLite knowledge base (all articles + scores + feedback + stars)
- `digests/YYYY-MM-DD.md` — daily digest files

## Mode: Digest

Trigger: "rss digest", "what's new in my feeds", "check my feeds"

### Step 1: Fetch new articles

```bash
cd "$RSS_SCRIPTS" && node rss-feed.mjs fetch \
  --config "$DATA_DIR/config.yaml" \
  --db "$DATA_DIR/feeds.db"
```

Output: JSON with `{ total, new, articles }`. Report how many new articles.
Supports RSS 2.0, Atom, and RSS 1.0 (RDF) feeds.

### Step 2: Score unscored articles

```bash
cd "$RSS_SCRIPTS" && node rss-feed.mjs unscored \
  --db "$DATA_DIR/feeds.db"
```

This returns all unscored articles as JSON. **You (Claude) score them.**

Read the user's `profile.yaml` first. Then for each article, evaluate
relevance against the 3-layer profile and produce:

```json
[
  {
    "url": "https://...",
    "score": 8.5,
    "scoreReason": "One-line rationale",
    "tags": ["ai", "agents"]
  }
]
```

**Scoring guidelines:**

- 9-10: Directly matches explicit interests, high signal
- 7-8: Related to interests, good technical depth
- 5-6: Tangentially related or general tech interest
- 3-4: Low relevance, different domain
- 0-2: Matches anti-interests or pure noise

Priority: explicit interests > inferred topics > learned boosts.
Anti-interests and learned suppressions lower the score.

Write scores back by invoking a Node one-liner:

```bash
cd "$RSS_SCRIPTS" && node -e "
import { openDb, writeScores } from './db.mjs';
const db = openDb('$DATA_DIR/feeds.db');
writeScores(db, $SCORES_JSON);
db.close();
"
```

Where `$SCORES_JSON` is the JSON array of score objects.

### Step 3: Generate digest

```bash
cd "$RSS_SCRIPTS" && node rss-feed.mjs digest \
  --db "$DATA_DIR/feeds.db" \
  --date "$(date +%Y-%m-%d)" \
  --out "$DATA_DIR/digests"
```

Present the digest to the user in conversation.

## Mode: Search

Trigger: "search my feeds for X", "have I seen anything about X"

```bash
cd "$RSS_SCRIPTS" && node rss-feed.mjs search \
  --db "$DATA_DIR/feeds.db" \
  --query "search terms" \
  --limit 10
```

Returns JSON with matching articles. Present results conversationally
with title, source, date, score, and link.

## Mode: Feedback

Trigger: "thumbs up on #3", "+1 on #3", "I liked that article", "-1 on #5"

The user can give feedback using emoji or text shortcuts:

| Input | Meaning |
|-------|---------|
| `+1` or `up` | 👍 Liked — boosts similar content |
| `-1` or `down` | 👎 Disliked — suppresses similar content |

```bash
cd "$RSS_SCRIPTS" && node rss-feed.mjs feedback \
  --db "$DATA_DIR/feeds.db" \
  --url "<article-url>" \
  --signal +1  # or -1, up, down
```

The digest uses numbered IDs (#1, #2, etc.) — resolve those to URLs from
the most recent digest or search results.

## Mode: Star

Trigger: "star #1", "bookmark that article", "show my starred articles"

Stars are independent of feedback — the user can star AND thumbs-up the
same article. Stars act as a personal reading list / bookmarks.

```bash
# Star an article
cd "$RSS_SCRIPTS" && node rss-feed.mjs star \
  --db "$DATA_DIR/feeds.db" \
  --url "<article-url>"

# Remove star
cd "$RSS_SCRIPTS" && node rss-feed.mjs unstar \
  --db "$DATA_DIR/feeds.db" \
  --url "<article-url>"

# List all starred articles
cd "$RSS_SCRIPTS" && node rss-feed.mjs starred \
  --db "$DATA_DIR/feeds.db"
```

## Mode: Learn

Trigger: "update my rss profile", "learn from my feedback"

```bash
cd "$RSS_SCRIPTS" && node rss-feed.mjs learn \
  --db "$DATA_DIR/feeds.db" \
  --profile "$DATA_DIR/profile.yaml"
```

Aggregates all feedback signals, identifies topic patterns, and updates
the `learned` section of `profile.yaml`. Show the user what changed so
they can review it. Suggest running after ~20+ feedback signals.

## Interest Profile

The profile has 3 layers (see [default-profile.yaml](references/default-profile.yaml)):

1. **Explicit** — user-written interests and anti-interests
2. **Inferred** — auto-populated from environment (AGENTS.md, repos, notes)
3. **Learned** — accumulated from feedback signals

When scoring, flatten all three into your prompt context. Explicit
interests carry the most weight, then inferred, then learned.

## Cron Setup (Headless Fetch)

For daily automated fetching (no scoring — that happens interactively):

```bash
0 7 * * * cd /path/to/rss-curation/scripts && node rss-feed.mjs fetch \
  --config /path/to/config.yaml --db /path/to/feeds.db
```

Or use `setup` subcommand to generate a macOS launchd plist.
