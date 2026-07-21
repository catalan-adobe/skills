import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.mjs';

export function initDataDir(dataDir, configTemplate, profileTemplate) {
  fs.mkdirSync(path.join(dataDir, 'digests'), { recursive: true });

  const configPath = path.join(dataDir, 'config.yaml');
  const profilePath = path.join(dataDir, 'profile.yaml');
  const dbPath = path.join(dataDir, 'feeds.db');

  if (!fs.existsSync(configPath)) {
    fs.copyFileSync(configTemplate, configPath);
  }
  if (!fs.existsSync(profilePath)) {
    fs.copyFileSync(profileTemplate, profilePath);
  }

  const db = openDb(dbPath);
  db.close();

  return { configPath, profilePath, dbPath };
}

function parseCron(schedule) {
  const [minute, hour] = schedule.split(' ');
  return {
    minute: Number(minute) || 0,
    hour: Number(hour) || 7,
  };
}

export function generateLaunchdPlist(
  scriptPath,
  configPath,
  dbPath,
  schedule,
) {
  const parts = parseCron(schedule);
  const label = 'com.catalan.rss-curation';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>node</string>
    <string>${scriptPath}</string>
    <string>fetch</string>
    <string>--config</string>
    <string>${configPath}</string>
    <string>--db</string>
    <string>${dbPath}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${parts.hour}</integer>
    <key>Minute</key>
    <integer>${parts.minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/rss-curation.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/rss-curation.err</string>
</dict>
</plist>`;
}
