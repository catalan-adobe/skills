import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { flag } from '../../../scripts/lib/args.mjs';
import { readJson } from '../../../scripts/lib/state.mjs';

const FINAL = new Set(['completed', 'failed', 'aborted']);

/**
 * Judges one snapshot of a workflow run journal.
 *
 * @param {object} journal Run journal (`runId, status, currentPhase, agents[], logs[], updatedAt`).
 * @param {{now?: number, stallMinutes?: number}} [options] Clock and stall threshold.
 * @returns {{state: 'running'|'finished'|'stalled', status: string, phase: string,
 *   running: {label: string, minutes: number}[], done: number, total: number, stalled: string[],
 *   cost: number, lastLog: string}} The verdict for this snapshot.
 */
function runningAgents(agents, now) {
  return agents
    .filter((a) => a.status === 'running' && a.startedAt)
    .map((a) => ({ label: a.label, minutes: Math.round((now - Date.parse(a.startedAt)) / 60000) }));
}

function stateOf(status, stalled) {
  if (FINAL.has(status)) return 'finished';
  return stalled.length ? 'stalled' : 'running';
}

function lastLogOf(logs = []) {
  const last = logs.at(-1);
  return typeof last === 'string' ? last : (last?.message ?? '');
}

export function judge(journal, { now = Date.now(), stallMinutes = 30 } = {}) {
  const agents = journal.agents ?? [];
  const running = runningAgents(agents, now);
  const stalled = running.filter((a) => a.minutes >= stallMinutes)
    .map((a) => `${a.label} running for ${a.minutes} min`);
  return {
    state: stateOf(journal.status, stalled),
    status: journal.status,
    phase: journal.currentPhase ?? '',
    running,
    done: agents.filter((a) => a.status === 'done').length,
    total: agents.length,
    stalled,
    cost: journal.tokenUsage?.cost ?? 0,
    lastLog: lastLogOf(journal.logs),
  };
}

/**
 * Formats a verdict as one status line.
 *
 * @param {ReturnType<typeof judge>} verdict Snapshot verdict.
 * @returns {string} Human-readable line.
 */
export function formatLine(verdict) {
  const active = verdict.running.map((a) => `${a.label} (${a.minutes}m)`).join(', ') || '-';
  return `${verdict.state} · ${verdict.status} · ${verdict.phase} · agents ${verdict.done}/`
    + `${verdict.total} · $${verdict.cost.toFixed(2)} · active: ${active}`;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Polls a run journal until the run finishes or stalls, printing one line per check.
 *
 * @param {object} options
 * @param {string} options.runId Workflow run id.
 * @param {string} options.runsDir Directory holding `<runId>.json`.
 * @param {number} [options.intervalSeconds] Seconds between checks.
 * @param {number} [options.stallMinutes] Minutes an agent may run before it counts as stalled.
 * @param {number} [options.maxMinutes] Wall-clock budget for this watch; exits `running` after it.
 * @param {(line: string) => void} [options.log] Line sink (stderr by default).
 * @returns {Promise<ReturnType<typeof judge> & {runId: string, checks: number}>} Final verdict.
 */
export async function watchRun({
  runId, runsDir, intervalSeconds = 240, stallMinutes = 30, maxMinutes = 25, log = console.error,
}) {
  const file = path.join(runsDir, `${runId}.json`);
  const deadline = Date.now() + maxMinutes * 60000;
  let checks = 0;
  for (;;) {
    const journal = await readJson(file, null);
    if (!journal) throw new Error(`Run journal not found: ${file}`);
    const verdict = judge(journal, { stallMinutes });
    checks += 1;
    log(`[watch ${runId}] ${formatLine(verdict)}`);
    if (verdict.state !== 'running' || Date.now() >= deadline) {
      return { runId, checks, ...verdict };
    }
    await sleep(intervalSeconds * 1000);
  }
}

function resolveRunsDir(argv, env = process.env) {
  const dir = flag(argv, '--runs-dir', env.MIGRATION_RUNS_DIR);
  if (!dir) {
    throw new Error('Missing runs directory: pass --runs-dir <dir> or set MIGRATION_RUNS_DIR');
  }
  return path.resolve(dir);
}

async function cli(argv) {
  const runId = argv[0];
  if (!runId || runId.startsWith('--')) {
    throw new Error('Usage: watch-run.mjs <runId> [--runs-dir <dir>] [--interval <s>] '
      + '[--stall-minutes <m>] [--max-minutes <m>]');
  }
  const result = await watchRun({
    runId,
    runsDir: resolveRunsDir(argv),
    intervalSeconds: Number(flag(argv, '--interval', '240')),
    stallMinutes: Number(flag(argv, '--stall-minutes', '30')),
    maxMinutes: Number(flag(argv, '--max-minutes', '25')),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.state === 'stalled') process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
