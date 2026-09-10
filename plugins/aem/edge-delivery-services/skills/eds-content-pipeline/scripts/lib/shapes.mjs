const SHAPES = {
  urls: {
    required: ['url', 'path', 'sitemapType', 'template', 'status'],
    enums: {
      status: ['excluded', 'todo', 'analyzed', 'imported', 'transformed', 'uploaded',
        'previewed', 'verified', 'long-tail', 'failed', 'published'],
    },
  },
  templates: {
    required: ['name', 'status'],
    enums: {
      status: ['todo', 'analyzing', 'building', 'transformer', 'samples', 'previewed', 'bulk',
        'done'],
    },
  },
  // Optional and unconstrained: template, variant, fixture, checks, attempts, source, sections.
  blocks: {
    required: ['name', 'status', 'updatedAt'],
    enums: {
      status: ['todo', 'building', 'passed', 'failed'],
    },
  },
  feedback: {
    required: ['id', 'receivedAt', 'channel', 'scope', 'text', 'status'],
    enums: {
      channel: ['chat', 'pr', 'file'],
      status: ['received', 'acknowledged', 'applied', 'verified', 'rejected'],
    },
  },
  runs: { required: ['runId', 'stage', 'startedAt', 'outcome'], enums: {} },
  units: { required: ['unitId', 'runId', 'kind', 'ref', 'verdict'], enums: {} },
};

/**
 * Validates a record against the shape registered for a state or ledger file.
 *
 * @param {string} name One of urls, templates, blocks, feedback, runs, units.
 * @param {object} record The record to validate.
 * @throws {Error} Naming the missing field or the invalid enum value.
 */
export function assertRecord(name, record) {
  const shape = SHAPES[name];
  if (!shape) throw new Error(`No shape registered for "${name}"`);
  const missing = shape.required.filter((f) => record[f] === undefined || record[f] === null);
  if (missing.length) {
    throw new Error(`${name} record ${JSON.stringify(record)} is missing: ${missing.join(', ')}`);
  }
  for (const [field, allowed] of Object.entries(shape.enums)) {
    if (record[field] !== undefined && !allowed.includes(record[field])) {
      throw new Error(`${name} record has invalid ${field} "${record[field]}"; `
        + `expected one of ${allowed.join(', ')}`);
    }
  }
}
