// The evaluation report: what a reader needs to judge the inventory by eye — the crops per
// type, the height spread, the position habit, and the flags that name a likely mistake.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SATURATION_PAGES } from './elements-report.mjs';

export const evaluationMd = (project) => path.join(project.step('elements'), 'evaluation.md');
export const writeEvaluation = (project, result) => (
  writeFile(evaluationMd(project), renderEvaluationMd(result)));

// p90/p10 of the instance heights: one collapsed or one giant instance is not a spread.
export const HEIGHT_SPREAD_FLAG = 10;
export const HABIT_SHARE = 0.9;
// A position habit on fewer pages says nothing.
export const HABIT_MIN_PAGES = 5;
// A base class shared by this many types is a framework's, not a merge candidate.
export const BASE_CLASS_TYPES = 3;

const pct = (x) => `${Math.round(x * 100)} %`;
const classTokens = (identity) => new Set(identity.replace(/^[^.]*\.?/, '').split('.')
  .filter(Boolean));
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

/**
 * Where a type's instances sit on their pages (the share that are first and last) and the
 * spread of their heights (p10, p90).
 */
export function positionHabit(type, pages) {
  let first = 0;
  let last = 0;
  const heights = [];
  for (const p of pages) {
    p.sections.forEach((s, i) => {
      if (s.type !== type.id) return;
      heights.push(s.height);
      if (i === 0) first += 1;
      if (i === p.sections.length - 1) last += 1;
    });
  }
  const n = heights.length;
  heights.sort((a, b) => a - b);
  return {
    first: n ? first / n : 0, last: n ? last / n : 0, instances: n,
    p10: n ? quantile(heights, 0.1) : 0, p90: n ? quantile(heights, 0.9) : 0,
  };
}

/**
 * Identities one class apart, attributed to the shorter (base) identity: `DIV#.banner` is
 * the base of `DIV#.banner.image`. Identities without a class never take part. Returns
 * `[baseId, [ids…]]`; a base of BASE_CLASS_TYPES or more is a shared base class.
 */
export function lookAlikes(types) {
  const out = new Map();
  const withClasses = types.filter((t) => classTokens(t.identity).size > 0);
  for (const a of withClasses) {
    for (const b of withClasses) {
      if (a === b || a.identity.split('.')[0] !== b.identity.split('.')[0]) continue;
      const ta = classTokens(a.identity);
      const tb = classTokens(b.identity);
      if (tb.size === ta.size + 1 && [...ta].every((k) => tb.has(k))) {
        out.set(a.id, [...(out.get(a.id) ?? []), b.id]);
      }
    }
  }
  return [...out];
}

/** The flags: each names a type or a page and what to look at. */
export function flags(result) {
  const recurring = result.types.filter((t) => t.recurring);
  const out = [];
  for (const t of recurring) {
    const habit = positionHabit(t, result.pages);
    if (habit.p10 > 0 && habit.p90 / habit.p10 >= HEIGHT_SPREAD_FLAG) {
      out.push({
        type: t.id, flag: 'height spread',
        detail: `p10 ${habit.p10} px, p90 ${habit.p90} px (${t.heightRange.join('–')}): one`
          + ' type or several?',
      });
    }
    if (t.pages >= HABIT_MIN_PAGES && t.instances === t.pages
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
  for (const [base, others] of lookAlikes(recurring)) {
    out.push(others.length >= BASE_CLASS_TYPES
      ? { type: base, flag: 'base class', detail: `base of ${others.length} types (${others
        .join(', ')}) — a shared base class, not a merge` }
      : { type: base, flag: 'look-alike', detail: `${others.join(', ')} is one class more —`
        + ' one element (a merge) or a variant?' });
  }
  const single = result.pages.filter((p) => p.sections.length === 1);
  const empty = result.pages.filter((p) => p.sections.length === 0).length;
  if (single.length) {
    const byType = Map.groupBy(single, (p) => p.sections[0].type);
    const named = [...byType].sort((a, b) => b[1].length - a[1].length)
      .map(([id, list]) => `${id} ×${list.length}`).join(', ');
    out.push({ flag: 'one-section pages', detail: `${single.length} pages have a single `
      + `section (${named}): a container not peeled?` });
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
      + ` variants, height ${t.heightRange[0]}–${t.heightRange[1]} px (median ${t.medianHeight},`
      + ` p10 ${habit.p10}, p90 ${habit.p90}), first on ${pct(habit.first)}, last on `
      + `${pct(habit.last)} of its pages.`,
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
      + ' runs table in `elements.md` says what moved. Never edit `elements.json`.',
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
