import { access } from 'node:fs/promises';
import path from 'node:path';
import { STEPS } from './steps.mjs';

const exists = (file) => access(file).then(() => true, () => false);

/**
 * The fallback done-check: every artefact the step declares exists. Steps with a real
 * content check override this in `CHECKS`.
 */
async function artefactsExist(step, project) {
  const missing = [];
  for (const rel of step.writes) {
    if (!(await exists(path.join(project.dir, rel)))) missing.push(rel);
  }
  return { pass: !missing.length, reasons: missing.map((m) => `missing migration/${m}`) };
}

/** Step id → `async (project) => { pass, reasons }`. */
export const CHECKS = Object.fromEntries(
  STEPS.map((step) => [step.id, (project) => artefactsExist(step, project)]),
);

export async function runCheck(id, project) {
  const check = CHECKS[id];
  if (!check) throw new Error(`No done-check for step "${id}"`);
  const result = await check(project);
  return { step: id, ...result };
}

/** Every step's done-check, as `{ id: pass }`. */
export async function runAllChecks(project) {
  const entries = await Promise.all(
    Object.keys(CHECKS).map(async (id) => [id, (await runCheck(id, project)).pass]),
  );
  return Object.fromEntries(entries);
}
