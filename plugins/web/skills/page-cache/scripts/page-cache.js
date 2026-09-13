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
 * cookie on the first ?host= request; subsequent sub-resource requests reuse
 * it so every asset flows through the proxy and gets cached automatically.
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
  },
  strict: true,
});

const PORT = parseInt(opts.port, 10);
const CACHE_DIR = resolve(opts.cache);
const OFFLINE = opts.offline;

mkdirSync(CACHE_DIR, { recursive: true });

const stats = { hits: 0, misses: 0, errors: 0 };

/* ------------------------------------------------------------------ */
/*  Cache I/O                                                          */
/* ------------------------------------------------------------------ */

function cachePath(url) {
  const u = new URL(url);
  // Always treat paths as directories with an index file to avoid
  // collisions where /about (file) blocks /about/team (needs dir).
  let seg = u.pathname.substring(1);
  if (seg === '' || seg.endsWith('/')) {
    seg += 'index.html';
  } else if (!extname(seg)) {
    // No extension → treat as directory: /about → /about/index.html
    seg += '/index.html';
  }
  let p = join(u.hostname, seg);
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
  } catch { /* empty cache dir */ }
  return n;
}

/* ------------------------------------------------------------------ */
/*  URL rewriting                                                      */
/* ------------------------------------------------------------------ */

function rewriteUrls(buf, origin) {
  const esc = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let text = buf.toString('utf-8');
  // HTML src / href / action attributes
  const htmlRe = new RegExp(
    `(src|href|action)\\s*=\\s*(["'])${esc}(/[^"']*)?\\2`,
    'gi',
  );
  text = text.replace(htmlRe, (_, attr, q, p) => `${attr}=${q}${p || '/'}${q}`);
  // srcset attribute — each entry is "URL size_descriptor"
  const srcsetRe = new RegExp(
    `(srcset)\\s*=\\s*(["'])([^"']*?)\\2`,
    'gi',
  );
  const originRe = new RegExp(esc, 'g');
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

/* ------------------------------------------------------------------ */
/*  Request handler                                                    */
/* ------------------------------------------------------------------ */

async function handle(req, res) {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

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
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Shutting down.\n');
    server.close();
    return;
  }

  // ---- resolve origin ----
  let host = reqUrl.searchParams.get('host');
  if (!host) host = getCookie(req.headers.cookie, 'page-cache-host');
  if (!host) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(
      'Missing ?host= parameter.\n'
      + `Usage: http://localhost:${PORT}/path?host=https://example.com\n`,
    );
    return;
  }

  let origin;
  try {
    origin = new URL(host).origin;
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(`Invalid host URL: ${host}\n`);
    return;
  }
  reqUrl.searchParams.delete('host');
  const qs = reqUrl.searchParams.toString();
  const originUrl = `${origin}${reqUrl.pathname}${qs ? `?${qs}` : ''}`;
  const cookie = `page-cache-host=${encodeURIComponent(origin)}; Path=/`;

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
    res.end(cached.body);
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

  // ---- fetch from origin ----
  try {
    stats.misses += 1;
    console.log(`\x1b[36m[fetch]\x1b[0m ${originUrl}`);

    const fwd = { ...req.headers };
    for (const k of ['host', 'cookie', 'connection', 'referer', 'accept-encoding']) {
      delete fwd[k];
    }

    const resp = await fetch(originUrl, {
      method: req.method,
      headers: fwd,
      redirect: 'manual',
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
      body = rewriteUrls(body, origin);
    }

    // cache GET responses
    if (req.method === 'GET') {
      cacheWrite(originUrl, { body, headers: rh, status: resp.status });
      console.log(`\x1b[35m[cached]\x1b[0m ${originUrl} (${resp.status})`);
    }

    rh['set-cookie'] = cookie;
    res.writeHead(resp.status, rh);
    res.end(body);
  } catch (err) {
    stats.errors += 1;
    console.error(`\x1b[31m[error]\x1b[0m ${originUrl}: ${err.message}`);
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`Proxy error: ${err.message}\n`);
  }
}

/* ------------------------------------------------------------------ */
/*  Start server                                                       */
/* ------------------------------------------------------------------ */

const server = createServer(handle);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n\x1b[1mpage-cache\x1b[0m proxy on http://localhost:${PORT}`);
  console.log(`  Cache: ${CACHE_DIR}`);
  console.log(`  Mode:  ${OFFLINE ? 'offline (cache only)' : 'online (fetch + cache)'}`);
  console.log(`\nUsage: http://localhost:${PORT}/path?host=https://example.com\n`);
});

process.on('SIGINT', () => { console.log('\nStopping...'); server.close(); });
process.on('SIGTERM', () => server.close());
