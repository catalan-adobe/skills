// Shared by the integration tests: where the real siblings are, a fixture site on loopback,
// and a skip that says what is missing. Nothing here reaches the internet.
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const execFileP = promisify(execFile);

/** A scratch directory for playwright-cli's own logs and snapshots (it writes into cwd). */
export const scratch = await (await import('node:fs/promises')).mkdtemp(
  path.join(os.tmpdir(), 'cpv2-pw-'),
);
/** playwright-cli in `session`, run from the scratch directory. */
export const pw = (cli, session, ...args) => execFileP(cli, [`-s=${session}`, ...args], {
  cwd: scratch,
});
const skillDir = fileURLToPath(new URL('../..', import.meta.url));
const exists = (p) => access(p).then(() => true, () => false);

/** The page-cache proxy script: the sibling in this repository, else an installed copy. */
export async function pageCacheScript() {
  const candidates = [
    path.join(skillDir, '..', 'page-cache', 'scripts', 'page-cache.js'),
    path.join(process.cwd(), '.agents', 'skills', 'page-cache', 'scripts', 'page-cache.js'),
    path.join(os.homedir(), '.agents', 'skills', 'page-cache', 'scripts', 'page-cache.js'),
  ];
  for (const c of candidates) if (await exists(c)) return c;
  return null;
}

/** A command on PATH, or null. */
export async function onPath(cmd) {
  return execFileP('which', [cmd]).then(({ stdout }) => stdout.trim() || null, () => null);
}

/** Skips the test with a clear message when a sibling is missing; returns it otherwise. */
export async function need(t, what, locate) {
  const found = await locate();
  if (!found) t.skip(`${what} not installed — install it to run this contract test`);
  return found;
}

const PAGE = (title, extra = '') => `<!DOCTYPE html><html lang="en"><head><title>${title}</title>`
  + `<link rel="stylesheet" href="/theme.css"></head><body><main><h1>${title}</h1>`
  + `<p>Body of ${title}.</p></main>${extra}</body></html>`;
const BANNER = '<div id="cmp" style="position:fixed;bottom:0;left:0;right:0;height:120px;'
  + 'background:#333;color:#fff">We use cookies <button id="accept">Accept</button></div>';

/**
 * A small site on 127.0.0.1: pages with a stylesheet, a cookie banner on the home page, a
 * 301, a 404, a PDF, a client-side redirect and a sitemap. Returns `{ origin, hits, close }`.
 */
export async function startSite() {
  const hits = [];
  const routes = {
    '/': () => [200, 'text/html', PAGE('Home', BANNER)],
    '/a.html': () => [200, 'text/html', PAGE('Page A')],
    '/b.html': () => [200, 'text/html', PAGE('Page B')],
    '/old.html': () => [301, null, '', { location: '/a.html' }],
    '/hop.html': () => [302, null, '', { location: '/old.html' }],
    '/jump.html': () => [200, 'text/html', PAGE('Jump',
      '<script>location.replace("/b.html")</script>')],
    '/doc.pdf': () => [200, 'application/pdf', '%PDF-1.4 fixture'],
    '/theme.css': () => [200, 'text/css', 'body { margin: 0 }'],
    '/sitemap.xml': (origin) => [200, 'application/xml',
      `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
        ['/', '/a.html', '/b.html', '/old.html', '/missing.html', '/doc.pdf', '/jump.html']
          .map((p) => `<url><loc>${origin}${p}</loc></url>`).join('')}</urlset>`],
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    hits.push(url.pathname);
    const route = routes[url.pathname];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end(PAGE('Not found'));
      return;
    }
    const [status, type, body, headers = {}] = route(`http://127.0.0.1:${server.address().port}`);
    res.writeHead(status, { ...(type ? { 'content-type': type } : {}), ...headers });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    hits,
    close: () => new Promise((r) => server.close(r)),
  };
}
