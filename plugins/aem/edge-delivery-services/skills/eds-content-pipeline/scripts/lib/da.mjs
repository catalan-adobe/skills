import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { resolvePaths } from './paths.mjs';
import { mapPool } from './pool.mjs';

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const ACTION = 'run `npx -y @adobe/aem-cli content clone --path /` to refresh the DA token '
  + '(or export DA_TOKEN)';
const WARN_MINUTES = 5;
const PATH_RE = /^\/[a-z0-9\-/.]*$/;
const USAGE = 'Usage: da.mjs preflight | get <path> | put <path> <file> | preview <path>'
  + ' | publish <path> --allow-publish';
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Raised when the DA token is absent, expired or rejected; carries the operator action. */
export class DaTokenError extends Error {
  /** @param {string} message Context, never containing the token itself. */
  constructor(message) {
    super(`${message}; ${ACTION}`);
    this.name = 'DaTokenError';
    this.action = ACTION;
  }
}

function jwtExpiry(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Loads the DA bearer token from the environment or the aem-cli token file.
 *
 * The token itself is never logged and never appears in thrown messages.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] Environment; `DA_TOKEN` wins over the file.
 * @param {string} [options.file] Token file; defaults to `<repo>/.hlx/.da-token.json`.
 * @returns {Promise<{token: string, expiresAt: number|null, source: string}>} Expiry in ms.
 * @throws {DaTokenError} When neither source yields an `access_token`.
 */
export async function loadToken({ env = process.env, file } = {}) {
  if (env.DA_TOKEN) {
    return { token: env.DA_TOKEN, expiresAt: jwtExpiry(env.DA_TOKEN), source: 'DA_TOKEN' };
  }
  const tokenFile = file ?? path.join(resolvePaths(env).repoRoot, '.hlx', '.da-token.json');
  const raw = await readFile(tokenFile, 'utf8').catch(() => {
    throw new DaTokenError(`DA_TOKEN is unset and ${tokenFile} is unreadable`);
  });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DaTokenError(`${tokenFile} is not valid JSON`);
  }
  if (typeof parsed.access_token !== 'string' || !parsed.access_token) {
    throw new DaTokenError(`${tokenFile} has no access_token`);
  }
  const expiresAt = typeof parsed.expires_at === 'number'
    ? parsed.expires_at : jwtExpiry(parsed.access_token);
  return { token: parsed.access_token, expiresAt, source: tokenFile };
}

/**
 * Normalizes a content path to its DA document path (leading slash, no `.html`).
 *
 * @param {string} input For example `/nav`, `nav.html` or `/`.
 * @returns {string} For example `/nav` or `/index`.
 * @throws {Error} When the path uses characters DA cannot address, or is too long.
 */
export function docPath(input) {
  const trimmed = `/${String(input).trim().replace(/^\/+/, '')}`.replace(/\.html$/, '');
  const doc = (trimmed.endsWith('/') ? `${trimmed}index` : trimmed).toLowerCase();
  if (doc.includes('..') || !PATH_RE.test(doc)) {
    throw new Error(`Invalid DA path "${input}": use lowercase a-z, 0-9, "-" and "/",`
      + ' e.g. /blog/my-post');
  }
  if (doc.length > 900) throw new Error(`DA path too long (${doc.length} > 900): ${doc}`);
  return doc;
}

/**
 * Normalizes a binary asset path, for example `/media/homepage/logo.png`.
 *
 * Unlike {@link docPath} the extension is part of the path: DA sniffs the content type from it.
 *
 * @param {string} input Asset path with a leading slash and a file extension.
 * @returns {string} Lowercased path.
 * @throws {Error} When the path is unaddressable or carries no extension.
 */
export function assetPath(input) {
  const asset = `/${String(input).trim().replace(/^\/+/, '')}`.toLowerCase();
  if (asset.includes('..') || !PATH_RE.test(asset)) {
    throw new Error(`Invalid DA asset path "${input}": use lowercase a-z, 0-9, "-", "." and "/",`
      + ' e.g. /media/homepage/logo.png');
  }
  if (!/\/[a-z0-9-]+\.[a-z0-9]+$/.test(asset)) {
    throw new Error(`DA asset path "${input}" needs a file extension, e.g. .png`);
  }
  return asset;
}

/** Maps a document path to the path the admin API and the preview host use (`/index` → `/`). */
export function livePath(doc) {
  return doc === '/index' ? '/' : doc;
}

function backoffMs(attempt, retryAfter) {
  const seconds = Number(retryAfter);
  if (retryAfter !== null && retryAfter !== undefined && Number.isFinite(seconds)) {
    return seconds * 1000;
  }
  return 1000 * 2 ** attempt;
}

function ensureAuthorized(res, method, url) {
  if (res.status === 401 || res.status === 403) {
    throw new DaTokenError(`${method} ${url} -> ${res.status}`);
  }
  return res;
}

/**
 * Builds the authenticated request with the single-401 grace: admin.hlx.page answered 401 to
 * one preview call in the middle of a valid session (2026-09-10) and the round
 * stopped on a token that preflight and the next call both proved good. The second 401 of one
 * request is the real expiry.
 *
 * @param {Function} fetchImpl Fetch implementation.
 * @param {string} token Bearer token.
 * @param {Function} sleep Delay function.
 * @param {Function} log Logger.
 * @returns {(url: string, init: object, grace: {left: boolean}) => Promise<Response>}
 */
function authorizedFetch(fetchImpl, token, sleep, log) {
  return async (url, init, grace) => {
    const headers = { ...init.headers, authorization: `Bearer ${token}` };
    const res = await fetchImpl(url, { ...init, headers });
    if (res.status !== 401 || !grace.left) return ensureAuthorized(res, init.method, url);
    grace.left = false;
    await res.arrayBuffer().catch(() => {});
    log(`${init.method} ${url} -> 401 once, retrying before declaring the token expired`);
    await sleep(backoffMs(0, null));
    return ensureAuthorized(await fetchImpl(url, { ...init, headers }), init.method, url);
  };
}

/**
 * Formats one failed response: status, truncated body and the `x-error` header DA and the
 * admin API use to explain refusals (for example `Images 15, 16 have failed validation`).
 *
 * @param {Response} res The non-2xx response.
 * @param {string} label Method and URL, for example `POST https://admin.hlx.page/preview/...`.
 * @param {string} [body] Response body, already read.
 * @returns {string} Message ending with ` — x-error: <text>` when the header is present.
 */
export function responseError(res, label, body = '') {
  const detail = `${label} -> ${res.status} ${body.slice(0, 200)}`.trim();
  const xError = res.headers?.get('x-error');
  return xError ? `${detail} — x-error: ${xError}` : detail;
}

async function readJsonBody(res, label) {
  const text = await res.text();
  if (!res.ok) throw new Error(responseError(res, label, text));
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * Checks the token expiry, then makes one authenticated call against the site listing.
 *
 * @param {object} ctx `{ da, send, expiresAt, tokenSource, log }` from the client closure.
 * @returns {Promise<object>} `{ ok, org, site, ref, tokenSource, expiresAt, expiresInMinutes }`.
 * @throws {DaTokenError} When the token is expired or rejected by DA.
 */
async function runPreflight({
  da, send, expiresAt, tokenSource, log,
}) {
  const now = Date.now();
  if (typeof expiresAt === 'number' && expiresAt <= now) {
    throw new DaTokenError(`DA token expired at ${new Date(expiresAt).toISOString()}`);
  }
  const minutes = typeof expiresAt === 'number' ? Math.floor((expiresAt - now) / 60000) : null;
  if (minutes !== null && minutes < WARN_MINUTES) log(`DA token expires in ${minutes} min`);
  const url = `${da.sourceHost}/list/${da.org}/${da.site}`;
  const res = await send(url, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`${responseError(res, `DA smoke call GET ${url}`)}; `
      + 'check "da" in site.config.json');
  }
  await res.arrayBuffer().catch(() => {});
  return {
    ok: true,
    org: da.org,
    site: da.site,
    ref: da.ref,
    tokenSource,
    expiresAt: typeof expiresAt === 'number' ? new Date(expiresAt).toISOString() : null,
    expiresInMinutes: minutes,
  };
}

/**
 * Creates the DA client: Source API reads/writes plus the preview and publish lifecycle.
 *
 * Retries 429 and 5xx (honoring `Retry-After`), turns 401/403 into {@link DaTokenError} and
 * caps batch helpers at `concurrency` requests in flight.
 *
 * @param {object} options
 * @param {{org: string, site: string, ref: string, adminHost: string, sourceHost: string}}
 *   options.da The `da` block of `site.config.json`.
 * @param {string} options.token Bearer token from {@link loadToken}.
 * @param {number|null} [options.expiresAt] Token expiry in ms, used by `preflight`.
 * @param {string} [options.tokenSource] Where the token came from, reported by `preflight`.
 * @param {object} [options.io] `{ concurrency = 10, retries = 3, fetchImpl, sleep, log }`.
 * @returns {{preflight: Function, putSource: Function, putBinary: Function, getSource: Function,
 *   deleteSource: Function, preview: Function, publish: Function, putAll: Function,
 *   previewAll: Function}}
 */
export function createDaClient({
  da, token, expiresAt = null, tokenSource = 'DA_TOKEN', io = {},
}) {
  const {
    concurrency = 10, retries = 3,
    fetchImpl = globalThis.fetch, sleep = defaultSleep, log = () => {},
  } = io;
  const sourceUrl = (doc) => `${da.sourceHost}/source/${da.org}/${da.site}${doc}.html`;
  const adminUrl = (action, doc) => `${da.adminHost}/${action}/${da.org}/${da.site}/${da.ref}`
    + `${livePath(doc)}`;
  const renderHost = (action) => `https://${da.ref}--${da.site}--${da.org}`
    + `.aem.${action === 'live' ? 'live' : 'page'}`;

  const deps = [fetchImpl, token, sleep, log];
  const fetchAuthorized = authorizedFetch(...deps);

  async function send(url, init) {
    let lastError;
    const grace = { left: true };
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const last = attempt === retries;
      try {
        const res = await fetchAuthorized(url, init, grace);
        if (last || !RETRYABLE.has(res.status)) return res;
        await res.arrayBuffer().catch(() => {});
        log(`${init.method} ${url} -> ${res.status}, retrying`);
        await sleep(backoffMs(attempt, res.headers.get('retry-after')));
      } catch (err) {
        if (last || err instanceof DaTokenError) throw err;
        lastError = err;
        await sleep(backoffMs(attempt, null));
      }
    }
    throw lastError;
  }

  async function putSource({ path: input, html, contentType = 'text/html' }) {
    const doc = docPath(input);
    const url = sourceUrl(doc);
    const form = new FormData();
    form.append('data', new Blob([html], { type: contentType }), `${doc.split('/').pop()}.html`);
    const res = await send(url, { method: 'PUT', body: form });
    const info = await readJsonBody(res, `PUT ${url}`);
    return { path: doc, status: res.status, ...info };
  }

  async function putBinary({ path: input, bytes, contentType }) {
    const asset = assetPath(input);
    const url = `${da.sourceHost}/source/${da.org}/${da.site}${asset}`;
    const form = new FormData();
    form.append('data', new Blob([bytes], { type: contentType }), asset.split('/').pop());
    const res = await send(url, { method: 'PUT', body: form });
    const info = await readJsonBody(res, `PUT ${url}`);
    return { path: asset, status: res.status, ...info };
  }

  async function getSource({ path: input }) {
    const doc = docPath(input);
    const url = sourceUrl(doc);
    const res = await send(url, { method: 'GET' });
    const text = await res.text();
    if (!res.ok && res.status !== 404) throw new Error(responseError(res, `GET ${url}`, text));
    return {
      path: doc, status: res.status, exists: res.ok, html: res.ok ? text : null,
    };
  }

  async function deleteSource({ path: input }) {
    const doc = docPath(input);
    const url = sourceUrl(doc);
    const res = await send(url, { method: 'DELETE' });
    await res.arrayBuffer().catch(() => {});
    if (!res.ok && res.status !== 404) throw new Error(responseError(res, `DELETE ${url}`));
    return { path: doc, status: res.status, deleted: res.ok };
  }

  async function lifecycle(action, input) {
    const doc = docPath(input);
    const url = adminUrl(action, doc);
    const res = await send(url, { method: 'POST' });
    const info = await readJsonBody(res, `POST ${url}`);
    return {
      path: doc,
      action,
      status: res.status,
      url: info[action]?.url ?? `${renderHost(action)}${livePath(doc)}`,
    };
  }

  const preflight = () => runPreflight({
    da, send, expiresAt, tokenSource, log,
  });
  const preview = ({ path: input }) => lifecycle('preview', input);
  const publish = ({ path: input }) => lifecycle('live', input);
  const putAll = (items) => mapPool(items, concurrency, (item) => putSource(item));
  const previewAll = (docs) => mapPool(docs, concurrency, (doc) => preview({ path: doc }));

  return {
    expiresAt,
    preflight,
    putSource,
    putBinary,
    getSource,
    deleteSource,
    preview,
    publish,
    putAll,
    previewAll,
  };
}

const COMMANDS = {
  preflight: (client) => client.preflight(),
  get: (client, { target }) => client.getSource({ path: target }),
  preview: (client, { target }) => client.preview({ path: target }),
  put: async (client, { target, file }) => client.putSource({
    path: target, html: await readFile(file, 'utf8'),
  }),
  publish: (client, { target, argv }) => {
    if (!argv.includes('--allow-publish')) {
      throw new Error('Refusing to publish: publishing is a human gate. '
        + 'Re-run with --allow-publish once the page is approved.');
    }
    return client.publish({ path: target });
  },
};

async function runCommand(client, ctx) {
  const run = COMMANDS[ctx.cmd];
  if (!run) throw new Error(USAGE);
  if (ctx.cmd !== 'preflight' && !ctx.target) throw new Error(USAGE);
  if (ctx.cmd === 'put' && !ctx.file) throw new Error(USAGE);
  return run(client, ctx);
}

async function cli(argv) {
  const [cmd, target, file] = argv.filter((arg) => !arg.startsWith('--'));
  const config = await loadConfig();
  const { token, expiresAt, source } = await loadToken();
  const client = createDaClient({
    da: config.da,
    token,
    expiresAt,
    tokenSource: source,
    io: { concurrency: config.concurrency.da, log: (msg) => console.error(`[da] ${msg}`) },
  });
  const result = await runCommand(client, {
    cmd, target, file, argv,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
