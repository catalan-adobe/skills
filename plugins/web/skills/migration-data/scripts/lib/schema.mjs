// Schemas and their validator. Every file under migration/ names a registered schema
// (`<name>@<version>`) and a class; reads and writes go through `validate`. The validator
// covers the JSON Schema subset the model uses — no dependency.

/** The classes a file can have; the invariant test reads them. */
export const CLASSES = ['decision', 'raw', 'derived', 'run', 'history', 'evidence', 'view'];

const registry = new Map();

/** Registers a schema under `name@version` with its class. Later units add theirs. */
export function register(name, version, cls, schema) {
  if (!CLASSES.includes(cls)) throw new Error(`schema ${name}: unknown class "${cls}"`);
  registry.set(`${name}@${version}`, { name, version, cls, schema });
}

export const schemaOf = (ref) => registry.get(ref) ?? null;
export const classOf = (ref) => registry.get(ref)?.cls ?? null;
export const registered = () => [...registry.keys()];

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Validates `value` against `schema`; returns faults as `path: message`, empty when valid.
 * Supports type (and lists of types), properties, required, additionalProperties, enum,
 * const, items, minItems, pattern, minimum, maximum, format date-time, oneOf.
 */
export function faults(value, schema, path = '$') {
  const out = [];
  if (schema.const !== undefined && value !== schema.const) {
    return [`${path}: must be ${JSON.stringify(schema.const)}`];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return [`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`];
  }
  if (schema.type) {
    const types = [schema.type].flat();
    const actual = typeOf(value);
    const ok = types.includes(actual) || (actual === 'number' && types.includes('integer')
      && Number.isInteger(value));
    if (!ok) return [`${path}: must be ${types.join(' or ')}, is ${actual}`];
  }
  if (schema.oneOf) {
    const matching = schema.oneOf.filter((s) => faults(value, s, path).length === 0);
    if (matching.length !== 1) {
      return [`${path}: must match exactly one shape (matched ${matching.length})`];
    }
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      out.push(`${path}: must match ${schema.pattern}`);
    }
    if (schema.format === 'date-time' && !ISO.test(value)) {
      out.push(`${path}: must be an ISO 8601 date-time`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      out.push(`${path}: must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      out.push(`${path}: must be <= ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      out.push(`${path}: must have at least ${schema.minItems} items`);
    }
    if (schema.items) {
      value.forEach((v, i) => out.push(...faults(v, schema.items, `${path}[${i}]`)));
    }
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) out.push(`${path}.${key}: required`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) out.push(...faults(value[key], sub, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties ?? {}))) out.push(`${path}.${key}: not allowed`);
      }
    } else if (typeof schema.additionalProperties === 'object') {
      for (const [key, v] of Object.entries(value)) {
        if (!(key in (schema.properties ?? {}))) {
          out.push(...faults(v, schema.additionalProperties, `${path}.${key}`));
        }
      }
    }
  }
  return out;
}

/**
 * Validates a file's data: it names a registered schema and conforms to it. Throws with
 * the file and the first three faults; returns the schema entry when fine.
 */
export function validate(data, file, expected = null) {
  const ref = data?.schema;
  if (typeof ref !== 'string') throw new Error(`${file}: no "schema" field`);
  if (expected && ref !== expected) {
    throw new Error(`${file}: schema is ${ref}, expected ${expected}`);
  }
  const entry = registry.get(ref);
  if (!entry) {
    throw new Error(`${file}: unknown schema ${ref}; registered: ${registered().join(', ')}`);
  }
  const found = faults(data, entry.schema);
  if (found.length) {
    const shown = found.slice(0, 3).join('; ');
    throw new Error(`${file}: ${found.length} fault(s) against ${ref} — ${shown}`);
  }
  return entry;
}

/** The common head of every file: schema and updatedAt. */
export const HEAD = {
  schema: { type: 'string' },
  updatedAt: { type: 'string', format: 'date-time' },
};
