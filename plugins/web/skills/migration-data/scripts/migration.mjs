#!/usr/bin/env node
// The migration data CLI: one client of the layer among others. JSON on stdout by default;
// --text for people; errors on stderr, exit 1. Run from the folder holding migration/.
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as bands from './lib/bands.mjs';
import * as elements from './lib/elements.mjs';
import * as inventory from './lib/inventory.mjs';
import * as migration from './lib/migration.mjs';
import * as notes from './lib/notes.mjs';
import * as pages from './lib/pages.mjs';
import * as runs from './lib/runs.mjs';
import * as selections from './lib/selections.mjs';
import * as state from './lib/state.mjs';
import * as verdicts from './lib/verdicts.mjs';
import * as views from './lib/views.mjs';
import * as website from './lib/website.mjs';

export const COMMANDS = [
  { name: 'init', usage: '--origin <url> [--scope <url>] [--pages <n>] [--target-repo <path>]'
    + ' [--skills-repo <owner/repo>] [--skills-ref <ref>]',
    help: 'create migration/migration.json; once' },
  { name: 'show', usage: '', help: 'the migration file' },
  { name: 'plan', usage: '[--pages <n>] [--selection <name>]', help: 'how much to migrate' },
  { name: 'setting', usage: '<name> <value>',
    help: 'change one setting: pace, sessions, captureMinWidth, cacheAllUpTo' },
  { name: 'assets', usage: '<origin>...',
    help: 'the other origins whose assets the pages use; the cache stores them too' },
  { name: 'approve', usage: '<step> [<selection>...]',
    help: 'the operator\'s yes at a gate: selections for cache, bare for the others' },
  { name: 'runs', usage: '[--step <id>]', help: 'every run, oldest first' },
  { name: 'state', usage: '[--text]', help: 'every step\'s state, computed and written' },
  { name: 'pages', usage: '[--group <g>] [--status in|out|undecided] [--reason <code>]'
    + ' [--cached] [--uncached] [--fragment <frg-id>] [--text]',
    help: 'the page table, filtered; --text as a list' },
  { name: 'page', usage: '<id-or-url>', help: 'one page record' },
  { name: 'decide-page', usage: '<id-or-url> in|out <reason...>',
    help: 'the operator\'s word on a page' },
  { name: 'selections', usage: '', help: 'every selection' },
  { name: 'website', usage: '', help: 'the website summary, refreshed from the table' },
  { name: 'access', usage: 'overlay <selector> hide|click|remove [--note <text>]',
    help: 'add an overlay rule to the access decision' },
  { name: 'types', usage: '[--undecided]', help: 'the element types, or the ones to decide' },
  { name: 'decide-type', usage: '<typ-id> <kind> [<name-or-style>] [--notes <text>]',
    help: 'what a type is: section|block|default-content|fragment|wrapper|skip' },
  { name: 'inventory', usage: '', help: 'the EDS reading of the site, derived and written' },
  { name: 'note', usage: '<step> <author> <text...> [--page <pag-id>]', help: 'add a note' },
  { name: 'notes', usage: '[--step <id>]', help: 'the notes index' },
  { name: 'report', usage: '[--html]', help: 'render views/report.md, or views/report.html' },
  { name: 'annotate', usage: '<selection>',
    help: 'render the annotation sheet for a selection: views/annotate-<selection>.html' },
  { name: 'verdicts', usage: '[import <file.json>]',
    help: 'the verdicts on pages; import what an annotation sheet exported' },
  { name: 'annotate-bands', usage: '<selection>',
    help: 'render the band correction sheet: views/annotate-bands-<selection>.html' },
  { name: 'band-verdicts', usage: '[import <file.json>]',
    help: 'the verdicts on bands; import what a band sheet exported' },
];

const FLAGS = {
  init: ['--origin', '--scope', '--pages', '--target-repo', '--skills-repo', '--skills-ref'],
  show: [], plan: ['--pages', '--selection'], setting: [], assets: [], approve: [],
  runs: ['--step'],
  state: ['--text'],
  pages: ['--group', '--status', '--reason', '--cached', '--uncached', '--fragment', '--text'],
  page: [], 'decide-page': [], selections: [], website: [], types: ['--undecided'],
  'decide-type': ['--notes'], inventory: [], note: ['--page'], notes: ['--step'],
  access: ['--note'],
  report: ['--html'], annotate: [], verdicts: [], 'annotate-bands': [], 'band-verdicts': [],
};
const BOOLEAN = new Set(['--text', '--cached', '--uncached', '--undecided', '--html']);

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
    case 'setting': {
      const [name, value] = positional;
      if (!name || value === undefined) throw new Error('usage: setting <name> <value>');
      return migration.setting(cwd, name, /^\d+$/.test(value) ? Number(value) : value);
    }
    case 'assets':
      if (!positional.length) throw new Error('usage: assets <origin>...');
      return migration.assetOrigins(cwd, positional);
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
    case 'pages': {
      const list = await pages.list(cwd, {
        group: flags['--group'], status: flags['--status'], reason: flags['--reason'],
        cached: flags['--cached'] ? true : flags['--uncached'] ? false : undefined,
        fragment: flags['--fragment'],
      });
      return flags['--text']
        ? list.map((p) => `${p.verdict.status.padEnd(9)} ${p.kind.padEnd(11)} ${p.url}`).join('\n')
          || 'no page matches'
        : list;
    }
    case 'page': {
      const page = positional[0] && await pages.get(cwd, positional[0]);
      if (!page) throw new Error(`no page ${positional[0] ?? ''}\n${usage('page')}`);
      return page;
    }
    case 'decide-page': {
      const [which, status, ...why] = positional;
      if (!which || !['in', 'out'].includes(status) || !why.length) {
        throw new Error(`decide-page needs a page, in or out, and the reason\n${
          usage('decide-page')}`);
      }
      return pages.decide(cwd, which, status, why.join(' '));
    }
    case 'selections':
      return selections.list(cwd);
    case 'website':
      return website.refresh(cwd);
    case 'access': {
      const [verb, selector, action] = positional;
      if (verb !== 'overlay') throw new Error('usage: access overlay <selector> <action>');
      return website.addOverlay(cwd, { selector, action, note: flags['--note'] });
    }
    case 'types': {
      if (flags['--undecided']) return elements.undecided(cwd);
      const types = await elements.readTypes(cwd);
      if (!types) throw new Error('no elements/types.json yet; a decomposition method writes it');
      return types;
    }
    case 'decide-type': {
      const [id, kind, value] = positional;
      if (!id || !kind) {
        throw new Error(`decide-type needs a type and a kind\n${usage('decide-type')}`);
      }
      const field = { block: 'block', fragment: 'fragment', section: 'style' }[kind];
      const what = { kind, ...(field && value !== undefined ? { [field]: value } : {}),
        ...(kind === 'section' && value === undefined ? { style: null } : {}),
        ...(flags['--notes'] ? { notes: flags['--notes'] } : {}) };
      return elements.decide(cwd, id, what);
    }
    case 'inventory':
      return inventory.write(cwd);
    case 'note': {
      const [step, author, ...text] = positional;
      if (!step || !author || !text.length) {
        throw new Error(`note needs a step, an author and text\n${usage('note')}`);
      }
      return notes.add(cwd, { step, author, body: text.join(' '), page: flags['--page'] });
    }
    case 'notes':
      return notes.list(cwd, { step: flags['--step'] });
    case 'report':
      return views.writeReport(cwd, { html: Boolean(flags['--html']) });
    case 'annotate':
      if (!positional[0]) throw new Error('usage: annotate <selection>');
      return views.writeAnnotate(cwd, positional[0]);
    case 'annotate-bands':
      if (!positional[0]) throw new Error('usage: annotate-bands <selection>');
      return views.writeAnnotateBands(cwd, positional[0]);
    case 'band-verdicts': {
      if (positional[0] === 'import') {
        if (!positional[1]) throw new Error('usage: band-verdicts import <file.json>');
        return bands.importVerdicts(cwd, JSON.parse(await readFile(positional[1], 'utf8')));
      }
      return (await bands.readVerdicts(cwd)) ?? { verdicts: [] };
    }
    case 'verdicts': {
      if (positional[0] === 'import') {
        const file = positional[1];
        if (!file) throw new Error('usage: verdicts import <file.json>');
        return verdicts.importFile(cwd, JSON.parse(await readFile(file, 'utf8')));
      }
      return (await verdicts.read(cwd)) ?? { verdicts: [] };
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
