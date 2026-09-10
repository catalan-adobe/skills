#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const extensions = ['.mjs', '.md', '.json', '.yaml'];

function checkLines(dir) {
  const files = fs.readdirSync(dir);
  let found = false;

  for (const file of files) {
    if (file === 'node_modules') continue;

    const filepath = path.join(dir, file);
    const stat = fs.statSync(filepath);

    if (stat.isDirectory()) {
      if (checkLines(filepath)) found = true;
    } else if (extensions.some((ext) => file.endsWith(ext))
      && file !== 'package-lock.json') {
      const content = fs.readFileSync(filepath, 'utf8');
      const lines = content.split('\n');

      lines.forEach((line, i) => {
        const isSKILLMeta = filepath.endsWith('SKILL.md') && i === 2;
        if (line.length > 100 && !isSKILLMeta) {
          console.log(`${filepath}:${i + 1}`);
          found = true;
        }
      });
    }
  }

  return found;
}

if (checkLines('.')) process.exit(1);
process.exit(0);
