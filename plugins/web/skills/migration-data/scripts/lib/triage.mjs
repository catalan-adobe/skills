// What a System 1 model saw on a page's screenshot: four answers — a site header at the
// top, a site footer at the bottom, a broken page (an error, a blank, a wall), an empty
// page (nothing where the content should be) — each a probability, with how the picture
// was given and what it cost. A method's artefact under the page; the table gets reasons
// from it, never the numbers.
import { HEAD, register } from './schema.mjs';
import { openStore } from './store.mjs';

export const SCHEMA = 'pages/triage@1';
export const QUESTIONS = ['header', 'footer', 'broken', 'empty'];
export const file = (pageId) => `pages/${pageId}/triage.json`;

const probability = { type: 'number', minimum: 0, maximum: 1 };

register('pages/triage', 1, 'derived', {
  type: 'object',
  required: ['schema', 'method', 'answers', 'images'],
  additionalProperties: false,
  properties: {
    ...HEAD,
    method: {
      type: 'object',
      required: ['name', 'model', 'at'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
        model: { type: 'string' },
        at: { type: 'string', format: 'date-time' },
        inputs: { type: 'string' },
      },
    },
    answers: {
      type: 'object',
      required: QUESTIONS,
      additionalProperties: false,
      properties: {
        header: probability, footer: probability, broken: probability, empty: probability,
      },
    },
    images: {
      type: 'object',
      required: ['slices', 'scale', 'quality'],
      additionalProperties: false,
      properties: {
        slices: { type: 'integer', minimum: 1 },
        scale: { type: 'number', minimum: 0, maximum: 1 },
        quality: { type: 'integer', minimum: 1, maximum: 100 },
        bytes: { type: 'integer', minimum: 0 },
      },
    },
    usage: {
      type: 'object',
      additionalProperties: false,
      properties: { inputTokens: { type: 'integer', minimum: 0 }, ms: { type: 'integer' } },
    },
  },
});

/** The threshold at which a probability reads as yes. */
export const YES = 0.5;

/** The flags the answers give: no header, no footer, broken, empty — at the threshold. */
export function flagsOf(answers, threshold = YES) {
  const flags = [];
  const pct = (p) => `${Math.round(p * 100)} %`;
  if (answers.header < threshold) flags.push({ code: 'no-header', kind: 'flag',
    detail: `seen in the picture: ${pct(answers.header)}` });
  if (answers.footer < threshold) flags.push({ code: 'no-footer', kind: 'flag',
    detail: `seen in the picture: ${pct(answers.footer)}` });
  if (answers.broken >= threshold) flags.push({ code: 'broken', kind: 'flag',
    detail: `seen in the picture: ${pct(answers.broken)}` });
  if (answers.empty >= threshold) flags.push({ code: 'empty', kind: 'flag',
    detail: `seen in the picture: ${pct(answers.empty)}` });
  return flags;
}

export function write(cwd, pageId, { method, answers, images, usage }) {
  return openStore(cwd).write(file(pageId), {
    schema: SCHEMA, method, answers, images, ...(usage ? { usage } : {}),
  });
}

export const read = (cwd, pageId) => openStore(cwd).read(file(pageId), SCHEMA);

/** The ids of the pages that have a triage. */
export async function list(cwd) {
  const store = openStore(cwd);
  const dirs = (await store.list('pages')).filter((d) => d.startsWith('pag-'));
  const has = await Promise.all(dirs.map((d) => store.exists(file(d))));
  return dirs.filter((_, i) => has[i]);
}
