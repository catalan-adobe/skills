import { access, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const execFileP = promisify(execFile);

/** The sibling skills `setup` installs into the project when they are missing. */
export const SKILL_NAMES = ['browser-probe', 'page-prep', 'site-scan', 'page-cache'];

/** Real `exec`: runs a file with args, resolving on success and rejecting on a bad exit. */
export const defaultExec = (file, args, options) => execFileP(file, args, options);

async function defaultExists(file) {
  return access(file).then(() => true, () => false);
}

/** The first of `candidates` (absolute paths) that exists, or `null`. */
async function firstExisting(candidates, exists) {
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await exists(candidate)) return candidate;
  }
  return null;
}

/**
 * The first directory on `PATH` that has a file named `name`, or `null`.
 *
 * @param {string} name
 * @param {{env?: NodeJS.ProcessEnv, exists?: (file: string) => Promise<boolean>}} [options]
 * @returns {Promise<string|null>}
 */
export async function commandOnPath(name, { env = process.env, exists = defaultExists } = {}) {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return firstExisting(dirs.map((dir) => path.join(dir, name)), exists);
}

function workDir(cwd) {
  return path.join(cwd, 'migration', '.work', 'node_modules');
}

function nodeStatus(version) {
  const major = Number(version.split('.')[0]);
  return { ok: major >= 22, version };
}

async function skillPaths(name, cwd, home, exists) {
  const skillPath = await firstExisting([
    path.join(cwd, '.agents', 'skills', name, 'SKILL.md'),
    path.join(cwd, '.claude', 'skills', name, 'SKILL.md'),
    path.join(home, '.agents', 'skills', name, 'SKILL.md'),
  ], exists);
  return { ok: !!skillPath, path: skillPath };
}

/**
 * Detects every precondition the `setup` step cares about: Node, `playwright-cli`, the
 * `franklin-bulk-shared` package and the sibling skills. Read-only; nothing is installed.
 *
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string, home?: string,
 *   exists?: (file: string) => Promise<boolean>, nodeVersion?: string}} [options] `exec` is
 *   accepted and ignored; detection never runs a command. `nodeVersion` defaults to the
 *   running Node's own version; pass a different string only to test the Node < 22 path.
 * @returns {Promise<{node: {ok: boolean, version: string},
 *   playwrightCli: {ok: boolean, path: string|null},
 *   packages: {'franklin-bulk-shared': {ok: boolean, path: string|null}},
 *   skills: Record<string, {ok: boolean, path: string|null}>}>}
 */
export async function detect({
  env = process.env, cwd = process.cwd(), home = os.homedir(), exists = defaultExists,
  nodeVersion = process.versions.node,
} = {}) {
  const work = workDir(cwd);
  let playwrightPath = await commandOnPath('playwright-cli', { env, exists });
  if (!playwrightPath) {
    const projectBin = path.join(work, '.bin', 'playwright-cli');
    if (await exists(projectBin)) playwrightPath = projectBin;
  }
  const packagePath = path.join(work, 'franklin-bulk-shared', 'package.json');
  const packageOk = await exists(packagePath);

  const skills = {};
  for (const name of SKILL_NAMES) {
    // eslint-disable-next-line no-await-in-loop
    skills[name] = await skillPaths(name, cwd, home, exists);
  }

  return {
    node: nodeStatus(nodeVersion),
    playwrightCli: { ok: !!playwrightPath, path: playwrightPath },
    packages: { 'franklin-bulk-shared': { ok: packageOk, path: packageOk ? packagePath : null } },
    skills,
  };
}

/** Human-readable reasons for everything in a `detect()` result that is not ok yet. */
export function missingReasons(detection) {
  const reasons = [];
  if (!detection.node.ok) reasons.push('install Node >= 22; nothing else can proceed');
  if (!detection.playwrightCli.ok) reasons.push('playwright-cli not found');
  for (const [name, info] of Object.entries(detection.packages)) {
    if (!info.ok) reasons.push(`package ${name} not found`);
  }
  for (const [name, info] of Object.entries(detection.skills)) {
    if (!info.ok) reasons.push(`skill ${name} not found`);
  }
  return reasons;
}

async function runInstall(exec, file, args, options) {
  try {
    await exec(file, args, options);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Installs, in project scope only, whatever `detect()` found missing. Never touches Node
 * (it cannot be installed) and never runs a global install.
 *
 * The caller decides `hasUpskill` (usually via `commandOnPath('upskill')`) rather than
 * `install` probing for it itself, so the same lookup can be reused for the CLI's own
 * `upskill` detection and so tests can force either branch without touching `PATH`.
 *
 * @param {Awaited<ReturnType<typeof detect>>} detection
 * @param {{exec: (file: string, args: string[], options?: object) =>
 *   Promise<unknown>, cwd: string, hasUpskill: boolean}} options `cwd` is the project root;
 *   `hasUpskill` says whether the `upskill` command is on `PATH`.
 * @returns {Promise<{target: string, command: string[], ok: boolean, error?: string}[]>}
 */
export async function install(detection, { exec, cwd, hasUpskill }) {
  if (!detection.node.ok) {
    return [{
      target: 'node', command: [], ok: false, error: 'install Node >= 22; nothing else can proceed',
    }];
  }

  const work = path.join(cwd, 'migration', '.work');
  const results = [];

  if (!detection.playwrightCli.ok) {
    const args = ['install', '--prefix', work, '@playwright/cli'];
    const outcome = await runInstall(exec, 'npm', args);
    results.push({ target: 'playwrightCli', command: ['npm', ...args], ...outcome });
  }

  if (!detection.packages['franklin-bulk-shared'].ok) {
    const args = ['install', '--prefix', work, 'franklin-bulk-shared'];
    const outcome = await runInstall(exec, 'npm', args);
    results.push({ target: 'franklin-bulk-shared', command: ['npm', ...args], ...outcome });
  }

  for (const [name, info] of Object.entries(detection.skills)) {
    if (info.ok) continue;
    const skillArgs = ['adobe/skills', '--path', 'plugins/web/skills', '--skill', name];
    const file = hasUpskill ? 'upskill' : 'npx';
    const args = hasUpskill ? skillArgs : ['-y', 'upskill', ...skillArgs];
    // eslint-disable-next-line no-await-in-loop
    const outcome = await runInstall(exec, file, args, { cwd });
    results.push({ target: `skill:${name}`, command: [file, ...args], ...outcome });
  }

  return results;
}

/** Writes `migration/setup.json` with the resolved paths from a `detect()` result. */
export async function writeSetupJson(project, detection) {
  await mkdir(project.dir, { recursive: true });
  await writeFile(project.setupFile, `${JSON.stringify(detection, null, 2)}\n`);
  return detection;
}
