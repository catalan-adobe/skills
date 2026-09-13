import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULTS = { cacheAllUpTo: 500 };

/**
 * Where a migration project lives: `<cwd>/migration/` and its step directories.
 *
 * @param {string} [cwd] Project root; defaults to the working directory.
 * @returns {{root: string, dir: string, projectFile: string, setupFile: string,
 *   report: string, work: string, step: (id: string) => string}}
 */
export function resolveProject(cwd = process.cwd()) {
  const dir = path.join(cwd, 'migration');
  return {
    root: cwd,
    dir,
    projectFile: path.join(dir, 'project.json'),
    setupFile: path.join(dir, 'setup.json'),
    report: path.join(dir, 'REPORT.md'),
    work: path.join(dir, '.work'),
    step: (id) => path.join(dir, id),
  };
}

/** Reads `project.json`; `null` when the project was never initialised. */
export async function readProject(project) {
  const text = await readFile(project.projectFile, 'utf8').catch(() => null);
  if (text === null) return null;
  try {
    return { ...DEFAULTS, ...JSON.parse(text) };
  } catch (err) {
    throw new Error(`${project.projectFile} is not valid JSON (${err.message}); fix or delete it`);
  }
}

export async function writeProject(project, data) {
  await mkdir(project.dir, { recursive: true });
  await writeFile(project.projectFile, `${JSON.stringify(data, null, 2)}\n`);
  return data;
}

/**
 * Creates `migration/` with `project.json` and a `.gitignore` for scratch and cache data.
 * Re-running keeps an existing project.json untouched.
 *
 * @param {{origin: string, now?: () => string}} options `origin` is the site's root URL.
 * @param {ReturnType<typeof resolveProject>} project
 */
export async function init({ origin, now = () => new Date().toISOString() }, project) {
  if (!origin) throw new Error('init needs --origin <url>');
  new URL(origin);
  const existing = await readProject(project);
  const data = existing ?? { ...DEFAULTS, origin, created: now() };
  await writeProject(project, data);
  await writeFile(path.join(project.dir, '.gitignore'), '.work/\ncache/.page-cache/\n');
  return { project: project.dir, created: !existing, data };
}
