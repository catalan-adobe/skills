#!/usr/bin/env node
// No site-specific names and no working-process jargon in shipped files.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git']);
const PATTERNS = [
  /hirslanden|knack|catalan-adobe|kingdom-air|hobsons|eds-mig/i,
  /\bPlan [A-C]\b|\bTask \d+\b|\bcontroller\b|\bruling\b|\bv1\b/,
];

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (/\.(mjs|md|json|yaml)$/.test(entry.name) && !entry.name.startsWith('check-')) {
      yield full;
    }
  }
}

const offenders = [];
for await (const file of files(root)) {
  const lines = (await readFile(file, 'utf8')).split('\n');
  lines.forEach((line, i) => {
    if (PATTERNS.some((p) => p.test(line))) {
      offenders.push(`${path.relative(root, file)}:${i + 1}: ${line.trim().slice(0, 80)}`);
    }
  });
}
if (offenders.length) {
  console.error(`Residue found:\n${offenders.join('\n')}`);
  process.exit(1);
}
console.log('check-residue: ok');
