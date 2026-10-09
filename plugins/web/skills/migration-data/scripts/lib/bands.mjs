// Bands: a method's cut of a page's body into horizontal bands (a proposal, derived) and
// a person's word on the cut (a decision, the bench's ground truth at band level). The
// unit of the next level: a band is what an EDS section is made of.
import { HEAD, register } from './schema.mjs';
import { openStore } from './store.mjs';

export const PROPOSAL_SCHEMA = 'pages/bands@1';
export const VERDICTS_FILE = 'pages/band-verdicts.json';
export const VERDICTS_SCHEMA = 'pages/band-verdicts@1';
export const proposalFile = (pageId) => `pages/${pageId}/bands.json`;
export const KINDS = ['text', 'hero', 'cards', 'list', 'media', 'columns', 'cta', 'form',
  'table', 'code', 'nav', 'quote', 'other'];

const idPattern = (prefix) => ({ type: 'string', pattern: `^${prefix}-[0-9a-f]{12}$` });
const edges = {
  type: 'object', required: ['top', 'bottom'], additionalProperties: false,
  properties: { top: { type: 'integer' }, bottom: { type: 'integer' } },
};

register('pages/bands', 1, 'derived', {
  type: 'object',
  required: ['schema', 'page', 'body', 'tree', 'pixels', 'agreement'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    page: idPattern('pag'),
    body: edges,
    tree: { type: 'object' },
    pixels: { type: 'object' },
    agreement: { type: 'object' },
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

export const writeProposal = (cwd, pageId, proposal) => (
  openStore(cwd).write(proposalFile(pageId), { schema: PROPOSAL_SCHEMA, ...proposal }));
export const readProposal = (cwd, pageId) => (
  openStore(cwd).read(proposalFile(pageId), PROPOSAL_SCHEMA));
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
