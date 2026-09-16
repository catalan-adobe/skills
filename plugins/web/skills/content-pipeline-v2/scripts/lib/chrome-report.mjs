// The chrome step's outputs: detection over the captures, screenshots, chrome.json,
// chrome.md and the REPORT.md section.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { candidates } from './chrome.mjs';
import { capturesDir } from './chrome-capture.mjs';
import { detectChrome } from './chrome-regions.mjs';
import { screenshotVariants } from './chrome-shots.mjs';
import { readInventory } from './inventory.mjs';
import { upsertSection } from './project.mjs';

export const chromeJson = (project) => path.join(project.step('chrome'), 'chrome.json');
export const chromeMd = (project) => path.join(project.step('chrome'), 'chrome.md');

/** Every stored capture. */
export async function readCaptures(project) {
  const dir = capturesDir(project);
  const files = await readdir(dir).catch(() => []);
  return Promise.all(files.filter((f) => f.endsWith('.json'))
    .map((f) => readFile(path.join(dir, f), 'utf8').then(JSON.parse)));
}

/** Detection over the captures on disk, labelled with the inventory's groups. */
export async function detect(project, { consentSelectors = [] } = {}) {
  const captures = await readCaptures(project);
  if (!captures.length) throw new Error('no captures under chrome/.captures; run chrome.mjs');
  const inventory = await readInventory(project.step('urls'));
  const groups = new Map(inventory.map((r) => [r.url, r.group]));
  return detectChrome(candidates(captures), {
    pages: captures.map((c) => c.url),
    pageHeights: captures.map((c) => c.tree.bounds.height),
    groupOf: (url) => groups.get(url),
    consentSelectors,
  });
}

/** Detection plus screenshots, written as chrome.json, chrome.md and the report section. */
export async function analyse(project, { browser, origin, port, prepare, consentSelectors,
  now = () => new Date() }) {
  const detection = await detect(project, { consentSelectors });
  const shots = { browser, origin, port, prepare };
  const result = {
    generatedAt: now().toISOString(),
    ...detection,
    header: await screenshotVariants(project, 'header', detection.header, shots),
    footer: await screenshotVariants(project, 'footer', detection.footer, shots),
  };
  await writeFile(chromeJson(project), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(chromeMd(project), renderChromeMd(result));
  await upsertSection(project, 'chrome', renderSection(result));
  return result;
}

const pct = (x) => `${Math.round(x * 100)} %`;

function renderVariant(role, v) {
  const lines = [
    `### ${role} ${v.id} — ${v.pages.length} pages (${pct(v.support)}), group \`${v.group}\``,
    '',
    `Representative: ${v.representative}`,
    `Screenshot: \`${v.screenshots.full}\``,
    '',
    '| member | tag | position | on pages | crop |',
    '|---|---|---|---|---|',
    ...v.members.map((m, i) => `| \`${m.selector}\` | ${m.tag} | y ${m.bounds.y}, `
      + `${m.bounds.height} px high | ${m.pages} `
      + `| \`${v.screenshots.members[i]?.file ?? '—'}\` |`),
  ];
  if (v.optional.length) {
    lines.push('', 'Optional members (not on every page of the variant):', '',
      ...v.optional.map((m) => `- \`${m.selector}\` on ${m.onPages} of ${v.pages.length} pages`));
  }
  if (v.screenshotError) {
    lines.push('', '**Defects:**', ...v.screenshotError.map((e) => `- ${e}`));
  }
  return lines.join('\n');
}

/** The operator's view of the chrome. */
export function renderChromeMd(r) {
  const role = (name, variants) => (variants.length
    ? variants.map((v) => renderVariant(name, v)).join('\n\n')
    : `_No ${name} recurs on at least ${pct(r.minSupport)} of the pages._`);
  const list = (urls) => (urls.length ? urls.map((u) => `- ${u}`).join('\n') : '_none_');
  return [
    '# Chrome — header and footer',
    '',
    `${r.capturedPages} pages captured from the cache; an element is chrome when it recurs`,
    `at a stable position on at least ${pct(r.minSupport)} of them (or fills the slot of one`,
    'that does).',
    '',
    '## Header', '', role('header', r.header), '',
    '## Footer', '', role('footer', r.footer), '',
    '## Pages without a header', '', list(r.without.header), '',
    '## Pages without a footer', '', list(r.without.footer), '',
    '## Unplaced', '',
    r.unplaced.length
      ? r.unplaced.map((m) => `- \`${m.selector}\` — ${m.pages} pages, y ${m.bounds.y}`)
        .join('\n')
      : '_none_',
    '',
    '## Rejected', '',
    r.rejected.length
      ? r.rejected.map((m) => `- \`${m.selector}\` (${pct(m.support)}): ${m.reason}`).join('\n')
      : '_none_',
    '',
    '## Limits', '', ...r.limits.map((l) => `- ${l}`), '',
  ].join('\n');
}

/** The REPORT.md section body (no heading). */
export function renderSection(r) {
  const line = (name, variants) => (variants.length
    ? `${name}: ${variants.map((v) => `${v.members.length} member(s) on ${v.pages.length} pages`
      + ` (${v.group})`).join('; ')}`
    : `${name}: none found`);
  const defects = [...r.header, ...r.footer].filter((v) => v.screenshotError).length;
  return [
    `${r.capturedPages} cached pages rendered offline and compared.`,
    line('Header', r.header), line('Footer', r.footer),
    `Pages without header: ${r.without.header.length}; without footer: ${r.without.footer.length}.`,
    `Rejected candidates: ${r.rejected.length}; unplaced: ${r.unplaced.length}`
      + `${defects ? `; variants with screenshot defects: ${defects}` : ''}.`,
    'Details, selectors and screenshots: `migration/chrome/chrome.md`.',
  ].join('\n');
}
