// A System 1 client: one POST with images and yes/no questions, probabilities back. Any
// deployment of the protocol; three settings from the environment, usually an env file
// (`node --env-file=<file> …`):
//   S1_URL      the endpoint, e.g. a Cloudflare Workers AI run URL for @cf/cloudflare/clef
//   S1_MODEL    the model it serves — sent with every request, stored with every answer
//   S1_API_KEY  optional, sent as a Bearer token
export const MAX_IMAGES = 4;
export const RETRY_STATUSES = [429, 503, 529];

/** The deployment from the environment; an error naming what is missing. */
export function deployment(env = process.env) {
  const url = env.S1_URL;
  const model = env.S1_MODEL;
  if (!url || !model) {
    throw new Error('System 1 needs S1_URL and S1_MODEL in the environment (an env file: node'
      + ' --env-file=<file> …); S1_API_KEY when the deployment wants one');
  }
  return { url, model, key: env.S1_API_KEY ?? null };
}

/**
 * Asks `questions` (`{ id: instructions }`, all yes/no) about `images` (data URIs, at most
 * four) in one request. Returns `{ answers: { id: probability }, usage }`.
 */
export async function ask(dep, images, questions, options = {}) {
  const asked = Object.fromEntries(Object.entries(questions)
    .map(([id, instructions]) => [id, { type: 'noul', instructions }]));
  const { answers, usage } = await askQuestions(dep, { state: {}, questions: asked, images },
    options);
  return { answers: Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, a.noul])),
    usage };
}

/**
 * The protocol in full: `state` (what the questions are about), `questions` (`{ id: { type:
 * 'noul' | 'choice', instructions, criteria? } }`) and optional `images`, in one request.
 * Retries 429/503/529 at 1, 2, 4, 8 s or the deployment's own Retry-After. Returns the
 * answers as the deployment gave them — `{ noul }` or `{ choice, confidence, probabilities }`
 * — and `usage: { inputTokens, ms }`.
 */
export async function askQuestions(dep, { state = {}, questions, images = [] }, {
  fetchImpl = fetch, sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }), retries = 4,
} = {}) {
  if (images.length > MAX_IMAGES) {
    throw new Error(`at most ${MAX_IMAGES} images; got ${images.length}`);
  }
  const asked = questions;
  const body = JSON.stringify({ model: dep.model, state, questions: asked,
    ...(images.length ? { images } : {}) });
  const headers = { 'content-type': 'application/json',
    ...(dep.key ? { authorization: `Bearer ${dep.key}` } : {}) };
  const started = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetchImpl(dep.url, { method: 'POST', headers, body });
    if (RETRY_STATUSES.includes(res.status) && attempt < retries) {
      const wait = Math.max(2 ** attempt, Number(res.headers.get('retry-after')) || 0) * 1000;
      // eslint-disable-next-line no-await-in-loop
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      // eslint-disable-next-line no-await-in-loop
      const text = await res.text();
      throw new Error(`System 1 ${res.status} (${body.length} chars): ${text.slice(0, 200)}`);
    }
    // eslint-disable-next-line no-await-in-loop
    const data = await res.json().then((d) => d.result ?? d);
    if (data.model && data.model !== dep.model) {
      throw new Error(`System 1 at ${dep.url} replied as ${data.model}, not ${dep.model}`);
    }
    if (!data.answers) {
      throw new Error(`System 1 replied without answers: ${JSON.stringify(data).slice(0, 200)}`);
    }
    const answers = {};
    for (const [id, q] of Object.entries(asked)) {
      const a = data.answers[id];
      const ok = q.type === 'choice' ? typeof a?.choice === 'string' : typeof a?.noul === 'number';
      if (!ok) throw new Error(`System 1 gave no answer for ${id} (${q.type})`);
      answers[id] = a;
    }
    const usage = { ms: Date.now() - started };
    if (Number.isInteger(data.usage?.input_tokens)) usage.inputTokens = data.usage.input_tokens;
    return { answers, usage };
  }
}
