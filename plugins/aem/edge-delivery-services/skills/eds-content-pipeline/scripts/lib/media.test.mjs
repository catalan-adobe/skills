import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  assetName, createEncoder, createRasterizer, createSharpRasterizer, extractEmbeddedBitmap,
  fixDocument, FLATTEN_BACKGROUND, mediaHref, MAX_RASTER_WIDTH, MAX_SVG_SOURCE, rewriteImgSrc,
  serveSvg, SVG_RASTER_DENSITY,
} from './media.mjs';

const execFileP = promisify(execFile);
const mediaCli = fileURLToPath(new URL('./media.mjs', import.meta.url));
const DA = {
  org: 'org',
  site: 'site',
  ref: 'main',
  adminHost: 'https://admin.hlx.page',
  sourceHost: 'https://admin.da.live',
};
const LOGO = 'https://www.example.com/uploads/2023/06/url-2.svg';
const BADGE = 'https://www.example.com/uploads/2026/01/Trust-Badge-1.svg';
const SMALL = 'https://www.example.com/uploads/2026/04/seahawks.svg';
const HUGE = 'https://www.example.com/uploads/2024/07/Fire-Hall-in-Prosthetic-2.jpg';
const LEAN = 'https://www.example.com/uploads/2024/07/lean.jpg';
const PNG = Buffer.from('fake-png-bytes');

const wrapped = (mime = 'png') => '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<svg width="155px" height="32px" xmlns="http://www.w3.org/2000/svg"'
  + ' xmlns:xlink="http://www.w3.org/1999/xlink"><title>url 2</title><g>'
  + `<image xlink:href="data:image/${mime};base64,${PNG.toString('base64')}"`
  + ' width="155" height="32"></image></g></svg>';
const PLAIN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 316">'
  + '<path d="M0 0h1440v316H0z"/></svg>';
const COMPOSITE = 'https://www.example.com/uploads/2024/02/marketing-agency-tools.svg';
// A stand-in for a 7.9 MB composite illustration: over the browser command-line limit.
const composite = () => PLAIN
  .replace('/></svg>', `/><desc>${'x'.repeat(MAX_SVG_SOURCE)}</desc></svg>`);

function page(body) {
  return `<body><header></header><main><div>${body}</div></main><footer></footer></body>`;
}

function fakeFetch(routes) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      const method = init.method ?? 'GET';
      calls.push(`${method} ${url}`);
      const route = routes[url];
      if (!route) throw new Error(`unexpected ${method} ${url}`);
      if (method === 'HEAD') {
        return new Response('', { headers: { 'content-length': String(route.bytes) } });
      }
      return new Response(route.body, { status: 200 });
    },
  };
}

test('extractEmbeddedBitmap decodes a lone data-URI bitmap and ignores everything else', () => {
  const found = extractEmbeddedBitmap(wrapped());
  assert.equal(found.ext, 'png');
  assert.equal(found.contentType, 'image/png');
  assert.equal(found.bytes.toString('utf8'), 'fake-png-bytes');
  assert.equal(extractEmbeddedBitmap(wrapped('jpeg')).ext, 'jpg');
  assert.equal(extractEmbeddedBitmap(wrapped('webp')).contentType, 'image/webp');
  assert.equal(extractEmbeddedBitmap(PLAIN), null, 'a real vector has no embedded bitmap');
  const twice = extractEmbeddedBitmap(wrapped() + wrapped());
  assert.equal(twice.bytes.toString('utf8'), 'fake-png-bytes', 'a repeated <image> is one bitmap');
  const mixed = wrapped() + wrapped().replace(PNG.toString('base64'), 'b3RoZXI=');
  assert.equal(extractEmbeddedBitmap(mixed), null, 'two different bitmaps: rasterize');
  const external = '<svg><image href="https://x.test/a.png" width="1" height="1"/></svg>';
  assert.equal(extractEmbeddedBitmap(external), null, 'only data URIs are extractable');
});

test('assetName slugifies the source basename and mediaHref points at content.da.live', () => {
  assert.equal(assetName(BADGE, 'png'), 'trust-badge-1.png');
  assert.equal(
    assetName('https://x.test/a/Group%201000005978.svg?v=2', 'jpg'), 'group-1000005978.jpg',
  );
  assert.equal(
    mediaHref(DA, 'homepage', 'trust-badge-1.png'),
    'https://content.da.live/org/site/media/homepage/trust-badge-1.png',
  );
});

test('rewriteImgSrc replaces every occurrence of a src, single or double quoted', () => {
  const html = page(`<p><img src="${LOGO}" alt="a"><img src='${LOGO}' alt="b">`
    + `<a href="${LOGO}">keep</a></p>`);
  const to = 'https://content.da.live/o/s/media/x/url-2.png';
  const out = rewriteImgSrc(html, new Map([[LOGO, to]]));
  assert.equal(out.match(/src="https:\/\/content\.da\.live/g).length, 1);
  assert.equal(out.match(/src='https:\/\/content\.da\.live/g).length, 1);
  assert.ok(out.includes(`<a href="${LOGO}">`), 'anchors keep the source URL');
});

test('fixDocument extracts wrapped bitmaps, rasterizes vectors and uploads both', async () => {
  const { fetchImpl, calls } = fakeFetch({
    [LOGO]: { bytes: 115885, body: wrapped() },
    [BADGE]: { bytes: 183694, body: PLAIN },
    [SMALL]: { bytes: 12000, body: PLAIN },
  });
  const uploads = [];
  const client = {
    putBinary: async (args) => {
      uploads.push(args);
      return { path: args.path, status: 201 };
    },
  };
  const rasterized = [];
  const rasterizeSharp = async (url) => {
    rasterized.push(url);
    return { bytes: Buffer.from('raster'), ext: 'jpg', contentType: 'image/jpeg' };
  };
  const rasterize = async () => { throw new Error('the browser is a last resort only'); };
  const html = page(`<p><img src="${LOGO}" alt="a"><img src="${BADGE}" alt="b">`
    + `<img src="${SMALL}" alt="c"></p>`);
  const result = await fixDocument({
    html, scope: 'homepage', da: DA, client, io: { fetch: fetchImpl, rasterize, rasterizeSharp },
  });
  assert.deepEqual(result.fixed, [
    {
      from: LOGO,
      to: 'https://content.da.live/org/site/media/homepage/url-2.png',
      bytes: 115885,
      method: 'extract',
    },
    {
      from: BADGE,
      to: 'https://content.da.live/org/site'
        + '/media/homepage/trust-badge-1.jpg',
      bytes: 183694,
      method: 'rasterize-sharp',
    },
  ]);
  assert.deepEqual(result.skipped, [
    { url: SMALL, bytes: 12000, reason: 'within the 40000 byte cap' },
  ]);
  assert.deepEqual(uploads.map((u) => u.path), [
    '/media/homepage/url-2.png', '/media/homepage/trust-badge-1.jpg',
  ]);
  assert.equal(uploads[0].contentType, 'image/png');
  assert.equal(uploads[0].bytes.toString('utf8'), 'fake-png-bytes');
  assert.deepEqual(rasterized, [BADGE]);
  assert.ok(!result.html.includes(LOGO) && !result.html.includes(BADGE));
  assert.ok(result.html.includes(SMALL), 'under-cap images are untouched');
  assert.deepEqual(calls, [`HEAD ${LOGO}`, `GET ${LOGO}`, `HEAD ${BADGE}`, `GET ${BADGE}`,
    `HEAD ${SMALL}`]);
});

test('a dry run plans the same fixes without uploading, rasterizing or writing', async () => {
  const { fetchImpl } = fakeFetch({
    [LOGO]: { bytes: 115885, body: wrapped() },
    [BADGE]: { bytes: 183694, body: PLAIN },
  });
  const client = { putBinary: async () => { throw new Error('must not upload on a dry run'); } };
  const rasterize = async () => { throw new Error('must not rasterize on a dry run'); };
  const html = page(`<p><img src="${LOGO}" alt="a"><img src="${BADGE}" alt="b"></p>`);
  const result = await fixDocument({
    html,
    scope: 'homepage',
    da: DA,
    client,
    io: {
      fetch: fetchImpl, rasterize, rasterizeSharp: rasterize, dryRun: true,
    },
  });
  assert.deepEqual(result.fixed.map((f) => f.method), ['extract', 'rasterize-sharp']);
  assert.equal(result.html, html, 'the document is left untouched');
});

test('the sharp rasterizer renders the SVG at 144 dpi into a JPEG of at most 2048 px', async () => {
  const seen = {};
  const stub = (source, options) => {
    seen.source = source;
    seen.options = options;
    return {
      resize: (opts) => {
        seen.resize = opts;
        return {
          flatten: (opts2) => {
            seen.flatten = opts2;
            return {
              jpeg: (opts3) => {
                seen.jpeg = opts3;
                return { toBuffer: async () => Buffer.from('rendered') };
              },
            };
          },
        };
      },
    };
  };
  const rasterize = createSharpRasterizer({ load: async () => ({ default: stub }) });
  const asset = await rasterize(COMPOSITE, PLAIN);
  assert.deepEqual(asset, {
    bytes: Buffer.from('rendered'), ext: 'jpg', contentType: 'image/jpeg',
  });
  assert.ok(Buffer.isBuffer(seen.source), 'the SVG source is handed to sharp as a buffer');
  assert.equal(seen.source.toString('utf8'), PLAIN);
  assert.ok(seen.options.density >= 144, 'a low density renders a blurry raster');
  assert.equal(seen.options.density, SVG_RASTER_DENSITY);
  assert.deepEqual(seen.resize, { width: MAX_RASTER_WIDTH, withoutEnlargement: true });
  assert.deepEqual(seen.flatten, { background: FLATTEN_BACKGROUND });
  assert.equal(seen.jpeg.quality, 82);
});

/** Asserts the top-left pixel of a JPEG is white, the tell that alpha was flattened. */
async function assertWhiteCorner(bytes) {
  const { data } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const corner = [...data.slice(0, 3)];
  assert.ok(corner.every((c) => c > 240), `corner is rgb(${corner})`);
}

test('a transparent SVG rasterizes onto white, never onto black', async () => {
  const badge = '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="20">'
    + '<circle cx="30" cy="10" r="6" fill="#2563eb"/></svg>';
  const { bytes } = await createSharpRasterizer()(BADGE, badge);
  await assertWhiteCorner(bytes);
});

test('a transparent PNG re-encodes onto white, never onto black', async () => {
  const transparent = {
    r: 0, g: 0, b: 0, alpha: 0,
  };
  const source = await sharp({
    create: {
      width: 8, height: 8, channels: 4, background: transparent,
    },
  }).png().toBuffer();
  const { bytes, contentType } = await createEncoder()(source);
  assert.equal(contentType, 'image/jpeg');
  await assertWhiteCorner(bytes);
});

test('an oversized composite SVG goes to sharp, never to the browser', async () => {
  const svg = composite();
  const { fetchImpl } = fakeFetch({ [COMPOSITE]: { bytes: 7946671, body: svg } });
  const uploads = [];
  const client = { putBinary: async (args) => uploads.push(args) };
  const rasterize = async () => { throw new Error('the browser must not see an oversized SVG'); };
  const rasterizeSharp = async (_url, source) => {
    assert.equal(source.length, svg.length, 'sharp takes the SVG whatever its size');
    return { bytes: Buffer.from('jpeg'), ext: 'jpg', contentType: 'image/jpeg' };
  };
  const result = await fixDocument({
    html: page(`<p><img src="${COMPOSITE}" alt="a"></p>`),
    scope: 'integration/mailchimp',
    da: DA,
    client,
    io: { fetch: fetchImpl, rasterize, rasterizeSharp },
  });
  assert.deepEqual(result.fixed.map((f) => [f.method, f.bytes]), [['rasterize-sharp', 7946671]]);
  assert.deepEqual(uploads.map((u) => [u.path, u.contentType]), [
    ['/media/integration/mailchimp/marketing-agency-tools.jpg', 'image/jpeg'],
  ]);
  assert.ok(result.html.includes('/media/integration/mailchimp/marketing-agency-tools.jpg'));
});

test('a sharp failure falls back to the browser, oversized SVGs included', async () => {
  const routes = {
    [BADGE]: { bytes: 183694, body: PLAIN },
    [COMPOSITE]: { bytes: 7946671, body: composite() },
  };
  const client = { putBinary: async () => {} };
  const rasterizeSharp = async () => { throw new Error('librsvg: unsupported filter'); };
  const rasterized = [];
  const rasterize = async (url) => {
    rasterized.push(url);
    return { bytes: Buffer.from('png'), ext: 'png', contentType: 'image/png' };
  };
  const io = { fetch: fakeFetch(routes).fetchImpl, rasterize, rasterizeSharp };
  const result = await fixDocument({
    html: page(`<p><img src="${BADGE}" alt="a"></p>`), scope: 'homepage', da: DA, client, io,
  });
  assert.deepEqual(result.fixed.map((f) => f.method), ['rasterize']);
  assert.deepEqual(rasterized, [BADGE], 'the browser renders what sharp refuses');
  const big = await fixDocument({
    html: page(`<p><img src="${COMPOSITE}" alt="a"></p>`),
    scope: 'homepage',
    da: DA,
    client,
    io: { ...io, fetch: fakeFetch(routes).fetchImpl },
  });
  assert.deepEqual(big.fixed.map((f) => f.method), ['rasterize']);
  assert.deepEqual(rasterized, [BADGE, COMPOSITE], 'the oversized SVG reaches the browser too');
});

test('serveSvg serves the SVG inline from localhost and shuts down on close', async () => {
  const served = await serveSvg(PLAIN);
  assert.match(served.url, /^http:\/\/127\.0\.0\.1:\d+\/asset\.html$/);
  const res = await fetch(served.url);
  const body = await res.text();
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.ok(body.includes('<svg') && body.includes(PLAIN), 'the page carries the SVG inline');
  served.close();
  await assert.rejects(() => fetch(served.url), 'the port is released');
});

test('the rasterizer navigates to a served page for an oversized SVG', async () => {
  const seen = [];
  const browser = {
    open: async (url, options) => {
      seen.push(['open', url.startsWith('http://127.0.0.1:') ? 'served' : url, options]);
    },
    evalJson: async (expr) => {
      seen.push(['eval', expr.includes('<svg') ? 'planted' : 'present']);
      return 'ok';
    },
    screenshot: async (file) => { await writeFile(file, PNG); },
    close: async () => seen.push(['close']),
  };
  const huge = PLAIN.replace('<svg', `<svg data-pad="${'x'.repeat(MAX_SVG_SOURCE)}"`);
  const asset = await createRasterizer({ browser })(BADGE, huge);
  assert.deepEqual(asset, { bytes: PNG, ext: 'png', contentType: 'image/png' });
  assert.deepEqual(seen, [
    ['open', 'served', { contextOptions: { deviceScaleFactor: 2 } }],
    ['eval', 'present'],
    ['close'],
  ]);
});

test('the rasterizer plants the SVG in a blank page and screenshots it in hires', async () => {
  const seen = [];
  const browser = {
    open: async (url, options) => seen.push(['open', url, options]),
    evalJson: async (expr) => {
      seen.push(['eval', expr.includes('<path d=') ? 'svg-source' : 'other']);
      return 'ok';
    },
    screenshot: async (file, options) => {
      seen.push(['screenshot', options]);
      await writeFile(file, PNG);
    },
    close: async () => seen.push(['close']),
  };
  const asset = await createRasterizer({ browser })(BADGE, PLAIN);
  assert.deepEqual(asset, { bytes: PNG, ext: 'png', contentType: 'image/png' });
  assert.deepEqual(seen, [
    ['open', 'about:blank', { contextOptions: { deviceScaleFactor: 2 } }],
    ['eval', 'svg-source'],
    ['screenshot', { target: 'svg', hires: true }],
    ['close'],
  ]);
  const blank = { ...browser, evalJson: async () => 'none' };
  await assert.rejects(
    () => createRasterizer({ browser: blank })(BADGE, '<p>not an svg</p>'),
    /has no <svg> element to rasterize/,
  );
});

test('fixDocument downscales rasters over the Media Bus cap, leaving the rest', async () => {
  const { fetchImpl, calls } = fakeFetch({
    [HUGE]: { bytes: 31457280, body: 'original-jpeg-bytes' },
    [LEAN]: { bytes: 480000, body: 'small-jpeg-bytes' },
  });
  const uploads = [];
  const client = { putBinary: async (args) => uploads.push(args) };
  const encoded = [];
  const encode = async (source) => {
    encoded.push(source.toString('utf8'));
    return { bytes: Buffer.from('downscaled'), ext: 'jpg', contentType: 'image/jpeg' };
  };
  const html = page(`<p><img src="${HUGE}" alt="a"><img src="${LEAN}" alt="b"></p>`);
  const result = await fixDocument({
    html, scope: 'case-study/amputee-associates', da: DA, client, io: { fetch: fetchImpl, encode },
  });
  const to = 'https://content.da.live/org/site'
    + '/media/case-study/amputee-associates/fire-hall-in-prosthetic-2.jpg';
  assert.deepEqual(result.fixed, [{
    from: HUGE, to, bytes: 31457280, method: 'downscale',
  }]);
  assert.deepEqual(result.skipped, [
    { url: LEAN, bytes: 480000, reason: 'within the 20000000 byte cap' },
  ]);
  assert.deepEqual(encoded, ['original-jpeg-bytes'], 'only the over-cap original is re-encoded');
  assert.deepEqual(uploads, [{
    path: '/media/case-study/amputee-associates/fire-hall-in-prosthetic-2.jpg',
    bytes: Buffer.from('downscaled'),
    contentType: 'image/jpeg',
  }]);
  assert.ok(result.html.includes(`src="${to}"`), 'the src points at the downscaled asset');
  assert.ok(!result.html.includes(HUGE));
  assert.ok(result.html.includes(LEAN), 'under-cap images are untouched');
  assert.deepEqual(calls, [`HEAD ${HUGE}`, `GET ${HUGE}`, `HEAD ${LEAN}`]);
});

test('a dry run plans a downscale without fetching or encoding the original', async () => {
  const { fetchImpl, calls } = fakeFetch({ [HUGE]: { bytes: 20000001, body: 'x' } });
  const client = { putBinary: async () => { throw new Error('must not upload on a dry run'); } };
  const encode = async () => { throw new Error('must not encode on a dry run'); };
  const html = page(`<p><img src="${HUGE}" alt="a"></p>`);
  const result = await fixDocument({
    html, scope: 'case-study/x', da: DA, client, io: { fetch: fetchImpl, encode, dryRun: true },
  });
  assert.deepEqual(result.fixed.map((f) => f.method), ['downscale']);
  assert.equal(result.html, html, 'the document is left untouched');
  assert.deepEqual(calls, [`HEAD ${HUGE}`]);
});

test('the encoder resizes to at most 2048 px and re-encodes as JPEG', async () => {
  const seen = {};
  const stub = (source) => {
    seen.source = source.toString('utf8');
    return {
      resize: (opts) => {
        seen.resize = opts;
        return {
          flatten: (opts2) => {
            seen.flatten = opts2;
            return {
              jpeg: (opts3) => {
                seen.jpeg = opts3;
                return { toBuffer: async () => Buffer.from('encoded') };
              },
            };
          },
        };
      },
    };
  };
  const asset = await createEncoder({ load: async () => ({ default: stub }) })(Buffer.from('raw'));
  assert.deepEqual(asset, {
    bytes: Buffer.from('encoded'), ext: 'jpg', contentType: 'image/jpeg',
  });
  assert.equal(seen.source, 'raw');
  assert.deepEqual(seen.resize, { width: MAX_RASTER_WIDTH, withoutEnlargement: true });
  assert.deepEqual(seen.flatten, { background: FLATTEN_BACKGROUND });
  assert.equal(MAX_RASTER_WIDTH, 2048);
  assert.ok(seen.jpeg.quality > 0);
});

test('the CLI reports its usage and refuses an unknown command', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migration-media-'));
  const file = path.join(dir, 'index.html');
  await writeFile(file, page('<p>no images</p>'));
  const usage = await execFileP(process.execPath, [mediaCli, 'bogus', file]).catch((e) => e);
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /Usage: media\.mjs fix <document\.html> --scope <name>/);
  const noScope = await execFileP(process.execPath, [mediaCli, 'fix', file]).catch((e) => e);
  assert.equal(noScope.code, 1);
  assert.match(noScope.stderr, /--scope/);
  assert.equal(await readFile(file, 'utf8'), page('<p>no images</p>'));
});

test('fixDocument skips an asset the origin answers 4xx for, and repairs the rest', async () => {
  const gone = 'https://www.example.com/uploads/2024/12/Screenshot-2024-12-24-at-8.33.54 AM.png';
  const routes = { [BADGE]: { bytes: 183694, body: PLAIN } };
  const client = { putBinary: async () => {} };
  const sizer = async (url) => {
    if (url === gone) throw new Error(`GET ${url} -> 404: cannot measure the asset`);
    return routes[url].bytes;
  };
  const rasterizeSharp = async () => ({
    bytes: Buffer.from('j'), ext: 'jpg', contentType: 'image/jpeg',
  });
  const result = await fixDocument({
    html: page(`<p><img src="${gone}" alt="a"></p><p><img src="${BADGE}" alt="b"></p>`),
    scope: 'one-off/x',
    da: DA,
    client,
    io: { fetch: fakeFetch(routes).fetchImpl, sizer, rasterizeSharp },
  });
  assert.deepEqual(result.fixed.map((f) => f.from), [BADGE]);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /unreachable on the source/);
});
