#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAllChecks, runCheck } from './lib/checks.mjs';
import { dashboard, stopDashboard } from './lib/dashboard.mjs';
import { freePort } from './lib/ports.mjs';
import {
  init, readProject, resolveProject, upsertSection, writeProject,
} from './lib/project.mjs';
import {
  fromList, mergeScan, normalise, readInventory, writeInventory,
} from './lib/inventory.mjs';
import { stepById, stepStates } from './lib/steps.mjs';
import {
  distribution, pick, proposal, renderUrlsMd, writeSubset, writeSubsets,
} from './lib/urls.mjs';
import {
  commandOnPath, defaultExec, detect, install, missingReasons, writeSetupJson,
} from './lib/setup.mjs';

const USAGE = `status.mjs [--text]              every step: done|ready|blocked|waiting-operator
status.mjs check <step>          the step's done-check; exit 1 when it fails
status.mjs init --origin <url> [--skills-repo <owner/repo>] [--skills-ref <branch>]
                                 create migration/ and project.json
status.mjs approve <step> [<subset>...]
                                  record the operator's yes for a gated step (cache);
                                  subset names select "urls/subsets/<name>.txt" (default: all)
status.mjs urls                  merge urls/scan.json into the inventory urls/urls.json;
                                 distribution + caching proposal → urls/urls.md, subsets/
status.mjs urls import <file>    merge an operator's URL list (one per line) the same way
status.mjs section <step|next> [--file body.md] (else stdin)
                                 write that "## <step>" in REPORT.md from a body without
                                 heading (the command adds it; replaces a previous one)
status.mjs free-port [--from 3001]
status.mjs dashboard [stop]                 serve tools/migration/ with aem up on a free port
                                 a loopback port nothing listens on (for the cache proxy)
status.mjs pick [--count 2] [--exclude <url>]... [--write <subset>]
                                 one reachable page per largest group; with --write, fill
                                 to count and save urls/subsets/<subset>.txt for approve
status.mjs setup [--install] [--skills-repo <owner/repo>] [--skills-ref <branch>]
                                 detect preconditions; --install fixes them in project scope`;

const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

function renderText(states) {
  const rows = states.map((s) => {
    const via = s.skill ? `via ${s.skill}` : 'runner';
    const why = s.running ? ` ${s.running}`
      : s.blockedBy.length ? ` (by ${s.blockedBy.join(', ')})` : '';
    return `${s.id.padEnd(12)} ${s.state.padEnd(17)}${why.padEnd(20)} ${s.tier.padEnd(7)} ${via}`;
  });
  return ['step         state            blocked             tier    how', ...rows].join('\n');
}

export async function status(project) {
  const data = await readProject(project);
  if (!data) {
    throw new Error(`No project at ${project.projectFile}; run status.mjs init --origin <url>`);
  }
  const { done, running } = await runAllChecks(project);
  const approved = data.approved ?? {};
  const result = {
    project: project.dir,
    origin: data.origin,
    generatedAt: new Date().toISOString(),
    steps: stepStates(done, approved, running),
  };
  // The dashboard (tools/migration/) reads this instead of recomputing the checks.
  await writeFile(project.statusFile, `${JSON.stringify(result, null, 2)}\n`).catch(() => {});
  return result;
}

export async function approve(id, subsets, project) {
  const step = stepById(id);
  if (!step.operatorGate) throw new Error(`Step "${id}" needs no approval`);
  const data = await readProject(project);
  if (!data) throw new Error(`No project at ${project.projectFile}`);
  if (id === 'cache') data.cacheSelection = await cacheSelectionFrom(subsets, data, project);
  data.approved = { ...(data.approved ?? {}), [id]: true };
  await writeProject(project, data);
  return {
    step: id, approved: true, ...(id === 'cache' ? { cacheSelection: data.cacheSelection } : {}),
  };
}

/**
 * The selection an approval records. Named subsets must exist; `all` is explicit; a bare
 * approval means `all` only when the site is under the caching threshold — above it, the
 * operator has to say what to cache.
 */
async function cacheSelectionFrom(subsets, data, project) {
  const subsetsDir = path.join(project.step('urls'), 'subsets');
  if (subsets.length === 1 && subsets[0] === 'all') return 'all';
  if (subsets.length) {
    for (const name of subsets) {
      const file = path.join(subsetsDir, `${name}.txt`);
      await readFile(file, 'utf8').catch(() => {
        throw new Error(`no subset file urls/subsets/${name}.txt; write it or run pick --write`);
      });
    }
    return subsets;
  }
  const total = (await readUrls(project).catch(() => [])).length;
  if (total <= data.cacheAllUpTo) return 'all';
  const names = (await readdir(subsetsDir).catch(() => []))
    .filter((f) => f.endsWith('.txt')).map((f) => f.replace(/\.txt$/, ''));
  throw new Error(`${total} URLs exceed cacheAllUpTo ${data.cacheAllUpTo}: name the selection — `
    + `approve cache <subset>... (subsets: ${names.join(', ') || 'none yet'}) `
    + 'or approve cache all');
}

/** The inventory, or a clear error when the scan step has not produced anything yet. */
async function readUrls(project) {
  const records = await readInventory(project.step('urls'));
  if (!records.length) {
    throw new Error('missing migration/urls/urls.json; run the scan step first');
  }
  return records;
}

/**
 * Folds the crawler's `urls/scan.json` (when present) into the inventory, then writes
 * `urls/urls.md` and the subsets under `urls/subsets/` and returns the caching proposal.
 */
export async function urls(project) {
  const data = await readProject(project);
  if (!data) throw new Error(`No project at ${project.projectFile}`);
  const urlsDir = project.step('urls');
  await mergeScanFile(urlsDir);
  const entries = normalise(await readUrls(project));
  await writeInventory(urlsDir, entries);
  const dist = distribution(entries);
  const prop = proposal(dist, { cacheAllUpTo: data.cacheAllUpTo });
  await writeFile(path.join(urlsDir, 'urls.md'), renderUrlsMd(dist, prop));
  await writeSubsets(entries, prop, urlsDir);
  return prop;
}

/** Merges `urls/scan.json` into the inventory when the crawler left one. */
async function mergeScanFile(urlsDir) {
  const file = path.join(urlsDir, 'scan.json');
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return;
  let scanned;
  try {
    scanned = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}); rerun the scan step`);
  }
  if (!Array.isArray(scanned)) throw new Error(`${file} must be a JSON array of URLExtended`);
  await writeInventory(urlsDir, mergeScan(await readInventory(urlsDir), scanned));
}

/** `urls import <file>`: an operator's URL list, one per line, merged like a crawl result. */
export async function importList(project, file) {
  const text = await readFile(path.resolve(project.root, file), 'utf8').catch(() => {
    throw new Error(`cannot read ${file}`);
  });
  const entries = fromList(text);
  if (!entries.length) throw new Error(`${file} holds no URL`);
  const urlsDir = project.step('urls');
  const merged = mergeScan(await readInventory(urlsDir), entries);
  await writeInventory(urlsDir, merged);
  return { imported: entries.length, total: merged.length };
}

/**
 * Detects Node, `playwright-cli`, `franklin-bulk-shared` and the sibling skills; with
 * `shouldInstall` runs the project-scope installers for what is missing, then re-detects.
 * Always writes `migration/setup.json`. Never installs Node (the installer reports it and
 * runs nothing else); never installs globally. `nodeVersion` and `exec` are injectable for
 * tests; the CLI passes neither.
 */
export async function setup({
  shouldInstall, nodeVersion, exec = defaultExec, skillsRepo, skillsRef, env = process.env,
}, project) {
  let detection = await detect({ cwd: project.root, nodeVersion });
  let installs = [];
  if (shouldInstall) {
    const source = await skillsSource(project, { skillsRepo, skillsRef });
    const hasUpskill = !!(await commandOnPath('upskill'));
    installs = await install(detection, {
      exec, cwd: project.root, hasUpskill, ...source,
    });
    detection = await detect({ cwd: project.root, nodeVersion });
  }
  await writeSetupJson(project, detection);
  const reasons = missingReasons(detection);
  await upsertSection(project, 'setup', setupSection(detection, installs, reasons, env));
  if (reasons.length) process.exitCode = 1;
  return { detection, reasons, installs };
}

const MODEL_VARS = ['PI_MODEL', 'CLAUDE_MODEL', 'ANTHROPIC_MODEL', 'OPENAI_MODEL', 'MODEL'];

/** The model name the harness exposes in the environment, or an honest "unknown". */
function harnessModel(env) {
  const name = MODEL_VARS.map((v) => env[v]).find(Boolean);
  return name ?? 'unknown (not exposed by the harness; do not guess it)';
}

/** The `## setup` body: what was found, what was installed, what is still missing. */
function setupSection(detection, installs, reasons, env) {
  const skills = Object.entries(detection.skills)
    .map(([name, s]) => `${name} (${s.ok ? s.path : 'missing'})`).join(', ');
  const pkg = detection.packages['franklin-bulk-shared'].ok ? 'present' : 'missing';
  const lines = [
    `Node ${detection.node.version}; playwright-cli `
      + `${detection.playwrightCli.ok ? detection.playwrightCli.path : 'missing'}; `
      + `franklin-bulk-shared ${pkg}.`,
    `Skills: ${skills}.`,
  ];
  if (installs.length) {
    const outcomes = installs
      .map((i) => `${i.target} ${i.ok ? 'ok' : `failed (${i.error ?? 'see command'})`}`);
    lines.push(`Installed in project scope: ${outcomes.join('; ')}.`);
  }
  lines.push(reasons.length ? `Still missing: ${reasons.join('; ')}.` : 'Every precondition met.');
  lines.push(`Model reported by the harness: ${harnessModel(env)}.`);
  return lines.join('\n');
}

/**
 * Where the sibling skills are installed from: `--skills-repo`/`--skills-ref` when given
 * (and recorded in `project.json.skills` for later runs), else what was recorded, else the
 * defaults.
 */
async function skillsSource(project, { skillsRepo, skillsRef }) {
  const data = (await readProject(project)) ?? {};
  if (skillsRepo || skillsRef) {
    data.skills = { repo: skillsRepo ?? data.skills?.repo, ref: skillsRef ?? data.skills?.ref };
    await writeProject(project, data);
  }
  return { skillsRepo: data.skills?.repo, skillsRef: data.skills?.ref };
}

/**
 * Representative pages for a check: one reachable URL from each of the `count` largest
 * groups below the shared scope, skipping the groups of the `--exclude` URLs.
 */
export async function pickUrls(project, {
  count, exclude, write, reachable,
}) {
  const entries = await readUrls(project);
  const fill = Boolean(write);
  const picks = await pick(entries, {
    count, exclude, fill, ...(reachable ? { reachable } : {}),
  });
  if (!write) return picks;
  const file = await writeSubset(project.step('urls'), write, picks.map((p) => p.url));
  return { subset: write, file, count: picks.length, picks };
}

/** The flags each command accepts (value-taking flags listed once; booleans too). */
const FLAGS = {
  status: ['--text'],
  check: [],
  init: ['--origin', '--skills-repo', '--skills-ref'],
  pick: ['--count', '--exclude', '--write'],
  approve: [],
  urls: [],
  setup: ['--install', '--skills-repo', '--skills-ref'],
  'free-port': ['--from'],
  dashboard: [],
  section: ['--file'],
};

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

function rejectUnknownFlags(name, argv) {
  const unknown = argv.filter((a) => a.startsWith('--') && !FLAGS[name].includes(a));
  if (unknown.length) {
    throw new Error(`Unknown flag ${unknown.join(', ')} for "${name}"\n${USAGE}`);
  }
}

const COMMANDS = {
  async status(argv, project) {
    const result = await status(project);
    return argv.includes('--text') ? renderText(result.steps) : result;
  },
  async check(argv, project) {
    const [id] = argv;
    if (!id) throw new Error(USAGE);
    const result = await runCheck(stepById(id).id, project);
    await status(project).catch(() => {});
    if (!result.pass) process.exitCode = 1;
    return result;
  },
  init: (argv, project) => init({
    origin: flag(argv, '--origin'),
    skillsRepo: flag(argv, '--skills-repo'),
    skillsRef: flag(argv, '--skills-ref'),
  }, project),
  pick: (argv, project) => pickUrls(project, {
    count: Number(flag(argv, '--count') ?? 2),
    exclude: argv.flatMap((a, i) => (a === '--exclude' ? [argv[i + 1]] : [])),
    write: flag(argv, '--write'),
  }),
  approve(argv, project) {
    const [id, ...subsets] = argv;
    if (!id) throw new Error(USAGE);
    return approve(id, subsets, project);
  },
  urls: (argv, project) => (argv[0] === 'import'
    ? importList(project, argv[1] ?? (() => { throw new Error(USAGE); })())
    : urls(project)),
  'free-port': async (argv) => ({ port: await freePort(Number(flag(argv, '--from') ?? 3001)) }),
  dashboard: (argv, project) => (argv[0] === 'stop'
    ? stopDashboard(project) : dashboard(project, freePort)),
  async section(argv, project) {
    const id = argv[0] === 'next' ? 'next' : stepById(argv[0] ?? '').id;
    const file = flag(argv, '--file');
    const body = file
      ? await readFile(path.resolve(project.root, file), 'utf8').catch(() => {
        throw new Error(`section ${id}: cannot read ${file}`);
      })
      : await readStdin();
    if (!body.trim()) throw new Error(`section ${id}: the body on stdin is empty`);
    await upsertSection(project, id, body);
    return { section: id, file: project.report };
  },
  setup: (argv, project) => setup({
    shouldInstall: argv.includes('--install'),
    skillsRepo: flag(argv, '--skills-repo'),
    skillsRef: flag(argv, '--skills-ref'),
  }, project),
};

async function cli(argv) {
  const [first, ...rest] = argv;
  const name = first && !first.startsWith('--') ? first : 'status';
  const args = name === 'status' ? argv : rest;
  const command = COMMANDS[name];
  if (!command) throw new Error(`Unknown command "${name}"\n${USAGE}`);
  rejectUnknownFlags(name, args);
  return command(args, resolveProject());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2))
    .then((out) => console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2)))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
