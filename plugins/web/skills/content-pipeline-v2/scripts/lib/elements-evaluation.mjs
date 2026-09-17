// The evaluation report: what a reader needs to judge the inventory by eye — the crops per
// type, the height spread, the position habit, and the flags that name a likely mistake.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SATURATION_PAGES } from './elements-report.mjs';

export const evaluationMd = (project) => path.join(project.step('elements'), 'evaluation.md');
export const writeEvaluation = (project, result) => (
  writeFile(evaluationMd(project), renderEvaluationMd(result)));

export const HEIGHT_SPREAD_FLAG = 10;
export const HABIT_SHARE = 0.9;
export const LEAK_SUPPORT = 0.5;

const pct = (x) => `${Math.round(x * 100)} %`;
const identityTokens = (identity) => new Set(identity.split(/[#.]/).filter(Boolean));

/** Where a type's instances sit on their pages: the share that are first and last. */
export function positionHabit(type, pages) {
  let first = 0;
  let last = 0;
  let n = 0;
  for (const p of pages) {
    p.sections.forEach((s, i) => {
      if (s.type !== type.id) return;
      n += 1;
      if (i === 0) first += 1;
      if (i === p.sections.length - 1) last += 1;
    });
  }
  return { first: n ? first / n : 0, last: n ? last / n : 0, instances: n };
}

/**
 * Identities one class apart (`DIV#.banner.image` and `DIV#.banner`), per type: the ids of
 * its look-alikes. A shared base class between components is the common false positive.
 */
export function lookAlikes(types) {
  const out = new Map();
  for (let i = 0; i < types.length; i += 1) {
    for (let j = i + 1; j < types.length; j += 1) {
      const a = identityTokens(types[i].identity);
      const b = identityTokens(types[j].identity);
      const diff = [...a].filter((t) => !b.has(t)).length + [...b].filter((t) => !a.has(t)).length;
      if (diff === 1) out.set(types[i].id, [...(out.get(types[i].id) ?? []), types[j].id]);
    }
  }
  return [...out];
}

/** The flags: each names a type or a page and what to look at. */
export function flags(result) {
  const recurring = result.types.filter((t) => t.recurring);
  const out = [];
  for (const t of recurring) {
    const [lo, hi] = t.heightRange;
    if (lo > 0 && hi / lo >= HEIGHT_SPREAD_FLAG) {
      out.push({ type: t.id, flag: 'height spread', detail: `${lo}–${hi} px: one type or several?`
      });
    }
    const habit = positionHabit(t, result.pages);
    if (t.support >= LEAK_SUPPORT && t.instances === t.pages
      && (habit.first >= HABIT_SHARE || habit.last >= HABIT_SHARE)) {
      out.push({
        type: t.id, flag: 'chrome leak?',
        detail: `once per page, ${habit.first >= HABIT_SHARE ? 'first' : 'last'} on ${pct(
          Math.max(habit.first, habit.last))} of ${t.pages} pages — chrome or a page frame`,
      });
    }
    if (t.screenshotError?.length) {
      out.push({ type: t.id, flag: 'crop failed', detail: t.screenshotError[0] });
    }
  }
  for (const [a, others] of lookAlikes(recurring)) {
    out.push({
      type: a, flag: 'look-alike',
      detail: `one class apart from ${others.join(', ')} — one element (a merge) or a shared`
        + ' base class?',
    });
  }
  const one = result.pages.filter((p) => p.sections.length === 1).length;
  const empty = result.pages.filter((p) => p.sections.length === 0).length;
  if (one) {
    out.push({ flag: 'one-section pages', detail: `${one} pages have a single section: a container`
      + ' not peeled?' });
  }
  if (empty) {
    out.push({
      flag: 'empty pages', detail: `${empty} pages have no section after chrome removal`,
    });
  }
  return out;
}

function renderType(t, pages) {
  const habit = positionHabit(t, pages);
  const shots = t.screenshots ?? { instances: [], variants: [] };
  const lines = [
    `### ${t.id} — \`${t.identity}\``,
    '',
    `${t.pages} pages (${pct(t.support)}), ${t.instances} instances, ${t.variants.length}`
      + ` variants, height ${t.heightRange[0]}–${t.heightRange[1]} px (median ${t.medianHeight}),`
      + ` first on ${pct(habit.first)}, last on ${pct(habit.last)} of its pages.`,
    '',
    ...shots.instances.map((f, i) => `![instance ${i + 1}](${f})`),
    '',
  ];
  if (shots.variants.length) {
    lines.push('Variants (largest first):', '');
    t.variants.slice(0, shots.variants.length).forEach((v, i) => {
      lines.push(`- v${i + 1}: ${v.instances} instances on ${v.pages} pages — children `
        + `${v.children.map((c) => `\`${c}\``).join(', ') || '_none_'}`,
      `  ![v${i + 1}](${shots.variants[i]})`);
    });
    if (t.variants.length > shots.variants.length) {
      lines.push(`- … ${t.variants.length - shots.variants.length} more variants`);
    }
    lines.push('');
  }
  if (t.screenshotError) {
    lines.push('**Crop errors:**', ...t.screenshotError.map((e) => `- ${e}`), '');
  }
  return lines.join('\n');
}

/** The report for the eye. Image paths are relative to `migration/elements/`. */
export function renderEvaluationMd(result) {
  const recurring = result.types.filter((t) => t.recurring);
  const unique = result.types.filter((t) => !t.recurring);
  const all = flags(result);
  const last = result.runs.at(-1);
  const top = result.compositions.slice(0, 10);
  return [
    '# Elements — evaluation',
    '',
    'Read the crops: do the instances of a type look like one element? Do two types look'
      + ' alike? Edit `rules.json` (merge, chrome, reject) and run `elements.mjs` again; the'
      + ' runs table says what moved. Never edit `elements.json`.',
    '',
    '## Flags', '',
    all.length ? all.map((f) => `- ${f.type ? `${f.type}: ` : ''}**${f.flag}** — ${f.detail}`)
      .join('\n') : '_none_',
    '',
    '## Coverage', '',
    `${last.covered.full} pages fully covered by recurring types, ${last.covered.partial}`
      + ` partially, ${last.covered.none} not at all; ${result.compositions.length} compositions,`
      + ` the ten largest: ${top.map((c) => c.pages).join(', ')} pages.`,
    '',
    `Groups: ${result.groups.filter((g) => g.saturated).length} of ${result.groups.length}`
      + ` saturated (last ${SATURATION_PAGES} pages brought no new type).`,
    '',
    '## Recurring types', '',
    ...recurring.map((t) => renderType(t, result.pages)),
    '## Unique types', '',
    unique.length
      ? unique.map((t) => `- ${t.id} \`${t.identity}\` on ${t.sample.url}`).join('\n') : '_none_',
    '',
  ].join('\n');
}
