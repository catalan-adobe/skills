# News Digest Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code skill that fetches Google News RSS feeds by topic/keyword, deduplicates stories, and outputs structured JSON for the LLM to summarize into a markdown digest.

**Architecture:** A Node.js CLI script (`news-fetch.mjs`) does all data fetching — reads a YAML config of topics/alerts, fetches RSS feeds via `fetch()`, parses XML with `fast-xml-parser`, deduplicates, filters by recency, and outputs JSON to stdout. The SKILL.md instructs Claude how to invoke the script, format results, and write digest files to the user's notes repo.

**Tech Stack:** Node 22 (ESM, built-in `fetch()`), `fast-xml-parser` for RSS parsing, `js-yaml` for config reading. Skill follows catalan-adobe/skills conventions: `SKILL.md` + `tile.json` + `scripts/` directory.

**Spec:** `ai/news/2026-03-26-news-digest-design.md` in the notes repo.

**Target repo:** `/Users/catalan/repos/ai/catalan-adobe/skills` — work in a worktree.

---

## File Structure

```
skills/news-digest/
├── SKILL.md                    # Skill prompt — invocation, workflow, output format
├── tile.json                   # Marketplace metadata
├── scripts/
│   ├── news-fetch.mjs          # CLI: fetch RSS, parse, deduplicate, output JSON
│   └── package.json            # Dependencies: fast-xml-parser, js-yaml
└── references/
    └── default-config.yaml     # Example config users copy to their project
```

The user places their `config.yaml` wherever they want (e.g., `ai/news/config.yaml`). The skill reads it from a path passed as an argument or from the current working directory.

---

### Task 1: Scaffold skill directory and metadata

**Files:**
- Create: `skills/news-digest/tile.json`
- Create: `skills/news-digest/scripts/package.json`
- Create: `skills/news-digest/scripts/.gitignore`

- [ ] **Step 1: Create tile.json**

```json
{
  "name": "catalan-adobe/news-digest",
  "version": "0.1.0",
  "private": false,
  "summary": "Fetch and digest news from Google News RSS feeds and Google Alerts by topic. Scans configured topics, deduplicates stories, and produces a tight markdown digest. Use when the user wants a news summary, news digest, Google News scan, or says things like 'what's in the news', 'news about X', 'scan my news feeds'.",
  "skills": {
    "news-digest": {
      "path": "SKILL.md"
    }
  }
}
```

- [ ] **Step 2: Create scripts/package.json**

```json
{
  "name": "news-digest-scripts",
  "private": true,
  "type": "module",
  "dependencies": {
    "fast-xml-parser": "4.5.3",
    "js-yaml": "4.1.0"
  }
}
```

Pin exact versions — look up current stable at write time.

- [ ] **Step 3: Create scripts/.gitignore**

```
node_modules/
```

- [ ] **Step 4: Commit**

```bash
git add skills/news-digest/tile.json skills/news-digest/scripts/package.json skills/news-digest/scripts/.gitignore
git commit -m "feat(news-digest): scaffold skill directory and metadata"
```

---

### Task 2: Build news-fetch.mjs — config loading and CLI args

**Files:**
- Create: `skills/news-digest/scripts/news-fetch.mjs`
- Create: `skills/news-digest/references/default-config.yaml`

- [ ] **Step 1: Create default-config.yaml**

```yaml
topics:
  - name: AI Infrastructure
    query: "AI infrastructure OR AI agents"
  - name: Adobe
    query: "Adobe"

alerts: []
#  - name: Claude Code
#    feed_url: "https://www.google.com/alerts/feeds/..."

settings:
  max_stories: 15
  language: en
  country: US
  hours_back: 24
```

- [ ] **Step 2: Write news-fetch.mjs with arg parsing and config loading**

```javascript
#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = { config: null, topic: null, query: null };
  const raw = argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    switch (raw[i]) {
      case '--config': flags.config = raw[++i]; break;
      case '--topic': flags.topic = raw[++i]; break;
      case '--query': flags.query = raw[++i]; break;
      case '--help':
        console.log(
          'Usage: news-fetch.mjs [--config path] [--topic name] [--query "search terms"]\n' +
          '  --config  Path to config.yaml (default: ./config.yaml)\n' +
          '  --topic   Scan only this topic from config\n' +
          '  --query   Ad-hoc query (skips config topics)'
        );
        process.exit(0);
        break;
      default: die(`Unknown argument: ${raw[i]}`);
    }
  }
  return flags;
}

function loadConfig(configPath) {
  const p = configPath || resolve(process.cwd(), 'config.yaml');
  if (!existsSync(p)) die(`Config not found: ${p}`);
  const raw = readFileSync(p, 'utf8');
  const config = yaml.load(raw);
  if (!config) die(`Empty or invalid config: ${p}`);
  return config;
}

// --- Entry point (extended in Task 3) ---
const flags = parseArgs(process.argv);
const config = flags.query ? null : loadConfig(flags.config);
console.log(JSON.stringify({ flags, config }, null, 2));
```

- [ ] **Step 3: Install dependencies and test basic execution**

```bash
cd skills/news-digest/scripts && npm install
node news-fetch.mjs --help
node news-fetch.mjs --config ../references/default-config.yaml
```

Expected: `--help` prints usage. Config run prints parsed flags + config JSON.

- [ ] **Step 4: Commit**

```bash
git add skills/news-digest/scripts/news-fetch.mjs skills/news-digest/references/default-config.yaml
git commit -m "feat(news-digest): add CLI arg parsing and config loading"
```

---

### Task 3: Build news-fetch.mjs — RSS fetching and XML parsing

**Files:**
- Modify: `skills/news-digest/scripts/news-fetch.mjs`

- [ ] **Step 1: Add RSS fetch and parse functions**

Add these functions to `news-fetch.mjs` above the entry point:

```javascript
import { XMLParser } from 'fast-xml-parser';

const RSS_SEARCH = 'https://news.google.com/rss/search';
const parser = new XMLParser({ ignoreAttributes: false });

function buildSearchUrl(query, lang, country) {
  const params = new URLSearchParams({
    q: query,
    hl: lang,
    gl: country,
    ceid: `${country}:${lang}`,
  });
  return `${RSS_SEARCH}?${params}`;
}

async function fetchFeed(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; news-digest/1.0)' },
  });
  if (!res.ok) {
    console.error(`Warning: ${url} returned ${res.status}`);
    return [];
  }
  const xml = await res.text();
  const parsed = parser.parse(xml);
  const items = parsed?.rss?.channel?.item;
  if (!items) return [];
  const list = Array.isArray(items) ? items : [items];
  return list.map((item) => ({
    title: item.title || '',
    source: item.source?.['#text'] || item.source || '',
    url: item.link || '',
    pubDate: item.pubDate || '',
    timestamp: item.pubDate ? new Date(item.pubDate).getTime() : 0,
  }));
}

async function fetchTopic(topic, settings) {
  const url = buildSearchUrl(
    topic.query,
    settings.language || 'en',
    settings.country || 'US',
  );
  const stories = await fetchFeed(url);
  return stories.map((s) => ({ ...s, topic: topic.name }));
}

async function fetchAlert(alert) {
  const stories = await fetchFeed(alert.feed_url);
  return stories.map((s) => ({ ...s, topic: alert.name }));
}
```

- [ ] **Step 2: Replace the entry point with the full pipeline**

Replace the entry point section at the bottom of the file:

```javascript
async function main() {
  const flags = parseArgs(process.argv);

  // Ad-hoc query mode
  if (flags.query) {
    const settings = { language: 'en', country: 'US' };
    const stories = await fetchTopic(
      { name: 'Search', query: flags.query },
      settings,
    );
    console.log(JSON.stringify(stories.slice(0, 15), null, 2));
    return;
  }

  // Config-based mode
  const config = loadConfig(flags.config);
  const settings = config.settings || {};
  const maxStories = settings.max_stories || 15;
  const hoursBack = settings.hours_back || 24;
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;

  // Determine which topics to fetch
  let topics = config.topics || [];
  if (flags.topic) {
    const match = topics.find(
      (t) => t.name.toLowerCase().includes(flags.topic.toLowerCase()),
    );
    if (!match) die(`Topic "${flags.topic}" not found in config`);
    topics = [match];
  }

  const alerts = flags.topic ? [] : (config.alerts || []);

  // Fetch all feeds concurrently
  const fetches = [
    ...topics.map((t) => fetchTopic(t, settings)),
    ...alerts.map((a) => fetchAlert(a)),
  ];
  const results = (await Promise.all(fetches)).flat();

  // Deduplicate by URL
  const seen = new Set();
  const unique = results.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  // Filter by recency and sort
  const recent = unique
    .filter((s) => s.timestamp >= cutoff)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, maxStories);

  console.log(JSON.stringify(recent, null, 2));
}

main();
```

- [ ] **Step 3: Test with a live query**

```bash
cd skills/news-digest/scripts
node news-fetch.mjs --query "AI agents"
```

Expected: JSON array of stories with title, source, url, pubDate, timestamp, topic fields.

- [ ] **Step 4: Test with config file**

```bash
node news-fetch.mjs --config ../references/default-config.yaml
```

Expected: JSON array of stories from all configured topics, deduplicated, sorted by date.

- [ ] **Step 5: Commit**

```bash
git add skills/news-digest/scripts/news-fetch.mjs
git commit -m "feat(news-digest): add RSS fetching, parsing, and deduplication"
```

---

### Task 4: Write SKILL.md

**Files:**
- Create: `skills/news-digest/SKILL.md`

- [ ] **Step 1: Write the skill prompt**

```markdown
---
name: news-digest
description: >
  Fetch and digest news from Google News RSS feeds and Google Alerts by
  topic. Scans configured topics, deduplicates stories, and produces a
  tight markdown digest saved to the user's project. Use when the user
  wants a news summary, news digest, Google News scan, or says things
  like "what's in the news", "news about X", "news digest",
  "scan my news feeds", or "/news-digest".
---

# News Digest

Fetch Google News RSS feeds by topic, deduplicate, and produce a
markdown digest with one-line summaries per story.

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
- `url` — link to the story
- `pubDate` — publication date string
- `timestamp` — epoch ms
- `topic` — which configured topic matched

**Your job as the LLM:**

1. Read the JSON output
2. Group stories by `topic`
3. Write a one-line summary for each story (headline + source + relative time)
4. Present in conversation AND save to a digest file

## Digest File

Save to `ai/news/YYYY-MM-DD-digest.md` in the user's project. If a
digest for today already exists, append new sections rather than
overwriting.

Format:

```markdown
# News Digest — YYYY-MM-DD

## Topic Name
- **Headline here** — Source Name (2h ago) [link](url)
- **Another headline** — Other Source (5h ago) [link](url)

## Another Topic
- **Story** — Source (1h ago) [link](url)
```

## User Guidance

- If the user has no config yet, help them create one by copying
  the default and editing topics
- If the user asks to add/remove a topic, edit their config.yaml
- If the user asks for an ad-hoc search, use --query mode
- Keep digests tight: max_stories from config (default 15)
```

- [ ] **Step 2: Commit**

```bash
git add skills/news-digest/SKILL.md
git commit -m "feat(news-digest): add skill prompt"
```

---

### Task 5: Update repo manifests

**Files:**
- Modify: `README.md` (add news-digest to Available Skills section)

- [ ] **Step 1: Add news-digest entry to README.md**

Add to the `## Available Skills` section, in alphabetical order:

```markdown
### news-digest

Fetch and digest news from Google News RSS feeds and Google Alerts by
topic. Scans configured topics, deduplicates stories, and produces a
tight markdown digest. Use when you want a news summary, topic scan, or
daily digest of headlines.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add news-digest to README"
```

---

### Task 6: End-to-end verification

- [ ] **Step 1: Run full pipeline with default config**

```bash
cd skills/news-digest/scripts
node news-fetch.mjs --config ../references/default-config.yaml
```

Expected: JSON array, stories from multiple topics, no duplicates, sorted by date.

- [ ] **Step 2: Run ad-hoc query**

```bash
node news-fetch.mjs --query "Claude AI"
```

Expected: JSON array of Claude-related news stories.

- [ ] **Step 3: Run single topic**

```bash
node news-fetch.mjs --config ../references/default-config.yaml --topic "Adobe"
```

Expected: JSON array with only Adobe-topic stories.

- [ ] **Step 4: Test error cases**

```bash
node news-fetch.mjs --config /nonexistent/path.yaml
# Expected: "Error: Config not found: ..."

node news-fetch.mjs --config ../references/default-config.yaml --topic "nonexistent"
# Expected: "Error: Topic "nonexistent" not found in config"

node news-fetch.mjs --help
# Expected: Usage text
```

- [ ] **Step 5: Verify no lint issues**

```bash
cd /Users/catalan/repos/ai/catalan-adobe/skills
# Check for any repo-level linting
```
