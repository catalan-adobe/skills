/*
 * Query index runner (spec § 11.4, Plan D step 3).
 *
 * The index definition is site configuration, not a repo file: `helix-query.yaml` is retired and
 * `site/query.yaml` is the body of a Configuration Service call. Three commands:
 *
 *   - `push`   — POST the definition to admin.hlx.page. **Operator gate**: writing site
 *                configuration is an approval decision, so the command refuses to run without
 *                `--confirm` and prints what the operator has to approve.
 *   - `check <path>` — the admin API's per-page index endpoint, which shows what the indexer
 *                extracts from one document.
 *   - `status` — fetches `/query-index.json?limit=1` on the preview and the live host and
 *                reports the row count and the columns, or the 404 that says the index does not
 *                exist yet ("pages are indexed when they are published").
 *
 * The DA token (`loadToken`) authenticates every call. Measured on this site (2026-09-09):
 * admin.hlx.page answers 401 to the IMS token sent as `x-auth-token` alone and 404 — the
 * authenticated "no index configured yet" — when it also carries `authorization: Bearer`, which
 * is the form `da.mjs` already uses for preview and publish. Both headers are sent, so a
 * site-token from tools.aem.live works too. The token is never logged.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { loadToken } from './da.mjs';
import { resolvePaths } from './paths.mjs';

const USAGE = 'Usage: index.mjs push [--confirm] [--file <query.yaml>] | index.mjs check <path>'
  + ' | index.mjs status';
const GATE = 'Refusing to push: `POST /config/{org}/sites/{site}/content/query.yaml` writes the '
  + 'site configuration on admin.hlx.page, which is an operator decision (Plan D, decision 1). '
  + 'Re-run with --confirm once it is approved, or configure the index in the Index Admin tool '
  + 'at tools.aem.live.';
const CONTENT_TYPE = 'text/yaml';

const authHeaders = (token) => ({ authorization: `Bearer ${token}`, 'x-auth-token': token });

/** Absolute path of the committed index definition. */
export const queryFile = (paths = resolvePaths()) => path.join(paths.siteDir, 'query.yaml');

const renderHost = (da, channel) => `https://${da.ref}--${da.site}--${da.org}`
  + `.aem.${channel === 'live' ? 'live' : 'page'}`;

async function readBody(res) {
  const text = await res.text();
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { body: text.slice(0, 400) };
  }
}

function indexSummary(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  return {
    total: typeof body?.total === 'number' ? body.total : null,
    columns: rows.length ? Object.keys(rows[0]) : [],
  };
}

/**
 * Creates the index client.
 *
 * @param {object} options
 * @param {{org: string, site: string, ref: string, adminHost: string}} options.da The `da` block
 *   of `site.config.json`.
 * @param {string} options.token Admin API token (`x-auth-token`), from {@link loadToken}.
 * @param {object} [options.io] `{ fetchImpl, log }`.
 * @returns {{push: Function, check: Function, status: Function}}
 */
export function createIndexClient({ da, token, io = {} }) {
  const { fetchImpl = globalThis.fetch, log = () => {} } = io;
  const configUrl = `${da.adminHost}/config/${da.org}/sites/${da.site}/content/query.yaml`;

  /**
   * Writes the index definition. Refuses unless the operator confirmed it.
   *
   * @param {object} options
   * @param {string} options.yaml The definition, read from `site/query.yaml`.
   * @param {boolean} [options.confirm=false] Operator approval.
   * @returns {Promise<object>} `{ url, status, body }`.
   * @throws {Error} With the gate message when `confirm` is false.
   */
  async function push({ yaml, confirm = false }) {
    if (!confirm) throw new Error(GATE);
    log(`POST ${configUrl} (${yaml.length} bytes)`);
    const res = await fetchImpl(configUrl, {
      method: 'POST',
      headers: { 'content-type': CONTENT_TYPE, ...authHeaders(token) },
      body: yaml,
    });
    return {
      url: configUrl, status: res.status, ok: res.ok, ...(await readBody(res)),
    };
  }

  /**
   * Reads what the indexer extracts from one document.
   *
   * @param {object} options
   * @param {string} options.path Content path, for example `/blog/zapier-guide`.
   * @returns {Promise<object>} `{ url, status, ok, body }`.
   */
  async function check({ path: target }) {
    const doc = `/${String(target).replace(/^\/+/, '')}`;
    const url = `${da.adminHost}/index/${da.org}/${da.site}/${da.ref}${doc}`;
    const res = await fetchImpl(url, { method: 'GET', headers: authHeaders(token) });
    return {
      url, status: res.status, ok: res.ok, ...(await readBody(res)),
    };
  }

  async function hostStatus(channel) {
    const url = `${renderHost(da, channel)}/query-index.json?limit=1`;
    const res = await fetchImpl(url, { method: 'GET' });
    const { body } = await readBody(res);
    if (!res.ok) {
      return {
        channel, url, status: res.status, exists: false, total: null, columns: [],
      };
    }
    return {
      channel, url, status: res.status, exists: true, ...indexSummary(body),
    };
  }

  /**
   * Reports the index on the preview and the live host.
   *
   * @returns {Promise<{preview: object, live: object}>} Each side carries `exists`, `total` and
   *   the columns of the first row; a 404 means the index has not been built there yet.
   */
  async function status() {
    const [preview, live] = await Promise.all([hostStatus('page'), hostStatus('live')]);
    return { preview, live };
  }

  return { push, check, status };
}

const COMMANDS = {
  push: async (client, { argv, file }) => client.push({
    yaml: await readFile(file, 'utf8'),
    confirm: argv.includes('--confirm'),
  }),
  check: (client, { target }) => client.check({ path: target }),
  status: (client) => client.status(),
};

async function cli(argv) {
  const [cmd, target] = argv.filter((arg, i) => !arg.startsWith('--')
    && !(i > 0 && argv[i - 1].startsWith('--')));
  const run = COMMANDS[cmd];
  if (!run) throw new Error(USAGE);
  if (cmd === 'check' && !target) throw new Error(USAGE);
  const paths = resolvePaths();
  const config = await loadConfig(paths.configPath);
  const { token } = await loadToken();
  const client = createIndexClient({
    da: config.da,
    token,
    io: { log: (message) => console.error(`[index] ${message}`) },
  });
  const flagIndex = argv.indexOf('--file');
  return run(client, {
    argv, target, file: flagIndex >= 0 ? argv[flagIndex + 1] : queryFile(paths),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
