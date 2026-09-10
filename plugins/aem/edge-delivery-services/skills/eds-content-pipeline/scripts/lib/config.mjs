import { readFile } from 'node:fs/promises';
import { resolvePaths } from './paths.mjs';

const REQUIRED = [
  'origin', 'sitemapIndex', 'exclusions', 'overlaySelectors', 'viewports',
  'concurrency', 'rateLimit', 'thresholds', 'bundles', 'templateSeeds', 'da',
  'templates',
];

const DA_REQUIRED = ['org', 'site', 'ref', 'adminHost', 'sourceHost'];
const TEMPLATE_REQUIRED = ['sourceRoot', 'needsBrowser', 'sourceUrlPattern'];

/**
 * Validates the `da` object within the site configuration.
 *
 * @param {object} da The DA configuration block.
 * @param {string} configPath Path of the config file, for error messages.
 * @throws {Error} When a required DA key is absent.
 */
function assertDa(da, configPath) {
  const missing = DA_REQUIRED.filter((k) => !da[k]);
  if (missing.length) {
    throw new Error(`site.config.json da missing: ${missing.join(', ')} (${configPath})`);
  }
}



/**
 * Validates the `bundles` object contains only `pageTree`.
 *
 * @param {object} bundles The bundles configuration block.
 * @param {string} configPath Path of the config file, for error messages.
 * @throws {Error} When bundles does not contain exactly { pageTree }.
 */
function assertBundles(bundles, configPath) {
  const keys = Object.keys(bundles ?? {});
  if (keys.length !== 1 || keys[0] !== 'pageTree') {
    throw new Error(
      `site.config.json bundles.pageTree required (${configPath})`,
    );
  }
}

const THRESHOLD_DEFAULTS = {
  clusterSimilarity: 0.8,
  minClusterSize: 5,
  representativesPerTemplate: 3,
  coverage: 0.95,
  fidelity: { recall: 0.9, precision: 0.95 },
  newTemplateMin: 5,
};

/**
 * Applies defaults to config for include, originAliases, and thresholds.
 *
 * @param {object} config The loaded configuration.
 * @returns {object} Config with defaults applied.
 */
function withDefaults(config) {
  return {
    ...config,
    include: config.include ?? [],
    originAliases: config.originAliases ?? [config.origin],
    thresholds: { ...THRESHOLD_DEFAULTS, ...config.thresholds },
  };
}

/**
 * Lowercase hostnames of every origin alias, `www.` stripped.
 *
 * @param {object} config The configuration with originAliases.
 * @returns {string[]} Lowercase hostnames without `www.` prefix.
 */
export function originAliasHosts(config) {
  return config.originAliases.map(
    (o) => new URL(o).hostname.replace(/^www\./i, '').toLowerCase(),
  );
}

/**
 * Validates one `templates.<name>` entry.
 *
 * @param {string} name Template name, e.g. `case-study`.
 * @param {object} entry The template configuration entry.
 * @param {string} configPath Path of the config file, for error messages.
 * @throws {Error} When a required key is missing, `needsBrowser` is not boolean, or
 *   `sourceUrlPattern` does not compile as a regular expression.
 */
function assertTemplateEntry(name, entry, configPath) {
  const missing = TEMPLATE_REQUIRED.filter((k) => !(k in entry));
  if (missing.length) {
    throw new Error(
      `site.config.json templates.${name} missing: ${missing.join(', ')} (${configPath})`,
    );
  }
  if (typeof entry.needsBrowser !== 'boolean') {
    throw new Error(
      `site.config.json templates.${name}.needsBrowser must be boolean (${configPath})`,
    );
  }
  try {
    // eslint-disable-next-line no-new
    new RegExp(entry.sourceUrlPattern);
  } catch {
    throw new Error(
      `site.config.json templates.${name}.sourceUrlPattern is not a valid regexp (${configPath})`,
    );
  }
}

/**
 * Validates the `templates` object within the site configuration.
 *
 * @param {object} templates Map of template name to its configuration entry.
 * @param {string} configPath Path of the config file, for error messages.
 * @throws {Error} When `templates` is not a plain object, or an entry is invalid.
 */
function assertTemplates(templates, configPath) {
  if (typeof templates !== 'object' || templates === null || Array.isArray(templates)) {
    throw new Error(`site.config.json templates must be an object (${configPath})`);
  }
  for (const [name, entry] of Object.entries(templates)) {
    assertTemplateEntry(name, entry, configPath);
  }
}

const GATE_LAYERS = ['L1', 'L2', 'L3'];

/**
 * Validates `thresholds.scorecard.gateLayers` and its sibling `gateLayersNote`.
 *
 * @param {object} scorecard The `thresholds.scorecard` configuration block.
 * @param {string} configPath Path of the config file, for error messages.
 * @throws {Error} When `gateLayers` is not a non-empty array of `L1`|`L2`|`L3`, or
 *   `gateLayersNote` is present but not a string.
 */
function assertGateLayers(scorecard, configPath) {
  const { gateLayers, gateLayersNote } = scorecard;
  if (gateLayers === undefined) return;
  if (!Array.isArray(gateLayers) || gateLayers.length === 0) {
    throw new Error(
      `site.config.json thresholds.scorecard.gateLayers must be a non-empty array (${configPath})`,
    );
  }
  if (gateLayers.some((layer) => !GATE_LAYERS.includes(layer))) {
    throw new Error('site.config.json thresholds.scorecard.gateLayers must only contain '
      + `"L1", "L2" or "L3" (${configPath})`);
  }
  if (gateLayersNote !== undefined && typeof gateLayersNote !== 'string') {
    throw new Error(
      `site.config.json thresholds.scorecard.gateLayersNote must be a string (${configPath})`,
    );
  }
}

const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isNumbers = (list) => Array.isArray(list) && list.every((one) => typeof one === 'number');
const isNames = (list) => Array.isArray(list) && list.length > 0 && list.every(isText);

/**
 * Validates the optional scope of one accept entry: the viewport widths and template names it
 * applies to. An absent scope means every viewport, or every template.
 *
 * @param {{viewports?: number[], templates?: string[]}} entry The accept entry.
 * @param {(key: string, expected: string) => Error} bad Builds the error of one key.
 * @throws {Error} When `viewports` or `templates` is present and malformed.
 */
function assertAcceptScope({ viewports, templates }, bad) {
  if (viewports !== undefined && !isNumbers(viewports)) {
    throw bad('viewports', 'an array of numbers');
  }
  if (templates !== undefined && !isNames(templates)) {
    throw bad('templates', 'a non-empty array of strings');
  }
}

/**
 * Validates one `thresholds.scorecard.accept` entry: the parity waiver of a recorded source
 * quirk, named by check, optionally narrowed to viewport widths and templates.
 *
 * @param {object} entry The accept entry.
 * @param {number} index Its position in the list, for error messages.
 * @param {string} configPath Path of the config file, for error messages.
 * @throws {Error} When `check` or `note` is not a non-empty string, `viewports` is present but
 *   is not an array of numbers, or `templates` is present but is not a non-empty string array.
 */
function assertAcceptEntry(entry, index, configPath) {
  const at = `site.config.json thresholds.scorecard.accept[${index}]`;
  const bad = (key, expected) => new Error(`${at}.${key} must be ${expected} (${configPath})`);
  const one = entry ?? {};
  if (!isText(one.check)) throw bad('check', 'a non-empty string, e.g. "h2.font-size"');
  if (!isText(one.note)) throw bad('note', 'a non-empty string saying why the drift is accepted');
  assertAcceptScope(one, bad);
}

/**
 * Validates `thresholds.scorecard.accept`, the parity equivalent of `lighthouse.accept`.
 *
 * @param {object} scorecard The `thresholds.scorecard` configuration block.
 * @param {string} configPath Path of the config file, for error messages.
 * @throws {Error} When `accept` is present but is not an array, or an entry is malformed.
 */
function assertAccept(scorecard, configPath) {
  const { accept } = scorecard;
  if (accept === undefined) return;
  if (!Array.isArray(accept)) {
    throw new Error(
      `site.config.json thresholds.scorecard.accept must be an array (${configPath})`,
    );
  }
  accept.forEach((entry, index) => assertAcceptEntry(entry, index, configPath));
}

/**
 * Validates the `thresholds` object within the site configuration.
 *
 * @param {object} thresholds The thresholds configuration block.
 * @param {string} configPath Path of the config file, for error messages.
 * @throws {Error} When `thresholds.scorecard` is present but is not a plain object, or its
 *   `gateLayers`/`gateLayersNote`/`accept` are malformed.
 */
function assertThresholds(thresholds, configPath) {
  const { scorecard } = thresholds;
  const isPlainObject = typeof scorecard === 'object' && scorecard !== null
    && !Array.isArray(scorecard);
  if (scorecard !== undefined && !isPlainObject) {
    throw new Error(`site.config.json thresholds.scorecard must be an object (${configPath})`);
  }
  if (!isPlainObject) return;
  assertGateLayers(scorecard, configPath);
  assertAccept(scorecard, configPath);
}

/**
 * Loads and validates the project configuration.
 *
 * @param {string} [configPath] Defaults to `tools/migration/site/site.config.json`.
 * @returns {Promise<object>} The parsed configuration.
 * @throws {Error} When the file is unreadable or required keys are missing.
 */
export async function loadConfig(configPath = resolvePaths().configPath) {
  const raw = JSON.parse(await readFile(configPath, 'utf8'));
  const missing = REQUIRED.filter((key) => !(key in raw));
  if (missing.length) {
    throw new Error(
      `site.config.json missing keys: ${missing.join(', ')} (${configPath})`,
    );
  }
  assertDa(raw.da, configPath);
  assertBundles(raw.bundles, configPath);
  assertTemplates(raw.templates, configPath);
  assertThresholds(raw.thresholds, configPath);
  return withDefaults(raw);
}
