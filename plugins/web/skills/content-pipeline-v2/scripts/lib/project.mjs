import {
  access, mkdir, readdir, readFile, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULTS = { cacheAllUpTo: 500 };

/**
 * Where a migration project lives: `<cwd>/migration/` and its step directories.
 *
 * @param {string} [cwd] Project root; defaults to the working directory.
 * @returns {{root: string, dir: string, projectFile: string, setupFile: string,
 *   statusFile: string, report: string, work: string, step: (id: string) => string}}
 */
export function resolveProject(cwd = process.cwd()) {
  const dir = path.join(cwd, 'migration');
  return {
    root: cwd,
    dir,
    projectFile: path.join(dir, 'project.json'),
    setupFile: path.join(dir, 'setup.json'),
    statusFile: path.join(dir, 'status.json'),
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
 * @param {{origin: string, skillsRepo?: string, skillsRef?: string, now?: () => string}} options
 *   `origin` is the site's root URL (or the section page that bounds the migration);
 *   `skillsRepo`/`skillsRef` say where `setup` installs the sibling skills from.
 * @param {ReturnType<typeof resolveProject>} project
 */
export async function init({
  origin, skillsRepo, skillsRef, now = () => new Date().toISOString(),
}, project) {
  if (!origin) throw new Error('init needs --origin <url>');
  new URL(origin);
  const existing = await readProject(project);
  const data = existing ?? { ...DEFAULTS, origin, created: now() };
  if (skillsRepo || skillsRef) {
    data.skills = { repo: skillsRepo ?? data.skills?.repo, ref: skillsRef ?? data.skills?.ref };
  }
  await writeProject(project, data);
  for (const step of ['probe', 'prep', 'urls', 'cache', 'capture', 'chrome', 'elements']) {
    await mkdir(project.step(step), { recursive: true });
  }
  await writeFile(path.join(project.dir, '.gitignore'),
    '.work/\ncache/.page-cache/\ncache/progress.json\ncapture/*.json\n');
  const dashboard = await installDashboard(project);
  return {
    project: project.dir, created: !existing, data, dashboard,
  };
}

/**
 * Whether this module is the script Node was started with — through a symlink too: the
 * entry path is resolved before the comparison, or a skill invoked via a symlinked
 * directory would silently do nothing.
 */
export function isMain(importMetaUrl) {
  try {
    return Boolean(process.argv[1])
      && importMetaUrl === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

const DASHBOARD_SRC = fileURLToPath(new URL('../../tools/migration/', import.meta.url));
const exists = (file) => access(file).then(() => true, () => false);

/**
 * Brings the read-only dashboard under `<root>/tools/migration/` (served locally by `aem up`
 * at `/tools/migration/`) up to the skill's copy — installed when absent, rewritten file by
 * file when the skill's differs: the dashboard is the skill's artefact, and a project
 * initialised before a panel existed would otherwise never see it. Keeps `migration/` out
 * of the deployment by adding it to an existing `.hlxignore` once; no `.hlxignore` is
 * created where none exists.
 *
 * @returns {Promise<{installed: boolean, updated: string[], path: string}>} `installed`
 *   when there was no dashboard; `updated` names the files rewritten.
 */
export async function installDashboard(project) {
  const dest = path.join(project.root, 'tools', 'migration');
  const installed = !(await exists(dest));
  await mkdir(dest, { recursive: true });
  const updated = [];
  for (const name of await readdir(DASHBOARD_SRC)) {
    const wanted = await readFile(path.join(DASHBOARD_SRC, name), 'utf8');
    const current = await readFile(path.join(dest, name), 'utf8').catch(() => null);
    if (current !== wanted) {
      await writeFile(path.join(dest, name), wanted);
      if (!installed) updated.push(name);
    }
  }
  const hlxignore = path.join(project.root, '.hlxignore');
  if (await exists(hlxignore)) {
    const text = await readFile(hlxignore, 'utf8');
    if (!text.split('\n').some((l) => l.trim() === 'migration/')) {
      await writeFile(hlxignore, `${text.replace(/\n*$/, '')}\nmigration/\n`);
    }
  }
  return { installed, updated, path: 'tools/migration' };
}

const REPORT_TITLE = '# Migration report';

/**
 * Writes the `## <id>` section of `migration/REPORT.md`: replaces the existing one in place
 * or appends it, so a step re-run never leaves two sections behind. Creates the file with its
 * title when absent.
 *
 * @param {ReturnType<typeof resolveProject>} project
 * @param {string} id Step id.
 * @param {string} body Section body, without the heading.
 */
export async function upsertSection(project, id, body) {
  const current = await readFile(project.report, 'utf8').catch(() => `${REPORT_TITLE}\n`);
  const text = body.trim().replace(new RegExp(`^##\\s+${id}\\s*\\n+`), '');
  const section = `## ${id}\n\n${text}\n`;
  const heading = new RegExp(`^## ${id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[ \\t]*$`, 'm');
  const lines = current.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  let next;
  if (start < 0) {
    next = `${current.replace(/\n*$/, '')}\n\n${section}`;
  } else {
    let end = start + 1;
    while (end < lines.length && !/^## /.test(lines[end])) end += 1;
    const before = lines.slice(0, start).join('\n').replace(/\n*$/, '');
    const after = lines.slice(end).join('\n').replace(/^\n*/, '');
    next = `${before}\n\n${section}${after ? `\n${after}` : ''}`;
  }
  await mkdir(project.dir, { recursive: true });
  await writeFile(project.report, next);
}
