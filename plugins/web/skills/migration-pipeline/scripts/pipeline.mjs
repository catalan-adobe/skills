#!/usr/bin/env node
// The pipeline CLI: setup, the steps, state. A client of migration-data: everything it
// knows is read and written through the layer. JSON on stdout, --text for people.
import { realpathSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeAccess } from './lib/access.mjs';
import { pendingSelections, workerMain as cacheWorker } from './lib/cache.mjs';
import { pending as chromePending, workerMain as chromeWorker } from './lib/chrome.mjs';
import { command as workerCommand } from './lib/worker.mjs';
import { CHECKS } from './lib/checks.mjs';
import { data } from './lib/data.mjs';
import { discover } from './lib/discover.mjs';
import { pick } from './lib/pick.mjs';
import {
  commandOnPath, defaultExec, detect, install, missingReasons, readSetupJson, sourceReasons,
  unknownSources, writeSetupJson,
} from './lib/setup.mjs';

export const COMMANDS = [
  { name: 'setup', usage: '[--install]',
    help: 'detect Node, playwright-cli, the crawler and the sibling skills; --install fixes' },
  { name: 'discover', usage: '[--strategy sitemaps|http|list] [--list <file>]',
    help: 'every URL of the site into the page table; the website summary; the proposal' },
  { name: 'access', usage: '--write',
    help: 'fold the probe recipe and the prep overlays (migration/.work/access/) into'
      + ' website/access.json' },
  { name: 'pick', usage: '[--count 2] [--exclude <group>]... [--audit 0] [--write <selection>]',
    help: 'representative uncached pages, one per largest group in turn; --write a selection' },
  { name: 'cache', usage: '[status|stop]',
    help: 'cache every approved selection not yet cached, in a detached worker; status; stop' },
  { name: 'chrome', usage: '[status|stop]',
    help: 'capture the visual trees and detect header and footer, in a worker; status; stop' },
  { name: 'website', usage: '', help: 'refresh the website summary from the table' },
  { name: 'state', usage: '[--text]', help: 'every step\'s state, computed and written' },
];
const FLAGS = {
  setup: ['--install'], discover: ['--strategy', '--list'], access: ['--write'],
  pick: ['--count', '--exclude', '--audit', '--write'], cache: ['--worker'],
  chrome: ['--worker'], website: [],
  state: ['--text'],
};
const BOOLEAN = new Set(['--install', '--text', '--write', '--worker']);
const REPEATABLE = new Set(['--exclude']);

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
    const value = rest[i + 1];
    const hasValue = value !== undefined && !value.startsWith('--');
    if (BOOLEAN.has(arg) && (!hasValue || name !== 'pick')) { flags[arg] = true; continue; }
    if (!hasValue) throw new Error(`${arg} needs a value`);
    if (REPEATABLE.has(arg)) flags[arg] = [...(flags[arg] ?? []), value];
    else flags[arg] = value;
    i += 1;
  }
  return { name, flags, positional };
}

export const usage = (only = null) => COMMANDS.filter((c) => !only || c.name === only)
  .map((c) => `  pipeline ${c.name} ${c.usage}`.trimEnd() + `\n      ${c.help}`).join('\n');

/**
 * setup: detects, installs what is missing in project scope when asked (siblings from the
 * migration's skills source), records paths and sources under migration/.work, and names
 * what is still missing or installed from elsewhere.
 */
export async function setup(cwd, { shouldInstall, exec = defaultExec, nodeVersion } = {}) {
  const { migration } = await data(cwd).catch(() => ({ migration: null }));
  const m = migration ? await migration.open(cwd).catch(() => null) : null;
  const source = m?.settings.skills ?? { repo: 'adobe/skills', ref: null };
  let detection = await detect({ cwd, home: os.homedir(), nodeVersion });
  let installs = [];
  if (shouldInstall) {
    const hasUpskill = !!(await commandOnPath('upskill'));
    installs = await install(detection, {
      exec, cwd, hasUpskill, skillsRepo: source.repo, skillsRef: source.ref ?? undefined,
    });
    detection = await detect({ cwd, home: os.homedir(), nodeVersion });
  }
  const written = await writeSetupJson(cwd, detection, { installs, source });
  const reasons = [...missingReasons(detection), ...sourceReasons(written, source)];
  const unknown = unknownSources(written);
  return { reasons, installs, unknown, setup: written };
}

export async function main(argv, cwd = process.cwd()) {
  const { name, flags, positional } = parse(argv);
  switch (name) {
    case 'setup': {
      const out = await setup(cwd, { shouldInstall: Boolean(flags['--install']) });
      if (out.reasons.length) process.exitCode = 1;
      return out;
    }
    case 'discover': {
      const out = await discover(cwd, { strategy: flags['--strategy'], list: flags['--list'] });
      await writeState(cwd);
      return out;
    }
    case 'access': {
      if (!flags['--write']) throw new Error(`access needs --write\n${usage('access')}`);
      const out = await writeAccess(cwd);
      await writeState(cwd);
      return out;
    }
    case 'pick':
      return pick(cwd, {
        count: Number(flags['--count'] ?? 2), exclude: flags['--exclude'] ?? [],
        audit: Number(flags['--audit'] ?? 0),
        write: typeof flags['--write'] === 'string' ? flags['--write'] : undefined,
      });
    case 'cache': {
      const out = await workerCommand(cwd, 'cache', positional,
        { pending: pendingSelections, worker: cacheWorker, flags });
      await writeState(cwd);
      return out;
    }
    case 'chrome': {
      const out = await workerCommand(cwd, 'chrome', positional,
        { pending: chromePending, worker: chromeWorker, flags });
      await writeState(cwd);
      return out;
    }
    case 'website': {
      const { website } = await data(cwd);
      return website.refresh(cwd);
    }
    case 'state': {
      const state = await writeState(cwd);
      const { state: stateLib } = await data(cwd);
      return flags['--text'] ? stateLib.asText(state) : state;
    }
    default:
      throw new Error(`usage:\n${usage()}`);
  }
}

/** state.json from the layer with this skill's checks. */
export async function writeState(cwd) {
  const { state } = await data(cwd);
  return state.write(cwd, CHECKS);
}

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

export { readSetupJson };
