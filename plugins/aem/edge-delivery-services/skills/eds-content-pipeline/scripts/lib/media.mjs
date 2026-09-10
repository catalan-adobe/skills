import { Buffer } from 'node:buffer';
import {
  mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { flag, positiveIntFlag } from './args.mjs';
import { createBrowser } from './browser.mjs';
import { loadConfig } from './config.mjs';
import { createDaClient, loadToken } from './da.mjs';
import {
  createRemoteSizer, MAX_RASTER_BYTES, MAX_SVG_BYTES, parseHtml, rasterImageUrls, svgImageUrls,
} from './validate.mjs';

const USAGE = 'Usage: media.mjs fix <document.html> --scope <name> [--max-svg 40000] [--dry-run]';
const IMAGE_TAG_RE = /<image\b[^>]*>/gi;
const DATA_HREF_RE = /(?:xlink:)?href\s*=\s*"data:image\/(png|jpe?g|webp);base64,([^"]+)"/i;
const EXTENSIONS = {
  png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp',
};
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

/**
 * Decodes the single embedded bitmap of an SVG that only wraps a raster image.
 *
 * Some sites wrap 100-220 KB PNG logos in a thin SVG; unwrapping them is
 * lossless and needs no browser. Its photo exports repeat the very same `<image>` in `<defs>`
 * and in the body, so identical hrefs count as one bitmap. An SVG with no `<image>` element,
 * with several different ones, or with an external `href`, is a real vector drawing and must be
 * rasterized instead.
 *
 * @param {string} svg SVG source.
 * @returns {{bytes: Buffer, ext: string, contentType: string}|null} Null when not extractable.
 */
export function extractEmbeddedBitmap(svg) {
  const matches = (svg.match(IMAGE_TAG_RE) ?? []).map((tag) => tag.match(DATA_HREF_RE));
  if (!matches.length || matches.some((found) => !found)) return null;
  if (new Set(matches.map((found) => found[2])).size !== 1) return null;
  const [match] = matches;
  const ext = EXTENSIONS[match[1].toLowerCase()];
  return {
    bytes: Buffer.from(match[2].replace(/\s+/g, ''), 'base64'),
    ext,
    contentType: MIME[ext],
  };
}

/**
 * Builds the DA file name of a converted asset from its source URL.
 *
 * @param {string} url Source SVG URL.
 * @param {string} ext Target extension without the dot, e.g. `png`.
 * @returns {string} For example `trust-badge-1.png`.
 */
export function assetName(url, ext) {
  const base = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${base || 'asset'}.${ext}`;
}

/**
 * Builds the delivery URL of an asset stored in the shared `/media` folder.
 *
 * @param {{org: string, site: string}} da The `da` block of `site.config.json`.
 * @param {string} scope Sub-folder of `/media`, e.g. the document or template name.
 * @param {string} file File name from {@link assetName}.
 * @returns {string} `https://content.da.live/{org}/{site}/media/{scope}/{file}`.
 */
export function mediaHref(da, scope, file) {
  return `https://content.da.live/${da.org}/${da.site}/media/${scope}/${file}`;
}

/**
 * Rewrites `<img src>` attributes, leaving every other occurrence of the URL alone.
 *
 * @param {string} html Document source.
 * @param {Map<string, string>} replacements Source URL → new URL.
 * @returns {string} Rewritten document.
 */
export function rewriteImgSrc(html, replacements) {
  let out = html;
  for (const [from, to] of replacements) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`src="${escaped}"`, 'g'), `src="${to}"`)
      .replace(new RegExp(`src='${escaped}'`, 'g'), `src='${to}'`);
  }
  return out;
}

/** Longest SVG source the browser command line takes; larger ones only go through sharp. */
export const MAX_SVG_SOURCE = 700000;

/**
 * Builds the expression that plants an SVG in a blank page.
 *
 * @param {string} svg SVG source.
 * @returns {string} Expression evaluating to `ok` once the `<svg>` element is in the DOM.
 */
function plantExpression(svg) {
  const selector = JSON.stringify('svg');
  return '() => { document.body.style.margin = "0"; document.body.innerHTML = '
    + `${JSON.stringify(svg)}; return document.querySelector(${selector}) ? "ok" : "none"; }`;
}

const SVG_PRESENT = "document.querySelector('svg') ? 'ok' : 'none'";

/**
 * Serves one oversized SVG inline in a blank page from an ephemeral localhost port, so the browser
 * navigates to it instead of taking the source on its command line (a composite hero
 * graphics run to 20 MB: a 10 MB JPEG plus PNG overlays and two hundred paths in one file).
 *
 * @param {string} svg SVG source.
 * @returns {Promise<{url: string, close: () => void}>} Page URL and the server's shutdown.
 */
export function serveSvg(svg) {
  const page = `<!doctype html><html><body style="margin:0">${svg}</body></html>`;
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/asset.html`, close: () => server.close() });
    });
  });
}

/**
 * Creates the fallback converter: renders the SVG in a headless browser and screenshots it.
 *
 * The SVG source is planted in a blank page rather than re-fetched from its origin: the source
 * CDN blocks headless requests, `file:` URLs are refused, and navigating to a `data:` URL never
 * settles. The screenshot uses device pixels at `deviceScaleFactor` 2, so the PNG is 2x. This is
 * the last resort behind {@link createSharpRasterizer}. A source over {@link MAX_SVG_SOURCE}
 * bytes does not fit on the browser command line, so it is served from localhost instead
 * ({@link serveSvg}).
 *
 * @param {object} [options]
 * @param {object} [options.browser] A {@link createBrowser} instance; injected by tests.
 * @returns {(url: string, svg: string) => Promise<{bytes: Buffer, ext: string,
 *   contentType: string}>} Converter producing a 2x PNG of the `<svg>` element.
 */
export function createRasterizer({ browser = createBrowser({ session: 'media' }) } = {}) {
  return async function rasterize(url, svg) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'migration-media-'));
    const file = path.join(dir, 'asset.png');
    const served = svg.length > MAX_SVG_SOURCE ? await serveSvg(svg) : null;
    try {
      const contextOptions = { deviceScaleFactor: 2 };
      await browser.open(served?.url ?? 'about:blank', { contextOptions });
      const planted = served ? await browser.evalJson(SVG_PRESENT) : await browser.evalJson(
        plantExpression(svg),
      );
      if (planted !== 'ok') throw new Error(`${url} has no <svg> element to rasterize`);
      await browser.screenshot(file, { target: 'svg', hires: true });
      return { bytes: await readFile(file), ext: 'png', contentType: 'image/png' };
    } finally {
      await browser.close().catch(() => {});
      served?.close();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** Widest edge a downscaled raster keeps; 2048 px covers every EDS breakpoint at 2x. */
export const MAX_RASTER_WIDTH = 2048;

/** Rendering density in dpi; at 144 a 1200 px viewBox renders 2400 px wide, never upscaled. */
export const SVG_RASTER_DENSITY = 144;

/**
 * Backdrop every transparent source is composited onto before a JPEG is written.
 *
 * JPEG carries no alpha, and sharp composites what it drops onto black: the health trust badge
 * (`Group-68.svg`, three blue shields on transparency) shipped as a black rectangle on 29 pages.
 * The site paints every content surface white, so white is the faithful backdrop.
 */
export const FLATTEN_BACKGROUND = '#ffffff';

/**
 * Creates the primary SVG converter: librsvg renders the source, sharp encodes a JPEG.
 *
 * Some sites ship multi-megabyte composite illustrations (a hundred paths plus embedded data-URI
 * bitmaps) that no browser command line takes; librsvg reads them from a buffer, embedded bitmaps
 * included, in under a second and with no headless session at all.
 *
 * @param {object} [options]
 * @param {() => Promise<object>} [options.load] Loader for the `sharp` module; injected by tests.
 * @param {string} [options.background] Backdrop for the transparency JPEG cannot carry.
 * @returns {(url: string, svg: string) => Promise<{bytes: Buffer, ext: string,
 *   contentType: string}>} Converter producing a JPEG at most {@link MAX_RASTER_WIDTH} px wide.
 */
export function createSharpRasterizer({
  load = () => import('sharp'), background = FLATTEN_BACKGROUND,
} = {}) {
  return async function rasterizeSharp(_url, svg) {
    const { default: sharp } = await load();
    const bytes = await sharp(Buffer.from(svg), {
      density: SVG_RASTER_DENSITY,
      limitInputPixels: false,
    })
      .resize({ width: MAX_RASTER_WIDTH, withoutEnlargement: true })
      .flatten({ background })
      .jpeg({ quality: 82 })
      .toBuffer();
    return { bytes, ext: 'jpg', contentType: 'image/jpeg' };
  };
}

/**
 * Creates the raster re-encoder: a JPEG at most {@link MAX_RASTER_WIDTH} pixels wide.
 *
 * A WordPress media library may serve untouched camera originals (20-31 MB) that Media Bus
 * refuses;
 * re-encoding drops them to a few hundred KB with no visible loss at delivery sizes. A source
 * with an alpha channel is composited onto {@link FLATTEN_BACKGROUND} first, as JPEG has none.
 *
 * @param {object} [options]
 * @param {() => Promise<object>} [options.load] Loader for the `sharp` module; injected by tests.
 * @param {string} [options.background] Backdrop for the transparency JPEG cannot carry.
 * @returns {(source: Buffer) => Promise<{bytes: Buffer, ext: string, contentType: string}>}
 *   Encoder producing a JPEG asset.
 */
export function createEncoder({
  load = () => import('sharp'), background = FLATTEN_BACKGROUND,
} = {}) {
  return async function encode(source) {
    const { default: sharp } = await load();
    const bytes = await sharp(source)
      .resize({ width: MAX_RASTER_WIDTH, withoutEnlargement: true })
      .flatten({ background })
      .jpeg({ quality: 82 })
      .toBuffer();
    return { bytes, ext: 'jpg', contentType: 'image/jpeg' };
  };
}

async function body(url, ctx, what) {
  const res = await ctx.fetchImpl(url, { method: 'GET' });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}: cannot ${what}`);
  return res;
}

async function rasterizeSvg(url, svg, ctx) {
  try {
    return { ...await ctx.rasterizeSharp(url, svg), method: 'rasterize-sharp' };
  } catch (err) {
    ctx.log(`sharp could not rasterize ${url} (${err.message}); trying the browser`);
    return { ...await ctx.rasterize(url, svg), method: 'rasterize' };
  }
}

async function planSvg(url, ctx) {
  const svg = await (await body(url, ctx, 'convert the SVG')).text();
  const embedded = extractEmbeddedBitmap(svg);
  if (ctx.dryRun) {
    return { method: embedded ? 'extract' : 'rasterize-sharp', ext: embedded?.ext ?? 'jpg' };
  }
  if (embedded) return { ...embedded, method: 'extract' };
  return rasterizeSvg(url, svg, ctx);
}

async function planRaster(url, ctx) {
  if (ctx.dryRun) return { method: 'downscale', ext: 'jpg' };
  const source = Buffer.from(await (await body(url, ctx, 'downscale the image')).arrayBuffer());
  return { ...await ctx.encode(source), method: 'downscale' };
}

function converters(io, fetchImpl) {
  return {
    sizer: io.sizer ?? createRemoteSizer({ fetch: fetchImpl }),
    maxSvg: io.maxSvg ?? MAX_SVG_BYTES,
    maxRaster: io.maxRaster ?? MAX_RASTER_BYTES,
    rasterizeSharp: io.rasterizeSharp ?? createSharpRasterizer(),
    rasterize: io.rasterize ?? createRasterizer(),
    encode: io.encode ?? createEncoder(),
  };
}

const KINDS = [
  { urls: svgImageUrls, cap: 'maxSvg', plan: planSvg },
  { urls: rasterImageUrls, cap: 'maxRaster', plan: planRaster },
];

/** A source asset the origin no longer serves: reported, never converted, never fatal. */
function unreachable(url, err) {
  return { skipped: { url, bytes: 0, reason: `unreachable on the source: ${err.message}` } };
}

async function planOne(url, kind, ctx) {
  const bytes = await ctx.sizer(url).catch((err) => {
    if (/-> 4\d\d:/.test(err.message)) return null;
    throw err;
  });
  if (bytes === null) return unreachable(url, new Error('the origin answered 4xx'));
  const cap = ctx[kind.cap];
  if (bytes <= cap) return { skipped: { url, bytes, reason: `within the ${cap} byte cap` } };
  if (!ctx.dryRun) ctx.log(`converting ${url} (${bytes} bytes)`);
  const asset = await kind.plan(url, ctx);
  return {
    bytes, method: asset.method, ext: asset.ext, asset: ctx.dryRun ? null : asset,
  };
}

async function fixOne(url, kind, ctx, out) {
  const outcome = await planOne(url, kind, ctx);
  if (outcome.skipped) {
    out.skipped.push(outcome.skipped);
    return;
  }
  const file = assetName(url, outcome.ext);
  const to = mediaHref(ctx.da, ctx.scope, file);
  if (outcome.asset) {
    await ctx.client.putBinary({
      path: `/media/${ctx.scope}/${file}`,
      bytes: outcome.asset.bytes,
      contentType: outcome.asset.contentType,
    });
    out.replacements.set(url, to);
  }
  out.fixed.push({
    from: url, to, bytes: outcome.bytes, method: outcome.method,
  });
}

/**
 * Replaces every over-cap image a document references with a bus-safe asset.
 *
 * Wrapped bitmaps are unwrapped losslessly, real vectors are rasterized with sharp — a headless
 * browser only when sharp fails and the source is within {@link MAX_SVG_SOURCE} bytes — and
 * over-cap rasters are re-encoded as a JPEG at most {@link MAX_RASTER_WIDTH} pixels wide. Each
 * asset lands in `/media/<scope>/` and the document's `<img src>` is rewritten to its
 * `content.da.live` URL.
 *
 * @param {object} options
 * @param {string} options.html Document source.
 * @param {string} options.scope Sub-folder of `/media`, e.g. `homepage`.
 * @param {{org: string, site: string}} options.da The `da` block of `site.config.json`.
 * @param {{putBinary: Function}} options.client DA client from `createDaClient`.
 * @param {object} [options.io] `{ fetch, sizer, rasterizeSharp, rasterize, encode, maxSvg,
 *   maxRaster, dryRun, log }`.
 * @returns {Promise<{html: string, fixed: object[], skipped: object[]}>} Report plus new HTML.
 */
export async function fixDocument({
  html, scope, da, client, io = {},
}) {
  const { fetch: fetchImpl = globalThis.fetch, dryRun = false, log = () => {} } = io;
  const ctx = {
    ...converters(io, fetchImpl),
    fetchImpl,
    dryRun,
    log,
    da,
    scope,
    client,
  };
  const out = { fixed: [], skipped: [], replacements: new Map() };
  const root = parseHtml(html);
  for (const kind of KINDS) {
    for (const url of kind.urls(root)) await fixOne(url, kind, ctx, out);
  }
  return { html: rewriteImgSrc(html, out.replacements), fixed: out.fixed, skipped: out.skipped };
}

async function daClient(config) {
  const { token, expiresAt, source } = await loadToken();
  return createDaClient({
    da: config.da,
    token,
    expiresAt,
    tokenSource: source,
    io: { concurrency: config.concurrency.da, log: (msg) => console.error(`[da] ${msg}`) },
  });
}

async function runFix(file, argv) {
  const scope = flag(argv, '--scope');
  if (!file) throw new Error(USAGE);
  if (!scope) throw new Error(`media.mjs fix needs --scope <name>; ${USAGE}`);
  const dryRun = argv.includes('--dry-run');
  const config = await loadConfig();
  const client = dryRun ? { putBinary: async () => {} } : await daClient(config);
  const { html, fixed, skipped } = await fixDocument({
    html: await readFile(file, 'utf8'),
    scope,
    da: config.da,
    client,
    io: {
      maxSvg: positiveIntFlag(argv, '--max-svg', MAX_SVG_BYTES),
      dryRun,
      log: (msg) => console.error(`[media] ${msg}`),
    },
  });
  if (!dryRun && fixed.length) await writeFile(file, html);
  return {
    document: file, scope, dryRun, fixed, skipped,
  };
}

const VALUE_FLAGS = new Set(['--scope', '--max-svg']);

async function cli(argv) {
  const [cmd, file] = argv.filter((arg, i) => !arg.startsWith('--')
    && !(i > 0 && VALUE_FLAGS.has(argv[i - 1])));
  if (cmd !== 'fix') throw new Error(USAGE);
  console.log(JSON.stringify(await runFix(file, argv), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
