#!/usr/bin/env node
// The mapping step: seeds mapping/mapping.json with every recurring type (kind null),
// validates the decisions, derives the block inventory (mapping/inventory.json,
// mapping.md) and writes the report section. Synchronous; run it after every edit.
// Usage: node mapping.mjs   (from the project root)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { elementsJson } from './lib/elements-report.mjs';
import {
  deriveInventory, renderMappingMd, seedMapping, shortHash, validateMapping,
} from './lib/mapping.mjs';
import { isMain, resolveProject, upsertSection } from './lib/project.mjs';

export const HELP = `mapping.mjs
    seed mapping/mapping.json with the recurring types, validate the decisions, write the
    block inventory (mapping/inventory.json, mapping.md) and the report section`;

export const mappingFile = (project) => path.join(project.step('mapping'), 'mapping.json');
export const inventoryFile = (project) => path.join(project.step('mapping'), 'inventory.json');

/** Reads mapping.json; a missing file is an empty one, a broken one names its fix. */
async function readMapping(file) {
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return { types: {} };
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}); fix it and rerun mapping.mjs`);
  }
}

export async function main(argv, project) {
  if (argv.includes('--help') || argv.includes('-h')) return HELP;
  const elementsText = await readFile(elementsJson(project), 'utf8').catch(() => null);
  if (elementsText === null) {
    throw new Error('elements/elements.json missing; run elements.mjs first');
  }
  const elements = JSON.parse(elementsText);
  await mkdir(project.step('mapping'), { recursive: true });
  const mapping = seedMapping(elements, await readMapping(mappingFile(project)));
  const reasons = validateMapping(mapping);
  if (reasons.length) {
    throw new Error(`mapping/mapping.json:\n- ${reasons.join('\n- ')}`);
  }
  const mappingText = `${JSON.stringify(mapping, null, 2)}\n`;
  await writeFile(mappingFile(project), mappingText);
  const inventory = {
    ...deriveInventory(elements, mapping),
    mappingHash: shortHash(mappingText), elementsHash: shortHash(elementsText),
  };
  await writeFile(inventoryFile(project), `${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(path.join(project.step('mapping'), 'mapping.md'),
    renderMappingMd(inventory, elements));
  await upsertSection(project, 'mapping', renderSection(inventory));
  return {
    blocks: inventory.blocks.length, defaultContent: inventory.defaultContent.types.length,
    skipped: inventory.skipped.length, undecided: inventory.undecided.length,
    orphaned: inventory.orphaned.length, coverage: inventory.coverage.covered,
    pages: inventory.coverage.pages,
  };
}

/** The `## mapping` body: the inventory in three lines. */
export function renderSection(inv) {
  const top = inv.blocks.slice(0, 8).map((b) => `${b.name} (${b.pages})`).join(', ');
  return [
    `${inv.blocks.length} blocks from ${inv.blocks.reduce((n, b) => n + b.types.length, 0)}`
      + ` types; ${inv.defaultContent.types.length} default content types`
      + ` (${inv.defaultContent.instances} instances); ${inv.skipped.length} skipped.`,
    `Coverage: ${inv.coverage.covered} of ${inv.coverage.pages} pages have every section`
      + ' mapped.' + (inv.undecided.length ? ` ${inv.undecided.length} types undecided.` : '')
      + (inv.orphaned.length ? ` ${inv.orphaned.length} orphaned decisions.` : ''),
    top ? `Blocks by pages: ${top}.` : 'No block yet.',
  ].join('\n');
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2), resolveProject())
    .then((out) => console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2)))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
