#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runAllChecks, runCheck } from './lib/checks.mjs';
import {
  init, readProject, resolveProject, writeProject,
} from './lib/project.mjs';
import { stepById, stepStates } from './lib/steps.mjs';
import {
  distribution, proposal, renderUrlsMd, writeSubsets,
} from './lib/urls.mjs';
import {
  commandOnPath, defaultExec, detect, install, missingReasons, writeSetupJson,
} from './lib/setup.mjs';

const USAGE = `status.mjs [--text]              every step: done|ready|blocked|waiting-operator
status.mjs check <step>          the step's done-check; exit 1 when it fails
status.mjs init --origin <url>   create migration/ and project.json
status.mjs approve <step> [<subset>...]
                                  record the operator's yes for a gated step (cache);
                                  subset names select "urls/subsets/<name>.txt" (default: all)
status.mjs urls                  distribution + caching proposal from urls/urls.json
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
  data.approved = { ...(data.approved ?? {}), [id]: true };
  if (id === 'cache') data.cacheSelection = subsets.length ? subsets : 'all';
  await writeProject(project, data);
  return {
    step: id, approved: true, ...(id === 'cache' ? { cacheSelection: data.cacheSelection } : {}),
  };
}

/**
 * Reads `urls/urls.json`, writes `urls/urls.md` and the subsets under `urls/subsets/`,
 * and returns the caching proposal.
 */
export async function urls(project) {
  const data = await readProject(project);
  if (!data) throw new Error(`No project at ${project.projectFile}`);
  const urlsDir = project.step('urls');
  const file = path.join(urlsDir, 'urls.json');
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
  if (reasons.length) process.exitCode = 1;
  return { detection, reasons, installs };
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
  init: (argv, project) => init({ origin: flag(argv, '--origin') }, project),
  approve(argv, project) {
    const [id, ...subsets] = argv;
    if (!id) throw new Error(USAGE);
    return approve(id, subsets, project);
  },
  urls: (argv, project) => urls(project),
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
