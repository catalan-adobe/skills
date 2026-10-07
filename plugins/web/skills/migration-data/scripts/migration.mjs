#!/usr/bin/env node
// The migration data CLI: one client of the layer among others. JSON on stdout by default;
// --text for people; errors on stderr, exit 1. Run from the folder holding migration/.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as migration from './lib/migration.mjs';
import * as runs from './lib/runs.mjs';
import * as state from './lib/state.mjs';

export const COMMANDS = [
  { name: 'init', usage: '--origin <url> [--scope <url>] [--pages <n>] [--target-repo <path>]'
    + ' [--skills-repo <owner/repo>] [--skills-ref <ref>]',
    help: 'create migration/migration.json; once' },
  { name: 'show', usage: '', help: 'the migration file' },
  { name: 'plan', usage: '[--pages <n>] [--selection <name>]', help: 'how much to migrate' },
  { name: 'approve', usage: '<step> [<selection>...]',
    help: 'the operator\'s yes at a gate: selections for cache, bare for the others' },
  { name: 'runs', usage: '[--step <id>]', help: 'every run, oldest first' },
  { name: 'state', usage: '[--text]', help: 'every step\'s state, computed and written' },
];

const FLAGS = {
  init: ['--origin', '--scope', '--pages', '--target-repo', '--skills-repo', '--skills-ref'],
  show: [], plan: ['--pages', '--selection'], approve: [], runs: ['--step'], state: ['--text'],
};
const BOOLEAN = new Set(['--text']);

export function parse(argv) {
  const [name, ...rest] = argv;
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) throw new Error(`usage:\n${usage()}`);
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    if (!FLAGS[name].includes(arg)) throw new Error(`${name}: unknown flag ${arg}\n${usage(name)}`);
    if (BOOLEAN.has(arg)) { flags[arg] = true; continue; }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
    flags[arg] = value;
    i += 1;
  }
  return { name, flags, positional };
}

export const usage = (only = null) => COMMANDS.filter((c) => !only || c.name === only)
  .map((c) => `  migration ${c.name} ${c.usage}`.trimEnd() + `\n      ${c.help}`).join('\n');

const integer = (flag, value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a whole number >= 1`);
  return n;
};

export async function main(argv, cwd = process.cwd()) {
  const { name, flags, positional } = parse(argv);
  switch (name) {
    case 'init':
      return migration.init(cwd, {
        origin: flags['--origin'],
        scope: flags['--scope'],
        target: flags['--target-repo'] ? { repo: flags['--target-repo'] } : {},
        plan: flags['--pages'] ? { pages: integer('--pages', flags['--pages']) } : {},
        settings: (flags['--skills-repo'] || flags['--skills-ref']) ? { skills: {
          ...(flags['--skills-repo'] ? { repo: flags['--skills-repo'] } : {}),
          ...(flags['--skills-ref'] ? { ref: flags['--skills-ref'] } : {}),
        } } : {},
      });
    case 'show':
      return migration.open(cwd);
    case 'plan':
      return migration.plan(cwd, {
        ...(flags['--pages'] ? { pages: integer('--pages', flags['--pages']) } : {}),
        ...(flags['--selection'] ? { selection: flags['--selection'] } : {}),
      });
    case 'approve': {
      const [step, ...selections] = positional;
      if (!step) throw new Error(`approve needs a step\n${usage('approve')}`);
      return migration.approve(cwd, step, selections.length ? selections : true);
    }
    case 'runs':
      return runs.list(cwd, { step: flags['--step'] });
    case 'state': {
      const written = await state.write(cwd);
      return flags['--text'] ? state.asText(written) : written;
    }
    default:
      throw new Error(`usage:\n${usage()}`);
  }
}

/** True when this file is the entry point, through a symlink too. */
export function isMain(url) {
  try {
    return realpathSync(fileURLToPath(url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2))
    .then((out) => console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2)))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
