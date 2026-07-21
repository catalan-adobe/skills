#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fetchFeeds } from './fetch.mjs';
import { openDb, getUnscored } from './db.mjs';
import { runSearch } from './search.mjs';
import { applyFeedback, learnFromFeedback } from './feedback.mjs';
import { generateDigest } from './digest.mjs';

const USAGE = [
  'Usage: rss-feed.mjs <subcommand> [options]',
  '',
  'Subcommands:',
  '  fetch      --config <path> --db <path>',
  '  unscored   --db <path>',
  '  digest     --db <path> --date <YYYY-MM-DD> [--out <dir>] [--min-score <n>]',
  '  search     --db <path> --query <text> [--limit <n>]',
  '  feedback   --db <path> --url <url> --signal <up|down>',
  '  learn      --db <path> --profile <path>',
].join('\n');

function die(msg) {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(1);
}

function parseFlags(argv) {
  const flags = {};
  const args = argv.slice(2);
  flags.subcommand = args[0];
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i]
        .slice(2)
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      flags[key] = args[i + 1] || true;
      i++;
    }
  }
  return flags;
}

function requireFlag(flags, name) {
  if (!flags[name]) die(`Missing required flag: --${name}`);
  return flags[name];
}

const COMMANDS = {
  async fetch(flags) {
    const configPath = requireFlag(flags, 'config');
    const dbPath = requireFlag(flags, 'db');
    const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
    const db = openDb(dbPath);
    try {
      const result = await fetchFeeds(config, db);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      db.close();
    }
  },

  async unscored(flags) {
    const dbPath = requireFlag(flags, 'db');
    const db = openDb(dbPath);
    try {
      const articles = getUnscored(db);
      console.log(JSON.stringify(articles, null, 2));
    } finally {
      db.close();
    }
  },

  async digest(flags) {
    const dbPath = requireFlag(flags, 'db');
    const date = flags.date || new Date().toISOString().slice(0, 10);
    const outDir = flags.out;
    const minScore = flags.minScore ? Number(flags.minScore) : undefined;
    const md = generateDigest(dbPath, date, { outDir, minScore });
    console.log(md);
  },

  async search(flags) {
    const dbPath = requireFlag(flags, 'db');
    const query = requireFlag(flags, 'query');
    const limit = flags.limit ? Number(flags.limit) : 20;
    console.log(runSearch(dbPath, query, limit));
  },

  async feedback(flags) {
    const dbPath = requireFlag(flags, 'db');
    const url = requireFlag(flags, 'url');
    const signal = requireFlag(flags, 'signal');
    if (signal !== 'up' && signal !== 'down') {
      die('--signal must be "up" or "down"');
    }
    console.log(applyFeedback(dbPath, url, signal));
  },

  async learn(flags) {
    const dbPath = requireFlag(flags, 'db');
    const profilePath = requireFlag(flags, 'profile');
    console.log(learnFromFeedback(dbPath, profilePath));
  },
};

async function main() {
  const flags = parseFlags(process.argv);
  if (!flags.subcommand) die('No subcommand provided.');
  const cmd = COMMANDS[flags.subcommand];
  if (!cmd) die(`Unknown subcommand: ${flags.subcommand}`);
  await cmd(flags);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
