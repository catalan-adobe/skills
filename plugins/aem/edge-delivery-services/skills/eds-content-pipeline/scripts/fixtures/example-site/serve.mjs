import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const TYPES = {
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.jpg': 'image/jpeg',
};

/**
 * Serves this directory on an ephemeral port; sitemap hosts are
 * rewritten to the origin.
 */
export async function startFixtureServer() {
  let origin;
  const server = http.createServer(async (req, res) => {
    const file = req.url === '/' ? 'index.html' : req.url.replace(/^\//, '');
    try {
      let body = await readFile(path.join(root, file));
      if (file.endsWith('.xml')) {
        body = body
          .toString()
          .replaceAll('https://fixture.example', origin);
      }
      const contentType = TYPES[path.extname(file)]
        ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': contentType });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    close: () => new Promise((r) => server.close(r)),
  };
}
