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
