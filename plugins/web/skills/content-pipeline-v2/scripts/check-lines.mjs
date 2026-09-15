#!/usr/bin/env node
// Every committed line of the skill stays within 100 characters, except the SKILL.md
// frontmatter `description` (a single long line by the skill format).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git']);

const ALLOWED = /\.(mjs|md|json|yaml|html|js|css|txt)$|^\.gitignore$/;
const unexpected = [];

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (/\.(mjs|md|json|yaml|js|css|html)$/.test(entry.name)) yield full;
    else if (!ALLOWED.test(entry.name)) unexpected.push(path.relative(root, full));
  }
}

function inFrontmatterDescription(lines, index) {
  if (!lines[0]?.startsWith('---')) return false;
  const end = lines.indexOf('---', 1);
  return index > 0 && index < end && /^\s*description:|^\s{2,}\S/.test(lines[index]);
}

const offenders = [];
for await (const file of files(root)) {
  const lines = (await readFile(file, 'utf8')).split('\n');
  lines.forEach((line, i) => {
    if (line.length <= 100) return;
    if (file.endsWith('SKILL.md') && inFrontmatterDescription(lines, i)) return;
    offenders.push(`${path.relative(root, file)}:${i + 1} (${line.length})`);
  });
}
if (offenders.length) {
  console.error(`Lines over 100 characters:\n${offenders.join('\n')}`);
  process.exit(1);
}
if (unexpected.length) {
  console.error(`Files of a kind this skill does not ship (test artefacts?):\n${
    unexpected.slice(0, 10).join('\n')}${unexpected.length > 10 ? '\n…' : ''}`);
  process.exit(1);
}
console.log('check-lines: ok');
