// The elements step's rules: defaults the engine runs with, and the per-project overrides
// from elements/rules.json — a bounded vocabulary, never code. Adaptation to a site happens
// here; anything the vocabulary cannot say is an engine gap.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_RULES = {
  // A node covering this share of the page height with several children is a container.
  containerShare: 0.6,
  // A node this thin is a rule or a progress bar, not a section.
  hairlinePx: 6,
  // A type on this many pages counts as recurring.
  recurrence: 2,
  // Class tokens dropped from an identity, as regular expressions: widths such as
  // `col-sm-4` or `aem-GridColumn--default--12`. State and generated names are always out.
  identityExclusions: ['-\\d{1,2}$'],
  // Class tokens dropped from an identity, literally.
  noiseClasses: [],
  // A node whose children are all of these tags is a leaf component: never peeled.
  leafTags: ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'IMG', 'A', 'SPAN', 'FIGURE',
    'BLOCKQUOTE', 'TABLE', 'PICTURE'],
  // Type id → type id: the first is the second (two identities, one element).
  merge: {},
  // Selectors that are chrome after all (the chrome step missed them).
  chrome: [],
  // Selectors dropped before anything else.
  reject: [],
};

export const RULE_KEYS = Object.keys(DEFAULT_RULES);
export const rulesFile = (project) => path.join(project.step('elements'), 'rules.json');

/** Defaults with `overrides` on top; an unknown key is an error naming the known ones. */
export function mergeRules(overrides = {}) {
  const unknown = Object.keys(overrides).filter((k) => !RULE_KEYS.includes(k) && k !== '_example');
  if (unknown.length) {
    throw new Error(`rules.json: unknown key(s) ${unknown.join(', ')}; known: `
      + RULE_KEYS.join(', '));
  }
  const { _example, ...rest } = overrides;
  const rules = { ...DEFAULT_RULES, ...rest };
  return {
    ...rules,
    identityExclusions: rules.identityExclusions.map((s) => new RegExp(s)),
    leafTags: new Set(rules.leafTags),
    noiseClasses: new Set(rules.noiseClasses),
    chrome: new Set(rules.chrome),
    reject: new Set(rules.reject),
  };
}

/** The project's rules: elements/rules.json over the defaults (defaults without the file). */
export async function readRules(project) {
  const text = await readFile(rulesFile(project), 'utf8').catch(() => null);
  if (text === null) return mergeRules();
  let parsed;
  try { parsed = JSON.parse(text); } catch (err) {
    throw new Error(`rules.json is not valid JSON: ${err.message}`);
  }
  return mergeRules(parsed);
}
