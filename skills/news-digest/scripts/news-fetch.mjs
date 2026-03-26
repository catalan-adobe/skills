#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { XMLParser } from 'fast-xml-parser';

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
