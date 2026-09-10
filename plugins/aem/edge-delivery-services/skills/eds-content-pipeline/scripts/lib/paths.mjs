// paths.mjs
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Walks up from `start` to the first directory holding
 * `migration/site.config.json`.
 */
function findProjectDir(start) {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(
      dir,
      'migration',
      'site.config.json'
    );
    if (existsSync(candidate)) return path.dirname(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolves every filesystem location the runners use.
 *
 * The skill is stateless: `skillRoot` is where this code lives,
 * `projectDir` is `<eds-repo>/migration`, found by walking up from
 * `cwd` or given as `MIGRATION_PROJECT_DIR`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [cwd]
 * @returns {{repoRoot: string, projectDir: string, dataDir: string,
 *   siteDir: string, configPath: string, cacheDir: string,
 *   docsDir: string, skillRoot: string,
 *   stateFile: (name: string) => string,
 *   ledgerFile: (name: string) => string}}
 */
export function resolvePaths(env = process.env, cwd = process.cwd()) {
  const skillRoot = path.resolve(here, '..', '..');
  const projectDir = env.MIGRATION_PROJECT_DIR
    ? path.resolve(env.MIGRATION_PROJECT_DIR)
    : findProjectDir(cwd);
  const repoRoot = projectDir
    ? path.dirname(projectDir)
    : path.resolve(cwd);
  const dataDir = env.MIGRATION_DATA_DIR
    ? path.resolve(env.MIGRATION_DATA_DIR)
    : path.join(projectDir ?? repoRoot, 'data');
  const siteDir = projectDir ?? repoRoot;
  return {
    repoRoot,
    projectDir: siteDir,
    dataDir,
    siteDir,
    configPath: env.MIGRATION_CONFIG
      ? path.resolve(env.MIGRATION_CONFIG)
      : path.join(siteDir, 'site.config.json'),
    cacheDir: env.MIGRATION_CACHE_DIR
      ? path.resolve(env.MIGRATION_CACHE_DIR)
      : path.join(repoRoot, '.migration-cache'),
    docsDir: siteDir,
    skillRoot,
    stateFile: (name) => path.join(dataDir, `${name}.json`),
    ledgerFile: (name) =>
      path.join(dataDir, 'ledger', `${name}.jsonl`),
  };
}
