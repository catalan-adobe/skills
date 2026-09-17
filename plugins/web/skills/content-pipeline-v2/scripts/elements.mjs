#!/usr/bin/env node
// The elements step: decomposes every captured page into sections, resolves them to element
// types and writes migration/elements/ — in the foreground, in seconds.
// Usage: node elements.mjs   (from the project root)
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { renderSection, writeElements } from './lib/elements-report.mjs';
import { resolveProject } from './lib/project.mjs';

export const HELP = `elements.mjs
    decompose every captured page over the visual-tree store, merge with the previous run
    and write elements/elements.json, elements.md and the report section`;

export async function main(argv, project) {
  if (argv.includes('--help') || argv[0] === 'help') return HELP;
  await mkdir(project.step('elements'), { recursive: true });
  return renderSection(await writeElements(project));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), resolveProject())
    .then((out) => console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2)))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
