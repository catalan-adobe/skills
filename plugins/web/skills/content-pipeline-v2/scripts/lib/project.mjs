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
  await writeFile(path.join(project.dir, '.gitignore'), '.work/\ncache/.page-cache/\n');
  return { project: project.dir, created: !existing, data };
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
