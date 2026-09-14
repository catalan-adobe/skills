#!/usr/bin/env node
/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0.
 *
 * page-cache — Caching reverse proxy for web page archival.
 * Node 22+, zero npm dependencies.
 *
 * Modeled on helix-cli's import --cache: each response is stored as a body
 * file plus a JSON sidecar ({ headers, status }). The browser sets an origin
 * cookie on the first ?_origin= request; subsequent sub-resource requests
 * reuse it so every asset flows through the proxy and gets cached.
 */

import { createServer } from 'node:http';
import {
  readFileSync, writeFileSync, mkdirSync,
  existsSync, readdirSync,
} from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

/* ------------------------------------------------------------------ */
/*  CLI                                                                */
/* ------------------------------------------------------------------ */

const { values: opts } = parseArgs({
  options: {
    port: { type: 'string', short: 'p', default: '3001' },
    cache: { type: 'string', short: 'c', default: '.page-cache' },
    offline: { type: 'boolean', default: false },
    timeout: { type: 'string', short: 't', default: '30000' },
  },
  strict: true,
});

const PORT = parseInt(opts.port, 10);
const CACHE_DIR = resolve(opts.cache);
const OFFLINE = opts.offline;
const FETCH_TIMEOUT = parseInt(opts.timeout, 10);

mkdirSync(CACHE_DIR, { recursive: true });

const stats = { hits: 0, misses: 0, errors: 0 };

// Origins seen via explicit ?_origin= top-level requests. Cookie-based
// requests are only served if their origin is in this set — prevents
// page JS from using the proxy to probe arbitrary hosts (SSRF guard).
// In offline mode the check is skipped: no fetch ever reaches the
// network, so SSRF is impossible.
const allowedOrigins = new Set();

// URLs currently being fetched. Prevents concurrent duplicate fetches
// for the same resource from producing split body/metadata files.
const inFlight = new Map();

/* ------------------------------------------------------------------ */
/*  Cache I/O                                                          */
/* ------------------------------------------------------------------ */

/**
 * Map a full URL to a filesystem cache path.
 * The origin directory uses hostname + an 8-char hash of the full
 * origin to avoid collisions (different schemes, ports, or Punycode
 * hostnames containing `--`).
 *   https://example.com      → example.com_a1b2c3d4/
 *   http://localhost:8080     → localhost_e5f6a7b8/
 */
function cachePath(url) {
  const u = new URL(url);
  const originHash = createHash('sha256')
    .update(u.origin).digest('hex').slice(0, 8);
  const originDir = `${u.hostname}_${originHash}`;
  let seg = u.pathname.substring(1);
  if (seg === '' || seg.endsWith('/')) {
    seg += 'index.html';
  } else if (!extname(seg)) {
    seg += '/index.html';
  }
  let p = join(originDir, seg);
  if (u.search) {
    let qs = u.search.substring(1);
    if (p.length + qs.length > 200) {
      qs = createHash('md5').update(qs).digest('hex');
    }
    const ext = extname(p);
    p = ext
      ? `${p.slice(0, -ext.length)}!${qs}${ext}`
      : `${p}!${qs}`;
  }
  return resolve(CACHE_DIR, p);
}

function cacheRead(url) {
  const fp = cachePath(url);
  if (!existsSync(fp) || !existsSync(`${fp}.json`)) return null;
  const { headers, status } = JSON.parse(readFileSync(`${fp}.json`, 'utf-8'));
  return { body: readFileSync(fp), headers, status };
}

function cacheWrite(url, { body, headers, status }) {
  const fp = cachePath(url);
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, body);
  writeFileSync(`${fp}.json`, JSON.stringify({ headers, status }));
}

function cacheCount(dir = CACHE_DIR) {
  let n = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) n += cacheCount(join(dir, e.name));
      else if (!e.name.endsWith('.json')) n += 1;
    }
  } catch { /* empty or missing dir */ }
  return n;
}

/* ------------------------------------------------------------------ */
/*  URL rewriting                                                      */
/* ------------------------------------------------------------------ */

function getCharset(contentType) {
  const m = contentType.match(/charset=([^\s;]+)/i);
  return m ? m[1].toLowerCase().replace(/^["']|["']$/g, '') : null;
}

function rewriteUrls(buf, origin, contentType) {
  const charset = getCharset(contentType);
  if (charset && charset !== 'utf-8' && charset !== 'utf8') return buf;

  const esc = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let text = buf.toString('utf-8');
  // HTML src / href / action attributes
  const htmlRe = new RegExp(
    `(src|href|action)\\s*=\\s*(["'])${esc}(/[^"']*)?\\2`,
    'gi',
  );
  text = text.replace(htmlRe, (_, attr, q, p) => `${attr}=${q}${p || '/'}${q}`);
  // srcset attribute — strip origin from each comma-separated entry
  const srcsetRe = new RegExp(
    `(srcset)\\s*=\\s*(["'])([^"']*?)\\2`,
    'gi',
  );
  const originRe = new RegExp(`${esc}(?=/)`, 'g');
  text = text.replace(srcsetRe, (_, attr, q, val) => {
    const rewritten = val.replace(originRe, '');
    return `${attr}=${q}${rewritten}${q}`;
  });
  // CSS url() references
  const cssRe = new RegExp(
    `url\\(\\s*(['"]?)${esc}(/[^)'"]*?)\\1\\s*\\)`,
    'gi',
  );
  text = text.replace(cssRe, (_, q, p) => `url(${q}${p}${q})`);
  return Buffer.from(text, 'utf-8');
}

/* ------------------------------------------------------------------ */
/*  Cookie helper                                                      */
/* ------------------------------------------------------------------ */

function getCookie(header, name) {
  const m = (header || '').match(new RegExp(`(?:^|;)\\s*${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Returns true when the request comes from a top-level navigation or a
 * tool (curl, agent). Returns false when sent by JS on a proxied page.
 *
 * Uses Sec-Fetch-Site: browsers set it on every request and page JS
 * cannot override it (Forbidden header). Absent header means the
 * request came from a non-browser client (curl, Node.js fetch, agent
 * tooling) — exactly the callers we want to trust.
 */
function isDirectRequest(req) {
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'none';
}

/* ------------------------------------------------------------------ */
/*  Request handler                                                    */
/* ------------------------------------------------------------------ */

async function handle(req, res) {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

  // ---- only GET / HEAD ----
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {
      allow: 'GET, HEAD',
      'content-type': 'text/plain',
    });
    res.end(`Method ${req.method} not allowed.\n`);
    return;
  }

  // ---- control endpoints ----
  if (reqUrl.pathname === '/__status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ...stats,
      cached: cacheCount(),
      dir: CACHE_DIR,
      offline: OFFLINE,
    }));
    return;
  }
  if (reqUrl.pathname === '/__stop') {
    if (!isDirectRequest(req)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Forbidden.\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Shutting down.\n');
    server.close();
    return;
  }

  // ---- resolve origin ----
  let host = reqUrl.searchParams.get('_origin');
  const fromParam = !!host;
  if (!host) host = getCookie(req.headers.cookie, 'page-cache-origin');
  if (!host) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(
      'Missing ?_origin= parameter.\n'
      + `Usage: http://localhost:${PORT}/path?_origin=https://example.com\n`,
    );
    return;
  }

  let origin;
  try {
    origin = new URL(host).origin;
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(`Invalid origin URL: ${host}\n`);
    return;
  }

  // Only direct requests (top-level nav, curl) may introduce new
  // origins. Page JS (Sec-Fetch-Site: same-origin) cannot — this
  // prevents cached pages from enrolling arbitrary SSRF targets.
  if (fromParam && isDirectRequest(req)) {
    allowedOrigins.add(origin);
  }

  // In offline mode SSRF is impossible (no upstream fetch), so skip
  // the allow-list. In online mode, reject unknown origins.
  if (!OFFLINE && !allowedOrigins.has(origin)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end(`Origin not allowed: ${origin}\n`);
    return;
  }

  reqUrl.searchParams.delete('_origin');
  const qs = reqUrl.searchParams.toString();
  const originUrl = `${origin}${reqUrl.pathname}${qs ? `?${qs}` : ''}`;
  const cookie = `page-cache-origin=${encodeURIComponent(origin)}; Path=/`;

  // ---- serve from cache ----
  const cached = cacheRead(originUrl);
  if (cached) {
    stats.hits += 1;
    console.log(`\x1b[32m[hit]\x1b[0m  ${originUrl}`);
    res.writeHead(cached.status, {
      ...cached.headers,
      'x-page-cache': 'hit',
      'access-control-allow-origin': '*',
      'set-cookie': cookie,
    });
    res.end(req.method === 'HEAD' ? undefined : cached.body);
    return;
  }

  // ---- offline miss ----
  if (OFFLINE) {
    stats.misses += 1;
    console.log(`\x1b[33m[miss]\x1b[0m ${originUrl} (offline)`);
    res.writeHead(504, { 'content-type': 'text/plain' });
    res.end(`Cache miss (offline): ${originUrl}\n`);
    return;
  }

  // ---- deduplicate in-flight fetches ----
  if (inFlight.has(originUrl)) {
    try {
      await inFlight.get(originUrl);
      // Fetch completed — should be in cache now.
      const fresh = cacheRead(originUrl);
      if (fresh) {
        stats.hits += 1;
        console.log(`\x1b[32m[hit]\x1b[0m  ${originUrl} (waited)`);
        res.writeHead(fresh.status, {
          ...fresh.headers,
          'x-page-cache': 'hit',
          'access-control-allow-origin': '*',
          'set-cookie': cookie,
        });
        res.end(req.method === 'HEAD' ? undefined : fresh.body);
        return;
      }
    } catch { /* first fetch failed — fall through and retry */ }
  }

  // ---- fetch from origin ----
  const doFetch = async () => {
    console.log(`\x1b[36m[fetch]\x1b[0m ${originUrl}`);

    const fwd = { ...req.headers };
    for (const k of [
      'host', 'cookie', 'connection', 'referer', 'accept-encoding',
    ]) {
      delete fwd[k];
    }

    const resp = await fetch(originUrl, {
      method: 'GET',
      headers: fwd,
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    const ct = resp.headers.get('content-type') || 'text/plain';
    let body = Buffer.from(await resp.arrayBuffer());

    // clean response headers
    const rh = {};
    resp.headers.forEach((v, k) => { rh[k] = v; });
    for (const k of [
      'content-encoding', 'content-length',
      'x-frame-options', 'content-security-policy', 'set-cookie',
    ]) {
      delete rh[k];
    }
    rh['access-control-allow-origin'] = '*';
    rh['x-page-cache'] = 'miss';

    // rewrite redirect Location
    if (rh.location) {
      try {
        const loc = new URL(rh.location, originUrl);
        if (loc.origin === origin) {
          rh.location = loc.pathname + loc.search;
        }
      } catch { /* keep original */ }
    }

    // rewrite absolute URLs in text content
    if (ct.includes('html') || ct.includes('css')) {
      body = rewriteUrls(body, origin, ct);
    }

    // persist to cache — errors must not block the response
    try {
      cacheWrite(originUrl, { body, headers: rh, status: resp.status });
      console.log(`\x1b[35m[cached]\x1b[0m ${originUrl} (${resp.status})`);
    } catch (writeErr) {
      console.error(
        `\x1b[31m[cache-write-error]\x1b[0m ${originUrl}: ${writeErr.message}`,
      );
    }

    return { body, headers: rh, status: resp.status };
  };

  try {
    stats.misses += 1;
    const promise = doFetch();
    inFlight.set(originUrl, promise);
    const result = await promise;
    inFlight.delete(originUrl);

    result.headers['set-cookie'] = cookie;
    res.writeHead(result.status, result.headers);
    res.end(req.method === 'HEAD' ? undefined : result.body);
  } catch (err) {
    inFlight.delete(originUrl);
    if (err.name === 'TimeoutError') {
      stats.errors += 1;
      console.error(`\x1b[31m[timeout]\x1b[0m ${originUrl}`);
      if (!res.headersSent) {
        res.writeHead(504, { 'content-type': 'text/plain' });
        res.end(`Fetch timed out: ${originUrl}\n`);
      }
      return;
    }
    stats.errors += 1;
    console.error(`\x1b[31m[error]\x1b[0m ${originUrl}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`Proxy error: ${err.message}\n`);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Start server                                                       */
/* ------------------------------------------------------------------ */

const server = createServer(handle);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n\x1b[1mpage-cache\x1b[0m proxy on http://localhost:${PORT}`);
  console.log(`  Cache:   ${CACHE_DIR}`);
  console.log(`  Mode:    ${OFFLINE ? 'offline (cache only)' : 'online (fetch + cache)'}`);
  console.log(`  Timeout: ${FETCH_TIMEOUT}ms`);
  console.log(
    `\nUsage: http://localhost:${PORT}/path?_origin=https://example.com\n`,
  );
});

process.on('SIGINT', () => { console.log('\nStopping...'); server.close(); });
process.on('SIGTERM', () => server.close());
