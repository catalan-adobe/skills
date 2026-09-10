import { execFile } from 'node:child_process';
import {
  access, appendFile, mkdir, readFile, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { flag } from './args.mjs';
import { loadToken } from './da.mjs';

const execFileP = promisify(execFile);
const exists = (p) => access(p).then(() => true, () => false);
const PAGE_TREE = '.agents/skills/page-tree/scripts/page-tree-bundle.js';
const SCRIPTS_DIR = path.resolve(import.meta.dirname, '..');

/** True when the runners' npm dependencies are installed next to this file. */
async function depsInstalled() {
  try {
    await import('jsdom');
    return true;
  } catch {
    return false;
  }
}

async function whichBinary(name) {
  try {
    return (await execFileP('which', [name])).stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Runs every precondition; never throws.
 *
 * @param {string} repoRoot The repository root path.
 * @param {object} [options] Options for testing.
 * @param {object} [options.env] Environment variables (not used).
 * @param {Function} [options.which] Function to find binaries on PATH.
 * @param {Function} [options.token] Function to load DA token.
 * @param {Function} [options.deps] Function reporting whether the runners' dependencies are
 *   installed.
 * @returns {Promise<Array>} Array of checks with name, ok, and hint.
 */
export async function checkPreconditions(
  repoRoot,
  { which = whichBinary, token = loadToken, deps = depsInstalled } = {},
) {
  const eds = (await exists(path.join(repoRoot, 'scripts', 'aem.js')))
    && (await exists(path.join(repoRoot, 'head.html')));
  const tree = await exists(path.join(repoRoot, PAGE_TREE));
  const pw = await which('playwright-cli');
  let da = true;
  try {
    await token();
  } catch {
    da = false;
  }
  const installed = await deps();
  return [
    {
      name: 'runner-deps',
      ok: installed,
      hint: `run: npm install --prefix ${SCRIPTS_DIR}`,
    },
    {
      name: 'eds-repo',
      ok: eds,
      hint: 'run inside an Edge Delivery Services repository '
        + '(scripts/aem.js, head.html)',
    },
    {
      name: 'page-tree',
      ok: tree,
      hint: 'upskill adobe/skills --path plugins/web/skills '
        + '--skill page-tree',
    },
    {
      name: 'playwright-cli',
      ok: Boolean(pw),
      hint: 'install playwright-cli and put it on PATH',
    },
    {
      name: 'da-token',
      ok: da,
      hint: 'obtain a DA token with the da-auth skill',
    },
  ];
}

function defaultConfig({
  origin, sitemap, daOrg, daSite, daRef = 'main', include = [],
}) {
  return {
    origin,
    sitemapIndex: sitemap,
    include,
    exclusions: { queryStrings: true, pathPatterns: [] },
    overlaySelectors: [],
    viewports: { desktop: [1440, 900] },
    concurrency: { fetch: 2, browser: 1, da: 2 },
    rateLimit: { requestsPerSecond: 2 },
    thresholds: {
      clusterSimilarity: 0.8,
      minClusterSize: 5,
      representativesPerTemplate: 3,
      coverage: 0.95,
      fidelity: { recall: 0.9, precision: 0.95 },
      newTemplateMin: 5,
    },
    bundles: { pageTree: PAGE_TREE },
    templateSeeds: {},
    da: {
      org: daOrg,
      site: daSite,
      ref: daRef,
      adminHost: 'https://admin.hlx.page',
      sourceHost: 'https://admin.da.live',
    },
    templates: {},
  };
}

/**
 * Creates `migration/` and its config; safe to re-run.
 *
 * @param {string} repoRoot The repository root path.
 * @param {object} options Configuration options.
 * @param {string} options.origin The website origin URL.
 * @param {string} options.sitemap The sitemap URL.
 * @param {string} options.daOrg DA organization.
 * @param {string} options.daSite DA site.
 * @param {string} [options.daRef] DA git ref (default: main).
 * @param {string[]} [options.include] Include patterns for URLs.
 * @returns {Promise<object>} Object with created file paths.
 */
export async function writeProject(repoRoot, options) {
  const created = [];
  const dirs = [
    'data', 'data/ledger', 'transformers', 'rules',
    'fixtures', 'templates', 'reports',
  ];
  for (const d of dirs) {
    await mkdir(path.join(repoRoot, 'migration', d), {
      recursive: true,
    });
  }
  const config = path.join(repoRoot, 'migration', 'site.config.json');
  if (!(await exists(config))) {
    const content = `${JSON.stringify(
      defaultConfig(options),
      null,
      2,
    )}\n`;
    await writeFile(config, content);
    created.push('migration/site.config.json');
  }
  const learnings = path.join(repoRoot, 'migration', 'LEARNINGS.md');
  if (!(await exists(learnings))) {
    const content = '# Learnings\n\n'
      + 'Append-only. One entry per failure class or operator '
      + 'correction, tagged `generic` or `project`.\n';
    await writeFile(learnings, content);
    created.push('migration/LEARNINGS.md');
  }
  const ignore = path.join(repoRoot, '.hlxignore');
  const current = await readFile(ignore, 'utf8').catch(() => '');
  if (!current.split('\n').includes('migration/')) {
    const line = `${current && !current.endsWith('\n') ? '\n' : ''}migration/\n`;
    await appendFile(ignore, line);
    created.push('.hlxignore');
  }
  return { created };
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const argv = process.argv.slice(2);
  const repoRoot = process.cwd();
  const options = {
    origin: flag(argv, '--origin'),
    sitemap: flag(argv, '--sitemap'),
    daOrg: flag(argv, '--da-org'),
    daSite: flag(argv, '--da-site'),
    daRef: flag(argv, '--da-ref', 'main'),
    include: argv.flatMap(
      (a, i) => (a === '--include' ? [argv[i + 1]] : []),
    ),
  };
  for (const k of ['origin', 'sitemap', 'daOrg', 'daSite']) {
    if (!options[k]) {
      const usage = 'Usage: init.mjs --origin <url> --sitemap <url> '
        + '--da-org <o> --da-site <s> [--da-ref main] '
        + '[--include <regex>]... [--skip-checks]\n';
      process.stderr.write(usage);
      process.exit(1);
    }
  }
  const checks = argv.includes('--skip-checks')
    ? []
    : await checkPreconditions(repoRoot);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    const msg = `${failed.map((c) => `- ${c.name}: ${c.hint}`).join('\n')}\n`;
    process.stderr.write(msg);
    process.exit(2);
  }
  const result = await writeProject(repoRoot, options);
  process.stdout.write(`${JSON.stringify({ ...result, checks })}\n`);
}
