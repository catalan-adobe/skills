/**
 * Reads the value that follows `name` in `argv`.
 *
 * @param {string[]} argv Arguments without the node/script prefix.
 * @param {string} name Flag name, e.g. `--type`.
 * @param {*} [fallback] Returned when the flag is absent.
 * @returns {*} The raw string value, or `fallback`.
 */
export function flag(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}

/**
 * Reads a flag that must carry a positive integer.
 *
 * @param {string[]} argv Arguments without the node/script prefix.
 * @param {string} name Flag name, e.g. `--limit`.
 * @param {*} [fallback] Returned when the flag is absent.
 * @returns {number|*} The parsed integer, or `fallback`.
 * @throws {Error} When the flag is present but not a positive integer.
 */
export function positiveIntFlag(argv, name, fallback) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const raw = argv[i + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected ${name} <positive integer>, got "${raw}"`);
  }
  return value;
}
