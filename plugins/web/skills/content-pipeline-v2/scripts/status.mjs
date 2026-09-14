#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAllChecks, runCheck } from './lib/checks.mjs';
import { createServer } from 'node:net';
import {
  init, readProject, resolveProject, upsertSection, writeProject,
} from './lib/project.mjs';
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
status.mjs urls                  distribution + caching proposal from urls/urls.json
status.mjs section <step> < body.md
                                 write that step's "## <step>" in REPORT.md (replaces it)
status.mjs free-port [--from 3001]
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
    const why = s.blockedBy.length ? ` (by ${s.blockedBy.join(', ')})` : '';
    return `${s.id.padEnd(12)} ${s.state.padEnd(17)}${why.padEnd(20)} ${s.tier.padEnd(7)} ${via}`;
  });
  return ['step         state            blocked             tier    how', ...rows].join('\n');
}

export async function status(project) {
  const data = await readProject(project);
  if (!data) {
    throw new Error(`No project at ${project.projectFile}; run status.mjs init --origin <url>`);
  }
  const done = await runAllChecks(project);
  const approved = data.approved ?? {};
  return { project: project.dir, origin: data.origin, steps: stepStates(done, approved) };
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

/**
 * Reads `urls/urls.json`, writes `urls/urls.md` and the subsets under `urls/subsets/`,
 * and returns the caching proposal.
 */
async function readUrls(project) {
  const file = path.join(project.step('urls'), 'urls.json');
  const text = await readFile(file, 'utf8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (text === null) {
    throw new Error('missing migration/urls/urls.json; run the scan step first');
  }
  let entries;
  try {
    entries = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}); rerun the scan step`);
  }
  if (!Array.isArray(entries)) {
    throw new Error('migration/urls/urls.json must be a JSON array of URLExtended entries');
  }
  return entries;
}

export async function urls(project) {
  const data = await readProject(project);
  if (!data) throw new Error(`No project at ${project.projectFile}`);
  const urlsDir = project.step('urls');
  const entries = await readUrls(project);
  const dist = distribution(entries);
  const prop = proposal(dist, { cacheAllUpTo: data.cacheAllUpTo });
  await writeFile(path.join(urlsDir, 'urls.md'), renderUrlsMd(dist, prop));
  await writeSubsets(entries, prop, urlsDir);
  return prop;
}

/**
 * Detects Node, `playwright-cli`, `franklin-bulk-shared` and the sibling skills; with
 * `shouldInstall` runs the project-scope installers for what is missing, then re-detects.
 * Always writes `migration/setup.json`. Never installs Node (the installer reports it and
 * runs nothing else); never installs globally. `nodeVersion` and `exec` are injectable for
 * tests; the CLI passes neither.
 */
export async function setup({
  shouldInstall, nodeVersion, exec = defaultExec, skillsRepo, skillsRef,
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
  await upsertSection(project, 'setup', setupSection(detection, installs, reasons));
  if (reasons.length) process.exitCode = 1;
  return { detection, reasons, installs };
}

/** The `## setup` body: what was found, what was installed, what is still missing. */
function setupSection(detection, installs, reasons) {
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
  return lines.join('\n');
}

/** The first TCP port at or above `from` on which nothing listens (loopback). */
export function freePort(from = 3001) {
  const tryPort = (port) => new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(tryPort(port + 1)));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(port)));
  });
  return tryPort(from);
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
  section: [],
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
  urls: (argv, project) => urls(project),
  'free-port': async (argv) => ({ port: await freePort(Number(flag(argv, '--from') ?? 3001)) }),
  async section(argv, project) {
    const id = stepById(argv[0] ?? '').id;
    const body = await readStdin();
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
