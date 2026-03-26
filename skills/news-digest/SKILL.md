---
name: news-digest
description: >
  Fetch and digest news from Google News RSS feeds and Google Alerts by
  topic. Extracts full article content, images, and videos. Scans
  configured topics, deduplicates stories, and produces a rich markdown
  digest with article summaries. Use when the user wants a news summary,
  news digest, Google News scan, or says things like "what's in the news",
  "news about X", "news digest", "scan my news feeds", or "/news-digest".
---

# News Digest

Fetch Google News RSS feeds by topic, extract full article content,
and produce a rich markdown digest with article summaries, images,
and video links.

## Script Location

```bash
if [[ -n "${CLAUDE_SKILL_DIR:-}" ]]; then
  NEWS_SCRIPTS="${CLAUDE_SKILL_DIR}/scripts"
else
  NEWS_SCRIPTS="$(find ~/.claude -path "*/news-digest/scripts" \
    -type d 2>/dev/null | head -1)"
fi
if [[ -z "$NEWS_SCRIPTS" || ! -d "$NEWS_SCRIPTS" ]]; then
  echo "Error: news-digest scripts not found." >&2
  exit 1
fi
```

## First-Run Setup

Before the first invocation, install dependencies:

```bash
cd "$NEWS_SCRIPTS" && [ -d node_modules ] || npm install
```

Run this at the start of every invocation. The `[ -d node_modules ]`
check makes subsequent runs instant.

## Prerequisites

Google News URLs require a headless browser to resolve. The script uses
`playwright-cli` (must be on PATH). Verify with:

```bash
which playwright-cli || echo "playwright-cli not found — install it first"
```

## Config

The user maintains a `config.yaml` with topics to track. If no config
exists yet, copy the default:

```bash
DEFAULT_CONFIG="${NEWS_SCRIPTS}/../references/default-config.yaml"
```

Ask the user where they want their config (e.g., `ai/news/config.yaml`)
and copy the default there. Then they can edit topics and settings.

## Invocation Modes

### Full digest (all configured topics)

```bash
cd "$NEWS_SCRIPTS" && node news-fetch.mjs --config /path/to/config.yaml
```

### Ad-hoc query (no config needed)

```bash
cd "$NEWS_SCRIPTS" && node news-fetch.mjs --query "search terms"
```

### Single topic from config

```bash
cd "$NEWS_SCRIPTS" && node news-fetch.mjs --config /path/to/config.yaml --topic "AI"
```

## Output Processing

The script outputs a JSON array to stdout. Each item has:

- `title` — headline
- `source` — publisher name
- `url` — Google News redirect URL
- `resolvedUrl` — actual article URL after redirect. `null` if decoding failed
- `pubDate` — publication date string
- `timestamp` — epoch ms
- `topic` — which configured topic matched
- `content` — full article text (plain text). `null` if extraction failed
- `paywall` — `true` if paywall detected, `false` otherwise
- `error` — error message if extraction failed, `null` on success
- `images` — array of `{ src, alt }` for article images (ads filtered out)
- `videos` — array of `{ src, domain }` for embedded videos

**Your job as the LLM:**

1. Read the JSON output
2. Group stories by `topic`
3. For each story with `content`: write a 2-3 sentence summary from the full article text
4. For each story without `content` (paywall or error): fall back to headline-only format
5. Include the lead image (first item in `images`) inline when available
6. Include video links when available
7. Use `resolvedUrl` for article links (not the Google News redirect `url`)
8. Present in conversation AND save to a digest file

## Digest File

Save to `ai/news/YYYY-MM-DD-digest.md` in the user's project. If a
digest for today already exists, append new sections rather than
overwriting.

Format:

```markdown
# News Digest — YYYY-MM-DD

## Topic Name

### Headline here
**Source:** Source Name (2h ago) | [article](resolvedUrl)

2-3 sentence summary of the full article content generated from the
`content` field.

![Alt text](image-src)

---

### Paywalled headline
**Source:** Source Name (3h ago) | [article](resolvedUrl) | 🔒 Paywall

*(Full article not available)*
```

- Stories with `content`: full summary + lead image + video links
- Stories with `paywall: true`: headline only, marked with 🔒
- Stories with `error` and no paywall: headline only, no special marker

## User Guidance

- If the user has no config yet, help them create one by copying
  the default and editing topics
- If the user asks to add/remove a topic, edit their config.yaml
- If the user asks for an ad-hoc search, use --query mode
- Keep digests tight: max_stories from config (default 15)
