// The elements step's rules: defaults the engine runs with, and the per-project overrides
// from elements/rules.json — a bounded vocabulary, never code. Adaptation to a site happens
// here; anything the vocabulary cannot say is an engine gap.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_RULES = {
  // A node covering this share of the page height with children is a container.
  containerShare: 0.6,
  // A type on this many pages counts as recurring.
  recurrence: 2,
  // Class tokens dropped from an identity, as regular expressions; rules.json extends the
  // list. The default treats a class ending in one or two digits as a width (`col-sm-4`,
  // `aem-GridColumn--default--12`) — so `grid-3` and `grid-4` are one element too. State and
  // generated names are always out.
  identityExclusions: ['-\\d{1,2}$'],
  // Class tokens dropped from an identity, literally; rules.json extends the list.
  noiseClasses: [],
  // A node whose children are all of these tags is a leaf component: never peeled.
  leafTags: ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'IMG', 'A', 'SPAN', 'FIGURE',
    'BLOCKQUOTE', 'TABLE', 'PICTURE'],
  // Identities that are layout containers: decomposition continues into them, their
  // children are the sections, each recording it sat `within` the container.
  containers: [],
  // Identities that are fragments — a reference to another document inserted in the page
  // (an EDS element in its own right): decomposed like a document, and their distinct
  // contents tabulated as reuse candidates.
  fragments: [],
  // Type id → type id: the first is the second (two identities, one element).
  merge: {},
  // Selectors that are chrome after all (the chrome step missed them).
  chrome: [],
  // Selectors dropped before anything else.
  reject: [],
};

export const RULE_KEYS = Object.keys(DEFAULT_RULES);
const LIST_KEYS = ['identityExclusions', 'noiseClasses', 'leafTags', 'containers', 'fragments',
  'chrome', 'reject'];
const NUMBER_KEYS = ['containerShare', 'recurrence'];
export const rulesFile = (project) => path.join(project.step('elements'), 'rules.json');

const isStringList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
const fail = (msg) => { throw new Error(`rules.json: ${msg}`); };

function validate(rules) {
  for (const k of LIST_KEYS) {
    if (!isStringList(rules[k])) fail(`${k} must be a list of strings`);
  }
  for (const k of NUMBER_KEYS) {
    if (!Number.isFinite(rules[k])) fail(`${k} must be a number`);
  }
  const { merge } = rules;
  if (!merge || typeof merge !== 'object' || Array.isArray(merge)) {
    fail('merge must be an object of type id → type id');
  }
  for (const [from, to] of Object.entries(merge)) {
    if (typeof to !== 'string') fail(`merge: ${from} must point at a type id`);
    if (to in merge) {
      fail(`merge: target ${to} is itself merged into ${merge[to]}; point ${from} at ${merge[to]}`);
    }
  }
}

const regExp = (source, i) => {
  try { return new RegExp(source); } catch (err) {
    return fail(`identityExclusions[${i}] "${source}" is not a valid regular expression: `
      + err.message);
  }
};

/**
 * Defaults with `overrides` on top; an unknown key, a wrong shape, an invalid expression or
 * a merge chain is an error naming the fix. `_example` is ignored.
 */
export function mergeRules(overrides = {}) {
  const unknown = Object.keys(overrides).filter((k) => !RULE_KEYS.includes(k) && k !== '_example');
  if (unknown.length) {
    fail(`unknown key(s) ${unknown.join(', ')}; known: ${RULE_KEYS.join(', ')}`);
  }
  const { _example, ...rest } = overrides;
  const rules = { ...DEFAULT_RULES, ...rest };
  validate(rules);
  // The file's own expressions are checked under the file's indices, then extend the default.
  const ownExclusions = (rest.identityExclusions ?? []).map(regExp);
  for (const k of ['identityExclusions', 'noiseClasses']) {
    rules[k] = [...new Set([...DEFAULT_RULES[k], ...rules[k]])];
  }
  return {
    ...rules,
    // The rules as data, and their hash: a run records which rules produced it.
    raw: rules,
    hash: createHash('sha1').update(JSON.stringify(rules)).digest('hex').slice(0, 12),
    identityExclusions: [...DEFAULT_RULES.identityExclusions.map(regExp), ...ownExclusions],
    leafTags: new Set(rules.leafTags),
    noiseClasses: new Set(rules.noiseClasses),
    containers: new Set(rules.containers),
    fragments: new Set(rules.fragments),
    chrome: new Set(rules.chrome),
    reject: new Set(rules.reject),
  };
}

// What the first run writes: no rule, and the vocabulary shown once under a key the engine
// ignores. The operator or the agent edits this file; the engine never does again.
export const SEED = {
  _example: {
    containers: ['DIV#.layout-column'],
    fragments: ['DIV#.experience-fragment'],
    merge: { 't-aaaaaaaa': 't-bbbbbbbb' },
    chrome: ['body > div.cookie-bar'],
    reject: ['body > div.debug'],
    identityExclusions: ['-bg$', '^vert-pad-'],
    noiseClasses: ['clearfix'],
    containerShare: 0.6,
    recurrence: 2,
  },
};

/** Writes the seed unless a rules.json is there; returns whether it did. */
export async function seedRules(project) {
  const file = rulesFile(project);
  if (await readFile(file, 'utf8').then(() => true, () => false)) return false;
  await writeFile(file, `${JSON.stringify(SEED, null, 2)}\n`);
  return true;
}

/** The project's rules: elements/rules.json over the defaults (defaults without the file). */
export async function readRules(project) {
  const text = await readFile(rulesFile(project), 'utf8').catch(() => null);
  if (text === null) return mergeRules();
  let parsed;
  try { parsed = JSON.parse(text); } catch (err) {
    return fail(`not valid JSON: ${err.message}`);
  }
  return mergeRules(parsed);
}
