/**
 * The step graph. `tier` is the model tier a harness should give the step (low | medium |
 * high); `skill` the sibling skill whose instructions the step follows; `writes` the
 * artefacts under `migration/` the step must produce; `operatorGate` marks a step that waits
 * for an explicit `status.mjs approve <id>` even when its dependencies are done.
 */
export const STEPS = [
  {
    id: 'setup',
    tier: 'low',
    skill: null,
    dependsOn: [],
    writes: ['setup.json'],
  },
  {
    id: 'probe',
    tier: 'low',
    skill: 'browser-probe',
    dependsOn: ['setup'],
    writes: ['probe/browser-recipe.json', 'probe/probe.md'],
  },
  {
    id: 'prep',
    tier: 'medium',
    skill: 'page-prep',
    dependsOn: ['probe'],
    writes: ['prep/page-prep.json', 'prep/prep.md'],
  },
  {
    id: 'scan',
    tier: 'low',
    tierNote: 'medium when the site has no usable sitemap and scope needs judgement',
    skill: 'site-scan',
    dependsOn: ['setup'],
    writes: ['urls/urls.json', 'urls/urls.md'],
  },
  {
    id: 'prep-verify',
    tier: 'medium',
    skill: 'page-prep',
    dependsOn: ['prep', 'scan'],
    writes: ['prep/page-prep.json', 'prep/prep.md'],
  },
  {
    id: 'cache',
    tier: 'low',
    tierNote: 'medium for reading the coverage report at the end',
    skill: 'page-cache',
    dependsOn: ['prep', 'scan'],
    operatorGate: true,
    writes: ['cache/cache.md', 'cache/.page-cache/'],
  },
  {
    id: 'capture',
    tier: 'low',
    skill: 'page-tree',
    dependsOn: ['cache'],
    writes: ['capture/captures.md'],
  },
  {
    id: 'chrome',
    tier: 'medium',
    tierNote: 'the detection is a script; the model only looks at one screenshot per variant',
    skill: null,
    dependsOn: ['capture'],
    writes: ['chrome/chrome.json', 'chrome/chrome.md'],
  },
  {
    id: 'report',
    tier: 'medium',
    skill: null,
    dependsOn: ['probe', 'prep', 'scan'],
    writes: ['REPORT.md'],
  },
];

export const STEP_IDS = STEPS.map((s) => s.id);

export function stepById(id) {
  const step = STEPS.find((s) => s.id === id);
  if (!step) throw new Error(`Unknown step "${id}"; steps: ${STEP_IDS.join(', ')}`);
  return step;
}

/**
 * The state of every step from the done-check results and the operator approvals.
 *
 * @param {Record<string, boolean>} done Step id → its done-check passed.
 * @param {Record<string, boolean>} [approved] Step id → operator approval recorded.
 * @param {Record<string, string>} [running] Step id → a progress label while background
 *   work holds the step (`12/50 (blogs) · queued: ja-jp`).
 * @param {Record<string, string>} [notes] Step id → a short note on why it is not done
 *   (`12 pages behind the cache`).
 * @returns {{id: string, tier: string, tierNote?: string, skill: string|null,
 *   state: 'done'|'ready'|'blocked'|'waiting-operator'|'running', blockedBy: string[],
 *   writes: string[], running?: string, note?: string}[]}
 */
export function stepStates(done, approved = {}, running = {}, notes = {}) {
  return STEPS.map((step) => {
    const blockedBy = done[step.id] ? [] : step.dependsOn.filter((dep) => !done[dep]);
    let state = 'ready';
    if (done[step.id]) state = 'done';
    else if (running[step.id]) state = 'running';
    else if (blockedBy.length) state = 'blocked';
    else if (step.operatorGate && !approved[step.id]) state = 'waiting-operator';
    const {
      id, tier, tierNote, skill, writes,
    } = step;
    return {
      id,
      tier,
      ...(tierNote ? { tierNote } : {}),
      skill,
      state,
      blockedBy,
      writes,
      ...(state === 'running' ? { running: running[step.id] } : {}),
      ...(notes[step.id] && state !== 'done' ? { note: notes[step.id] } : {}),
    };
  });
}
