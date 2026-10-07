// The migration: source, target, plan, settings and the operator's approvals — the one
// decision file at the root of the store.
import { HEAD, register } from './schema.mjs';
import { id, openStore } from './store.mjs';

export const FILE = 'migration.json';
export const SCHEMA = 'migration/migration@1';

const URL_LIKE = '^https?://';
const nullable = (type) => ({ type: [type, 'null'] });

register('migration/migration', 1, 'decision', {
  type: 'object',
  required: ['schema', 'id', 'created', 'source', 'target', 'plan', 'settings', 'approvals'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    id: { type: 'string', pattern: '^mig-[0-9a-f]{12}$' },
    created: { type: 'string', format: 'date-time' },
    source: {
      type: 'object',
      required: ['origin', 'scope'],
      additionalProperties: false,
      properties: {
        origin: { type: 'string', pattern: URL_LIKE },
        scope: { type: 'string', pattern: URL_LIKE },
      },
    },
    target: {
      type: 'object',
      required: ['kind', 'repo'],
      additionalProperties: false,
      properties: {
        kind: { enum: ['eds'] },
        repo: { type: 'string' },
        owner: nullable('string'),
        site: nullable('string'),
      },
    },
    plan: {
      type: 'object',
      required: ['pages', 'selection'],
      additionalProperties: false,
      properties: {
        pages: { type: ['integer', 'null'], minimum: 1 },
        selection: nullable('string'),
      },
    },
    settings: {
      type: 'object',
      required: ['cacheAllUpTo', 'captureMinWidth', 'pace', 'skills'],
      additionalProperties: false,
      properties: {
        cacheAllUpTo: { type: 'integer', minimum: 0 },
        captureMinWidth: { type: 'integer', minimum: 1 },
        pace: { type: 'integer', minimum: 0 },
        skills: {
          type: 'object',
          required: ['repo', 'ref'],
          additionalProperties: false,
          properties: { repo: { type: 'string' }, ref: nullable('string') },
        },
      },
    },
    approvals: {
      type: 'object',
      additionalProperties: {
        oneOf: [{ const: true }, { type: 'array', items: { type: 'string' } }],
      },
    },
  },
});

export const DEFAULT_SETTINGS = {
  cacheAllUpTo: 500, captureMinWidth: 250, pace: 1500, skills: { repo: 'adobe/skills', ref: null },
};

/** A URL normalised to its canonical form (trailing slash on a bare origin). */
const canonical = (url) => {
  const u = new URL(url);
  return u.href;
};

/**
 * Creates the migration at `<cwd>/migration/migration.json`. Refuses an existing one: a
 * migration is created once; its settings, plan and approvals change through the setters.
 */
export async function init(cwd, { origin, scope, target = {}, plan = {}, settings = {} }) {
  const store = openStore(cwd);
  if (await store.exists(FILE)) {
    throw new Error(`${store.path(FILE)} exists; a migration is created once — edit it`
      + ' through the setters');
  }
  if (!origin) throw new Error('init needs the source origin, e.g. https://www.example.com/');
  const source = { origin: canonical(origin), scope: canonical(scope ?? origin) };
  if (!source.scope.startsWith(source.origin)) {
    throw new Error(`scope ${source.scope} is not under the origin ${source.origin}`);
  }
  const now = store.now();
  return store.write(FILE, {
    schema: SCHEMA,
    id: id('mig', `${source.origin}|${now.toISOString()}`),
    created: now.toISOString(),
    source,
    target: { kind: 'eds', repo: '.', owner: null, site: null, ...target },
    plan: { pages: null, selection: null, ...plan },
    settings: { ...DEFAULT_SETTINGS, ...settings,
      skills: { ...DEFAULT_SETTINGS.skills, ...(settings.skills ?? {}) } },
    approvals: {},
  });
}

/** The migration, or an error that names the command to run. */
export async function open(cwd) {
  const store = openStore(cwd);
  const data = await store.read(FILE, SCHEMA);
  if (!data) {
    throw new Error(`no migration at ${store.path(FILE)}; run: migration init --origin <url>`);
  }
  return data;
}

const update = async (cwd, change) => {
  const store = openStore(cwd);
  return store.write(FILE, change(await open(cwd)));
};

/** Changes one setting; `skills` takes an object merged over the current one. */
export const setting = (cwd, name, value) => update(cwd, (m) => ({
  ...m,
  settings: { ...m.settings,
    [name]: name === 'skills' ? { ...m.settings.skills, ...value } : value },
}));

/** Changes the plan: how many pages, or which selection. */
export const plan = (cwd, patch) => update(cwd, (m) => ({ ...m, plan: { ...m.plan, ...patch } }));

/**
 * Records the operator's yes for a gated step: selection names for `cache` (added to the
 * ones already approved), `true` for the others.
 */
export const approve = (cwd, step, what = true) => update(cwd, (m) => {
  const current = m.approvals[step];
  const value = Array.isArray(what)
    ? [...new Set([...(Array.isArray(current) ? current : []), ...what])] : true;
  return { ...m, approvals: { ...m.approvals, [step]: value } };
});
