import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, writeJsonAtomic } from './state.mjs';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HEAD_FALLBACK_STATUSES = new Set([403, 405, 501]);
const MAX_REDIRECTS = 5;
const USER_AGENT = 'eds-migration-machine/0.1 '
  + '(+https://github.com/catalan-adobe/eds-migration-test-20260902)';
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const sha1 = (text) => createHash('sha1').update(text).digest('hex');

function backoffMs(attempt, retryAfterHeader) {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfterHeader !== null) return retryAfter * 1000;
  return 250 * 2 ** attempt;
}

/**
 * Creates the global request pacer: every call resolves at the next free time slot so the
 * whole client never exceeds `1000 / spacing` requests per second.
 *
 * @param {number} spacing Milliseconds between two consecutive requests.
 * @param {(ms: number) => Promise<void>} sleep
 * @returns {() => Promise<void>}
 */
function createSlotWaiter(spacing, sleep) {
  let nextSlot = 0;
  return async function waitForSlot() {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + spacing;
    if (at > now) await sleep(at - now);
  };
}

/**
 * Performs one request with retries on 429/5xx and network errors.
 *
 * @param {{fetchImpl: typeof fetch, userAgent: string, retries: number,
 *   sleep: (ms: number) => Promise<void>, waitForSlot: () => Promise<void>}} ctx
 * @param {string} url
 * @param {string} method
 * @returns {Promise<Response>}
 */
async function request(ctx, url, method) {
  const {
    fetchImpl, userAgent, retries, sleep, waitForSlot,
  } = ctx;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await waitForSlot();
      const res = await fetchImpl(url, {
        method,
        redirect: 'manual',
        headers: { 'user-agent': userAgent },
      });
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === retries) return res;
      await res.arrayBuffer().catch(() => {});
      await sleep(backoffMs(attempt, res.headers.get('retry-after')));
    } catch (err) {
      lastError = err;
      if (attempt === retries) throw err;
      await sleep(backoffMs(attempt, null));
    }
  }
  throw lastError;
}

/**
 * Follows same-host redirects and records the chain. A redirect to another host is not
 * fetched: the redirect response is returned with `finalUrl` pointing at the external target.
 *
 * @param {object} ctx Request context, see {@link request}.
 * @param {string} url
 * @param {string} method
 * @returns {Promise<{response: Response, finalUrl: string, chain: object[]}>}
 */
async function follow(ctx, url, method) {
  const chain = [];
  const { host } = new URL(url);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await request(ctx, current, method);
    const location = res.headers.get('location');
    if (!REDIRECT_STATUSES.has(res.status) || !location) {
      return { response: res, finalUrl: current, chain };
    }
    chain.push({ url: current, status: res.status });
    current = new URL(location, current).href;
    if (new URL(current).host !== host) return { response: res, finalUrl: current, chain };
  }
  throw new Error(`Too many redirects (> ${MAX_REDIRECTS}) starting at ${url}`);
}

/**
 * GETs a URL, serving and populating the on-disk cache for 200 responses.
 *
 * @param {object} ctx Request context plus `cacheDir`.
 * @param {string} url
 * @param {{cache?: boolean}} [options]
 * @returns {Promise<object>} The response record with `fromCache`.
 */
async function get(ctx, url, { cache = true } = {}) {
  const { cacheDir } = ctx;
  const cacheFile = cacheDir ? path.join(cacheDir, `${sha1(url)}.json`) : null;
  if (cache && cacheFile) {
    const hit = await readJson(cacheFile, null);
    if (hit) return { ...hit, fromCache: true };
  }
  const { response, finalUrl, chain } = await follow(ctx, url, 'GET');
  const result = {
    url,
    finalUrl,
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
    redirectChain: chain,
    fetchedAt: new Date().toISOString(),
  };
  if (cacheFile && result.status === 200) {
    await mkdir(cacheDir, { recursive: true });
    await writeJsonAtomic(cacheFile, result);
  }
  return { ...result, fromCache: false };
}

/**
 * Resolves a URL with HEAD, falling back to GET when HEAD fails or is not allowed.
 *
 * @param {object} ctx Request context, see {@link request}.
 * @param {string} url
 * @returns {Promise<{response: Response, finalUrl: string, chain: object[]}>}
 * @throws {Error} When both HEAD and GET fail; `cause` carries the GET error.
 */
async function resolveOutcome(ctx, url) {
  let headError = null;
  const outcome = await follow(ctx, url, 'HEAD').catch((err) => {
    headError = err;
    console.error(`HEAD ${url} failed (${err.message}); retrying with GET`);
    return null;
  });
  if (outcome && !HEAD_FALLBACK_STATUSES.has(outcome.response.status)) return outcome;
  const viaGet = await follow(ctx, url, 'GET').catch((err) => {
    if (!headError) throw err;
    throw new Error(
      `HEAD failed: ${headError.message}; GET failed: ${err.message}`,
      { cause: err },
    );
  });
  await viaGet.response.arrayBuffer();
  return viaGet;
}

/**
 * Probes a URL for its final status, redirect chain and whether it leaves the host.
 *
 * @param {object} ctx Request context, see {@link request}.
 * @param {string} url
 * @returns {Promise<{url: string, status: number, finalUrl: string,
 *   redirectChain: object[], external: boolean}>}
 */
async function probe(ctx, url) {
  const { response, finalUrl, chain } = await resolveOutcome(ctx, url);
  return {
    url,
    status: response.status,
    finalUrl,
    redirectChain: chain,
    external: new URL(finalUrl).host !== new URL(url).host,
  };
}

/**
 * Creates a polite HTTP client: global request spacing, retries on 429/5xx/network errors,
 * on-disk cache for 200 responses, and manual redirect following that records the chain.
 *
 * @param {object} [options]
 * @param {number} [options.requestsPerSecond=4]
 * @param {number} [options.retries=3]
 * @param {string|null} [options.cacheDir=null] Directory for cached responses (null disables).
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.userAgent=USER_AGENT]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @returns {{ get: Function, probe: Function }}
 */
export function createClient({
  requestsPerSecond = 4,
  retries = 3,
  cacheDir = null,
  fetchImpl = globalThis.fetch,
  userAgent = USER_AGENT,
  sleep = defaultSleep,
} = {}) {
  const ctx = {
    fetchImpl,
    userAgent,
    retries,
    cacheDir,
    sleep,
    waitForSlot: createSlotWaiter(1000 / requestsPerSecond, sleep),
  };
  return {
    get: (url, options) => get(ctx, url, options),
    probe: (url) => probe(ctx, url),
  };
}
