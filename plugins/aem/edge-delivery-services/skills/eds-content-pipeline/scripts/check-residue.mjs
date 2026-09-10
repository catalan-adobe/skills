#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const pattern =
  /knack|test-f51|catalan-adobe|eds-migration-test|kingdom-air|contentCntr|hobsons/i;

function checkResidue(dir, basePath = dir) {
  const files = fs.readdirSync(dir);
  let found = false;

  for (const file of files) {
    if (file === 'node_modules') continue;

    const filepath = path.join(dir, file);
    const stat = fs.statSync(filepath);

    if (stat.isDirectory()) {
      if (checkResidue(filepath, basePath)) found = true;
    } else if (
      file.endsWith('.mjs') ||
      file.endsWith('.md') ||
      file.endsWith('.json') ||
      file.endsWith('.yaml')
    ) {
      if (file === 'package.json' || file === 'check-residue.mjs'
        || file === 'check-lines.mjs') continue;
      const content = fs.readFileSync(filepath, 'utf8');
      if (pattern.test(content)) {
        console.log(`${filepath}: contains residue`);
        found = true;
      }
    }
  }

  return found;
}

if (checkResidue('.')) process.exit(1);
process.exit(0);
