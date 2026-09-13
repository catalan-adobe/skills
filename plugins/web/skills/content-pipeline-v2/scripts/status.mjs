#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { runAllChecks, runCheck } from './lib/checks.mjs';
import {
  init, readProject, resolveProject, writeProject,
} from './lib/project.mjs';
import { stepById, stepStates } from './lib/steps.mjs';

const USAGE = `status.mjs [--text]              every step: done|ready|blocked|waiting-operator
status.mjs check <step>          the step's done-check; exit 1 when it fails
status.mjs init --origin <url>   create migration/ and project.json
status.mjs approve <step>        record the operator's yes for a gated step (cache)`;

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

export async function approve(id, project) {
  const step = stepById(id);
  if (!step.operatorGate) throw new Error(`Step "${id}" needs no approval`);
  const data = await readProject(project);
  if (!data) throw new Error(`No project at ${project.projectFile}`);
  data.approved = { ...(data.approved ?? {}), [id]: true };
  await writeProject(project, data);
  return { step: id, approved: true };
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
    if (!argv[0]) throw new Error(USAGE);
    return approve(argv[0], project);
  },
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
