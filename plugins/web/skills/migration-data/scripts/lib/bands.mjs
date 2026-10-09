// Bands: what the band capture read on a rendered page — every content leaf with its box
// and text, the wide decorated boxes, the floating layers set aside — and the bands the
// analysis cut it into, with the page's own gap and gutter and its side rails. A method's
// artefact under the page, ported from the site census. And a person's word on the cut: a
// decision, the bench's ground truth at band level.
import { HEAD, register } from './schema.mjs';
import { openStore } from './store.mjs';

export const CAPTURE_SCHEMA = 'pages/band-capture@1';
export const STRUCTURE_SCHEMA = 'pages/structure@1';
export const structureFile = (pageId, method = 'bands-system1') => (
  `pages/${pageId}/structure.${method}.json`);
export const VERDICTS_FILE = 'pages/band-verdicts.json';
export const VERDICTS_SCHEMA = 'pages/band-verdicts@1';
export const captureFile = (pageId) => `pages/${pageId}/band-capture.json`;
export const PIXEL_SCHEMA = 'pages/pixel-check@1';
export const pixelCheckFile = (pageId) => `pages/${pageId}/pixel-check.json`;
export const KINDS = ['text', 'hero', 'cards', 'list', 'media', 'columns', 'cta', 'form',
  'table', 'code', 'nav', 'quote', 'other'];

const idPattern = (prefix) => ({ type: 'string', pattern: `^${prefix}-[0-9a-f]{12}$` });

register('pages/band-capture', 1, 'derived', {
  type: 'object',
  required: ['schema', 'url', 'W', 'H', 'leaves', 'bgs', 'paths', 'analysis'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    url: { type: 'string' },
    W: { type: 'integer', minimum: 1 },
    H: { type: 'integer', minimum: 1 },
    pageBg: { type: 'string' },
    sy: { type: 'integer' },
    status: { type: 'integer' },
    leaves: { type: 'array', items: { type: 'object' } },
    bgs: { type: 'array', items: { type: 'object' } },
    paths: { type: 'array', items: { type: 'string' } },
    overlays: { type: 'array', items: { type: 'object' } },
    dropped: { type: 'array', items: { type: 'object' } },
    unpainted: { type: 'integer' },
    scrollLock: { type: 'boolean' },
    analysis: {
      type: 'object',
      required: ['base', 'gap', 'gutter', 'bands', 'rails'],
      additionalProperties: false,
      properties: {
        base: { type: ['string', 'null'] }, gap: { type: 'number' }, gutter: { type: 'number' },
        bands: { type: 'array', items: { type: 'object' } },
        rails: { type: 'array', items: { type: 'object' } },
        leaves: { type: 'array', items: { type: 'object' } },
      },
    },
  },
});
// The screenshot's verdict on the band capture: per band, the claimed background against
// the painted margin colour and the share of inked rows; rows inked outside every band.
register('pages/pixel-check', 1, 'derived', {
  type: 'object',
  required: ['schema', 'page', 'version', 'shot', 'bands', 'unclaimedRows', 'flags'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    page: { type: 'string' },
    version: { type: 'integer' },
    capturedAt: { type: ['string', 'null'] },
    checkedAt: { type: 'string' },
    shot: { type: 'object', required: ['width', 'height'], additionalProperties: false,
      properties: { width: { type: 'integer' }, height: { type: 'integer' } } },
    bands: { type: 'array', items: { type: 'object' } },
    unclaimedRows: { type: 'integer' },
    flags: { type: 'array', items: { enum: ['bg-mismatch', 'unpainted', 'unclaimed-ink'] } },
  },
});
// A method's reading of a page's bands into sections and children, with everything the
// model answered: the record a review reads and a correction is made against.
register('pages/structure', 1, 'derived', {
  type: 'object',
  required: ['schema', 'page', 'method', 'body', 'bands', 'sections'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    page: idPattern('pag'),
    method: {
      type: 'object',
      required: ['name', 'at'],
      additionalProperties: false,
      properties: { name: { type: 'string' }, model: { type: 'string' },
        wording: { type: 'string' }, at: { type: 'string', format: 'date-time' } },
    },
    body: { type: 'object' },
    bands: { type: 'array', items: { type: 'object' } },
    sections: { type: 'array', items: { type: 'object' } },
    usage: { type: 'object' },
  },
});

register('pages/band-verdicts', 1, 'decision', {
  type: 'object',
  required: ['schema', 'verdicts'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    summary: { type: 'string' },
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['page', 'by', 'at', 'cuts', 'bands'],
        additionalProperties: false,
        properties: {
          page: idPattern('pag'),
          by: { type: 'string' },
          at: { type: 'string', format: 'date-time' },
          cuts: { type: 'array', items: { type: 'integer' } },
          bands: {
            type: 'array',
            items: {
              type: 'object',
              required: ['top', 'bottom', 'kind'],
              additionalProperties: false,
              properties: { top: { type: 'integer' }, bottom: { type: 'integer' },
                kind: { enum: KINDS } },
            },
          },
          note: { type: 'string' },
        },
      },
    },
  },
});

export const writeCapture = (cwd, pageId, capture) => (
  openStore(cwd).write(captureFile(pageId), { schema: CAPTURE_SCHEMA, ...capture }));
export const readCapture = (cwd, pageId) => (
  openStore(cwd).read(captureFile(pageId), CAPTURE_SCHEMA));
/** The disagreement in words, for a reason's detail and a review's red line; '' when none. */
export function disagreement(check) {
  if (!check?.flags?.length) return '';
  const rgb = (c) => `rgb(${c.join(', ')})`;
  const parts = [];
  const off = check.bands.filter((b) => b.background && !b.background.agree);
  if (off.length) {
    parts.push(off.map((b) => `${b.id} claims ${rgb(b.background.claimed)}, shows`
      + ` ${rgb(b.background.pixel)}`).join('; '));
  }
  const blank = check.bands.filter((b) => b.unpainted);
  if (blank.length) {
    const what = (b) => {
      if (b.broken?.length) return `a broken image from ${b.broken.join(', ')}`;
      if (b.embeds?.length) return `an embed from ${b.embeds.join(', ')}, not rendered offline`;
      return `${b.leaves} leaves`;
    };
    parts.push(`content not painted in ${blank.map((b) => `${b.id} (${what(b)})`).join(', ')}`);
  }
  if (check.flags.includes('unclaimed-ink')) {
    parts.push(`${check.unclaimedRows} px of ink outside every band`);
  }
  return parts.join(' · ');
}
export const writePixelCheck = (cwd, pageId, check) => (
  openStore(cwd).write(pixelCheckFile(pageId), { schema: PIXEL_SCHEMA, ...check }));
export const readPixelCheck = (cwd, pageId) => (
  openStore(cwd).read(pixelCheckFile(pageId), PIXEL_SCHEMA));
export const removePixelCheck = (cwd, pageId) => openStore(cwd).remove(pixelCheckFile(pageId));
export const writeStructure = (cwd, pageId, structure, method) => (
  openStore(cwd).write(structureFile(pageId, method), { schema: STRUCTURE_SCHEMA, ...structure }));
export const readStructure = (cwd, pageId, method) => (
  openStore(cwd).read(structureFile(pageId, method), STRUCTURE_SCHEMA));
export const readVerdicts = (cwd) => openStore(cwd).read(VERDICTS_FILE, VERDICTS_SCHEMA);

/** Records band verdicts, one per page, the later replacing the earlier. */
export async function upsertVerdicts(cwd, entries, { by }) {
  if (!by) throw new Error('band verdicts name who judged (by)');
  const store = openStore(cwd);
  const current = (await readVerdicts(cwd)) ?? { schema: VERDICTS_SCHEMA, verdicts: [] };
  const at = store.now().toISOString();
  const byPage = new Map(current.verdicts.map((v) => [v.page, v]));
  for (const e of entries) {
    byPage.set(e.page, { page: e.page, by, at, cuts: e.cuts, bands: e.bands,
      ...(e.note ? { note: e.note } : {}) });
  }
  const verdicts = [...byPage.values()];
  const bands = verdicts.reduce((n, v) => n + v.bands.length, 0);
  return store.write(VERDICTS_FILE, { schema: VERDICTS_SCHEMA, verdicts,
    summary: `${verdicts.length} page(s) cut into ${bands} band(s) by a person` });
}

export async function importVerdicts(cwd, data) {
  if (!Array.isArray(data?.verdicts)) throw new Error('an export has a verdicts array');
  return upsertVerdicts(cwd, data.verdicts, { by: data.by });
}
