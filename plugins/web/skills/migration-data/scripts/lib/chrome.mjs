// The chrome as a choice. The chrome step's engine finds what recurs across pages and
// lays it out as candidates with evidence — support, width, text stability, position, a
// crop; the rules propose header and footer among them; a reader (an agent at any tier, a
// person) may choose otherwise. The candidates are a derived sheet; the choice is a
// decision, made part of what a detection is of, so a new choice re-runs it.
import { HEAD, register } from './schema.mjs';
import { id as makeId, openStore } from './store.mjs';

export const CANDIDATES_FILE = 'website/chrome-candidates.json';
export const CANDIDATES_SCHEMA = 'website/chrome-candidates@1';
export const CHOICE_FILE = 'website/chrome.json';
export const CHOICE_SCHEMA = 'website/chrome@1';
export const PARTS = ['header', 'footer'];
export const VERDICTS = ['header', 'footer', 'unplaced', 'rejected'];

const idPattern = (prefix) => ({ type: 'string', pattern: `^${prefix}-[0-9a-f]{12}$` });
const share = { type: 'number', minimum: 0, maximum: 1 };

register('website/chrome-candidates', 1, 'derived', {
  type: 'object',
  required: ['schema', 'summary', 'method', 'candidates'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    summary: { type: 'string' },
    method: {
      type: 'object',
      required: ['name', 'at'],
      additionalProperties: false,
      properties: {
        name: { type: 'string' }, version: { type: 'string' },
        at: { type: 'string', format: 'date-time' }, inputs: { type: 'string' },
      },
    },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'selector', 'anchored', 'support', 'pages', 'widthShare',
          'textStability', 'bounds', 'verdict'],
        additionalProperties: false,
        properties: {
          id: idPattern('cnd'),
          selector: { type: 'string' },
          selectors: { type: 'array', items: { type: 'string' } },
          tag: { type: 'string' },
          anchored: { enum: ['top', 'bottom'] },
          support: share,
          pages: { type: 'integer', minimum: 0 },
          widthShare: share,
          textStability: share,
          variants: { type: 'integer', minimum: 1 },
          bounds: {
            type: 'object',
            required: ['y', 'height', 'width', 'bottomOffset'],
            additionalProperties: false,
            properties: {
              y: { type: 'number' }, height: { type: 'number' },
              width: { type: 'number' }, bottomOffset: { type: 'number' },
            },
          },
          verdict: { enum: VERDICTS },
          reason: { type: 'string' },
          sampleUrl: { type: 'string' },
          text: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
  },
});

register('website/chrome', 1, 'decision', {
  type: 'object',
  required: ['schema', 'parts'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    summary: { type: 'string' },
    parts: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(PARTS.map((part) => [part, {
        type: 'object',
        required: ['candidates', 'by', 'at'],
        additionalProperties: false,
        properties: {
          candidates: { type: 'array', items: idPattern('cnd') },
          label: { type: 'string' },
          by: { type: 'string' },
          at: { type: 'string', format: 'date-time' },
          note: { type: 'string' },
        },
      }])),
    },
  },
});

/** A candidate's id: the element's key and anchor, the same across runs. */
export const candidateId = (key, anchored) => makeId('cnd', `${key}|${anchored}`);

export async function writeCandidates(cwd, { method, candidates, summary }) {
  const byVerdict = {};
  for (const c of candidates) byVerdict[c.verdict] = (byVerdict[c.verdict] ?? 0) + 1;
  return openStore(cwd).write(CANDIDATES_FILE, {
    schema: CANDIDATES_SCHEMA, method, candidates,
    summary: summary ?? `${candidates.length} candidate(s): ${Object.entries(byVerdict)
      .map(([v, n]) => `${n} ${v}`).join(', ')}`,
  });
}

export const readCandidates = (cwd) => openStore(cwd).read(CANDIDATES_FILE, CANDIDATES_SCHEMA);
export const readChoice = (cwd) => openStore(cwd).read(CHOICE_FILE, CHOICE_SCHEMA);

/**
 * Chooses a part's members among the candidates: `candidates` are their ids (empty: the
 * part has none on this site), `by` names who chose (a model, an operator). Only ids on
 * the current sheet are accepted. An existing choice for the part is replaced.
 */
export async function choose(cwd, part, candidates, { by, label, note } = {}) {
  if (!PARTS.includes(part)) throw new Error(`a part is one of ${PARTS.join(', ')}; got ${part}`);
  if (!by) throw new Error('a choice names who made it (by)');
  const sheet = await readCandidates(cwd);
  if (!sheet) throw new Error('no candidate sheet yet: run the chrome step first');
  const known = new Set(sheet.candidates.map((c) => c.id));
  const unknown = candidates.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`not on the candidate sheet: ${unknown.join(', ')}`);
  const store = openStore(cwd);
  const current = (await readChoice(cwd)) ?? { schema: CHOICE_SCHEMA, parts: {} };
  const parts = {
    ...current.parts,
    [part]: { candidates, by, at: store.now().toISOString(),
      ...(label ? { label } : {}), ...(note ? { note } : {}) },
  };
  const words = Object.entries(parts).map(([p, c]) => (
    `${p}: ${c.candidates.length ? c.candidates.join(', ') : 'none'} (${c.by})`)).join('; ');
  return store.write(CHOICE_FILE, { schema: CHOICE_SCHEMA, parts, summary: words });
}

/** A short hash of the choice, for what a detection is of; '' without one. */
export function choiceHash(choice) {
  if (!choice) return '';
  return makeId('cho', JSON.stringify(Object.fromEntries(Object.entries(choice.parts)
    .map(([p, c]) => [p, c.candidates])))).slice(4);
}
