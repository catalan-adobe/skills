// chrome: the shared documents a site's template places on every page — header and footer
// — found from the visual trees. Two phases in one worker, offline: capture the trees the
// store lacks, then detect, and write what EDS needs: `website/fragments.json` grouped by
// part, each fragment's composition (its bands as sections), every page's composition with
// the fragments it carries, a flag on pages without, and crops as evidence.
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  cacheDir, defaultIo, parseEval, playwright, proxyStarter, sessionName, tools, viaProxy,
  writeBrowserConfig,
} from './browser.mjs';
import {
  MIN_WIDTH, captureTrees, pagesToCapture, preparedAtTop, readablePages,
} from './capture.mjs';
import { pageExpression } from './cache.mjs';
import { candidates } from './chrome-candidates.mjs';
import { detectChrome } from './chrome-detect.mjs';
import { data } from './data.mjs';

export const METHOD = 'visual-tree';
export const PARTS = ['header', 'footer'];
export const OUTLINE = '4px solid #e00';

/** The detector's input: every readable page's tree, with the group it belongs to. */
async function captures(cwd) {
  const { trees } = await data(cwd);
  const readable = await readablePages(cwd);
  const stored = new Set(await trees.list(cwd));
  const pages = readable.filter((p) => stored.has(p.id));
  const all = await Promise.all(pages.map((p) => trees.read(cwd, p.id)));
  return pages.map((p, i) => ({
    page: p, url: p.url, tree: all[i].tree, scrollHeight: all[i].page?.scrollHeight ?? null,
  }));
}

/** The hash of what detection read: which trees, at which width. */
export const inputsHash = (ids, minWidth) => createHash('sha256')
  .update(`${minWidth}|${[...ids].sort().join(' ')}`).digest('hex').slice(0, 16);

/** The first node of a tree whose selector is one of `selectors`; null when none. */
export function findNode(tree, selectors) {
  const wanted = new Set(selectors);
  const stack = [tree];
  while (stack.length) {
    const node = stack.shift();
    if (wanted.has(node.selector)) return node;
    if ((node.collapsed ?? []).some((c) => wanted.has(c.selector))) return node;
    stack.push(...(node.children ?? []));
  }
  return null;
}

const union = (boxes) => {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  };
};

const box = ({ x = 0, y, width, height }) => ({ x, y, width, height });

/**
 * The detector's variants of one part as template fragments: the first (most pages) is
 * the part; every further one is another design, labelled, with an id of its own — and
 * then the first is labelled too, so two designs read as two.
 */
export function fragmentsOf(part, variants, makeId) {
  const several = variants.length > 1;
  return variants.map((v, i) => ({
    ...(i ? { id: makeId('frg', `template|${part}|${i + 1}`) } : {}),
    placement: 'template', part,
    ...(several ? { label: `${part} design ${i + 1}` } : {}),
    selectors: v.members.map((m) => m.selector),
    optional: v.optional.map((m) => m.selector),
    pages: v.pages.length,
    variant: v,
  }));
}

/** The fragment's own composition: its bands as sections, top to bottom. */
export function fragmentComposition(fragment, at) {
  const members = [...fragment.variant.members].sort((a, b) => a.bounds.y - b.bounds.y);
  return {
    method: { name: METHOD, at },
    fragments: [],
    sections: members.map((m, i) => ({
      id: `s${i + 1}`, selector: m.selector, bounds: box(m.bounds), items: [],
    })),
    omitted: [],
  };
}

/**
 * A page's composition at this stage: the template fragments it carries, each located
 * on this page by its members' selectors; sections empty — `elements` fills them.
 */
export function pageComposition(capture, fragments, at) {
  const placed = [];
  for (const f of fragments) {
    if (!f.variant.pages.includes(capture.url)) continue;
    const nodes = f.variant.members.map((m) => findNode(capture.tree, [m.selector, ...m.selectors]))
      .filter(Boolean);
    const first = nodes[0] ?? null;
    placed.push({
      ref: f.id, selector: first?.selector ?? f.selectors[0],
      ...(nodes.length ? { bounds: union(nodes.map((n) => box(n.bounds))) } : {}),
    });
  }
  return { method: { name: METHOD, at }, fragments: placed, sections: [], omitted: [] };
}

/**
 * The flags: a page the detection saw without a header, without a footer; a page too tall
 * for a browser to screenshot whole (no picture to judge it by — parked).
 */
export function flagsOf(detection, byUrl, { tall = [], limit } = {}) {
  const flags = {};
  const add = (id, code, detail) => {
    flags[id] = [...(flags[id] ?? []), { code, kind: 'flag', ...(detail ? { detail } : {}) }];
  };
  for (const part of PARTS) {
    for (const url of detection.without[part]) {
      if (byUrl.has(url)) add(byUrl.get(url), `no-${part}`);
    }
  }
  for (const { id, scrollHeight } of tall) add(id, 'too-tall', `${scrollHeight} px > ${limit}`);
  return flags;
}

/** One eval: outline every element the selectors match and scroll to the top. */
export const outlineExpression = (selectors) => (
  `(() => { let n = 0; for (const s of ${JSON.stringify(selectors)}) {`
  + ' for (const e of document.querySelectorAll(s)) {'
  + ` e.style.outline = ${JSON.stringify(OUTLINE)}; e.style.outlineOffset = "-4px"; n += 1; } }`
  + ' window.scrollTo(0, 0); return n; })()'
);

/** One eval: per selector, how many elements with a visible box it matches here. */
export const resolveExpression = (selectors) => (
  `JSON.stringify(${JSON.stringify(selectors)}.map((s) => [...document.querySelectorAll(s)]`
  + '.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })'
  + '.length))'
);

/** The first of a member's selectors matching exactly one visible element on this page. */
async function resolveMember(browser, member) {
  const selectors = [member.selector, ...member.selectors.filter((s) => s !== member.selector)];
  const counts = parseEval(await browser.eval(resolveExpression(selectors)));
  const one = Array.isArray(counts) ? counts.findIndex((c) => c === 1) : -1;
  if (one >= 0) return selectors[one];
  const any = Array.isArray(counts) ? counts.findIndex((c) => c > 0) : -1;
  return any >= 0 ? selectors[any] : null;
}

/**
 * Evidence for one fragment, on the page that carries all of it: the page with every band
 * outlined, then one crop per band, under `fragments/<id>/shots/`. Returns the paths and
 * the defects (a band that did not resolve).
 */
export async function evidence(cwd, fragment, { io, visit, prepare }) {
  const dir = path.join(cwd, 'migration', 'fragments', fragment.id, 'shots');
  await mkdir(dir, { recursive: true });
  const { variant } = fragment;
  await visit({ url: variant.representative });
  await io.browser.eval(prepare);
  const resolved = [];
  const defects = [];
  for (const member of variant.members) {
    // eslint-disable-next-line no-await-in-loop
    const selector = await resolveMember(io.browser, member);
    if (selector) resolved.push(selector);
    else defects.push(`${member.selector} resolves to nothing on ${variant.representative}`);
  }
  await io.browser.eval(outlineExpression(resolved));
  const rel = (name) => `fragments/${fragment.id}/shots/${name}`;
  const files = [rel('page.png')];
  await io.browser.screenshot(path.join(cwd, 'migration', files[0]));
  for (const [i, selector] of resolved.entries()) {
    const file = rel(`band-${i + 1}.png`);
    try {
      // eslint-disable-next-line no-await-in-loop
      await io.browser.screenshot(path.join(cwd, 'migration', file), selector);
      files.push(file);
    } catch (err) {
      defects.push(`${selector}: ${String(err.message).split('\n')[0]}`);
    }
  }
  return { files, defects };
}

const pct = (x) => `${Math.round(x * 100)} %`;

/** The detection in words, for the operator: one note. */
export function renderNote(detection, fragments, defects) {
  const lines = [`# Chrome: ${detection.capturedPages} pages read`, ''];
  for (const part of PARTS) {
    const own = fragments.filter((f) => f.part === part);
    lines.push(`## ${part}: ${own.length ? `${own.length} design(s)` : 'none found'}`, '');
    for (const f of own) {
      const v = f.variant;
      lines.push(`### ${f.label ?? part} \`${f.id}\` — ${v.pages.length} pages`
        + ` (${pct(v.support)}), group \`${v.group}\``, '',
      `Representative: ${v.representative}`, '',
      '| band | tag | position | on pages |', '|---|---|---|---|',
      ...v.members.map((m) => `| \`${m.selector}\` | ${m.tag} | y ${m.bounds.y}, `
          + `${m.bounds.height} px high | ${m.pages} |`), '');
      if (v.optional.length) {
        lines.push('Optional bands (not on every page of the design):', '',
          ...v.optional.map((m) => `- \`${m.selector}\` on ${m.onPages} of ${v.pages.length}`),
        '');
      }
    }
    const without = detection.without[part];
    lines.push(`Pages without a ${part}: ${without.length}`,
      ...without.slice(0, 20).map((u) => `- ${u}`), '');
  }
  if (detection.unplaced.length) {
    lines.push('## Recurring, neither top nor bottom', '',
      ...detection.unplaced.map((m) => (
        `- \`${m.selector}\` on ${m.pages} pages (${pct(m.support)})`)), '');
  }
  if (detection.rejected.length) {
    lines.push('## Rejected candidates', '',
      ...detection.rejected.map((m) => `- \`${m.selector}\` (${pct(m.support)}): ${m.reason}`), '');
  }
  if (defects.length) lines.push('## Evidence defects', '', ...defects.map((d) => `- ${d}`), '');
  lines.push('## Limits of the method', '', ...detection.limits.map((l) => `- ${l}`), '');
  return lines.join('\n');
}

/**
 * The detect phase: the chrome from every stored tree, written as fragments, fragment and
 * page compositions, flags and evidence; the note; the website refreshed.
 */
export async function detect(cwd, { io, run, access, visit, minWidth = MIN_WIDTH,
  now = () => new Date() }) {
  const {
    runs, store, website, composition, pages, notes, trees,
  } = await data(cwd);
  await runs.update(cwd, run.id, { current: 'detect' });
  const all = await captures(cwd);
  if (!all.length) throw new Error('no visual tree stored; nothing to detect the chrome from');
  const byUrl = new Map(all.map((c) => [c.url, c.page.id]));
  const detection = detectChrome(candidates(all), {
    pages: all.map((c) => c.url),
    pageHeights: all.map((c) => c.tree.bounds.height),
    groupOf: (url) => all.find((c) => c.url === url)?.page.group,
    consentSelectors: access.overlays.map((o) => o.selector).filter(Boolean),
  });
  const at = now().toISOString();
  const fragments = PARTS.flatMap((part) => fragmentsOf(part, detection[part], store.id))
    .map((f) => ({ ...f, id: f.id ?? website.fragmentId('template', f.part) }));
  const defects = [];
  const prepare = preparedAtTop(pageExpression(access));
  for (const f of fragments) {
    // eslint-disable-next-line no-await-in-loop
    await runs.update(cwd, run.id, { current: `evidence ${f.id}` });
    // eslint-disable-next-line no-await-in-loop
    const shots = await evidence(cwd, f, { io, visit, prepare });
    f.evidence = shots.files;
    defects.push(...shots.defects);
  }
  await website.writeFragments(cwd, {
    method: { name: METHOD, at, inputs: inputsHash(all.map((c) => c.page.id), minWidth) },
    fragments: fragments.map(({ variant, ...f }) => f),
    rejected: detection.rejected.map((m) => ({ selector: m.selector, reason: m.reason })),
  });
  for (const f of fragments) {
    // eslint-disable-next-line no-await-in-loop
    await composition.writeFragment(cwd, f.id, fragmentComposition(f, at));
  }
  await composition.writeMany(cwd, all.map((c) => (
    { pageId: c.page.id, composition: pageComposition(c, fragments, at) })));
  const limit = trees.SCREENSHOT_LIMIT;
  const tall = all.filter((c) => c.scrollHeight > limit)
    .map((c) => ({ id: c.page.id, scrollHeight: c.scrollHeight }));
  await pages.setReasons(cwd, 'chrome', flagsOf(detection, byUrl, { tall, limit }));
  await website.refresh(cwd);
  const summary = `${all.length} pages read; ${PARTS.map((p) => `${p}: `
    + `${fragments.filter((f) => f.part === p).length}, ${detection.without[p].length} without`)
    .join('; ')}; ${tall.length} too tall; ${detection.rejected.length} candidate(s) rejected.`;
  await notes.add(cwd, { step: 'chrome', author: 'runner', summary,
    body: renderNote(detection, fragments, defects) });
  return { summary, fragments: fragments.length };
}

/** Pending work: trees to capture, or a detection older than the stored trees. */
export async function pending(cwd) {
  const { website, trees } = await data(cwd);
  const toCapture = await pagesToCapture(cwd);
  if (toCapture.length) return toCapture.map((p) => p.id);
  const readable = new Set((await readablePages(cwd)).map((p) => p.id));
  const stored = (await trees.list(cwd)).filter((id) => readable.has(id));
  if (!stored.length) return [];
  const fragments = await website.readFragments(cwd);
  return fragments?.method.inputs === inputsHash(stored, MIN_WIDTH) ? [] : ['detect'];
}

/** Done when every readable page has a tree and the fragments were detected from them. */
export async function check(cwd) {
  const { runs } = await data(cwd);
  const newest = await runs.newest(cwd, 'chrome');
  if (newest && ['queued', 'running'].includes(runs.liveness(newest))) {
    return { pass: false, note: `chrome run ${newest.current ?? ''}`.trim() };
  }
  const work = await pending(cwd);
  if (!work.length) return { pass: true };
  if (work[0] === 'detect') return { pass: false, note: 'trees changed since the last detection' };
  return { pass: false, note: `${work.length} page(s) without a visual tree` };
}

/** The real io: offline proxy, playwright-cli with the page-tree bundle injected. */
export async function realIo(cwd) {
  const { proxyScript, treeBundle, cli } = await tools(cwd);
  const { migration } = await data(cwd);
  const also = (await migration.open(cwd)).source.assetOrigins ?? [];
  const work = path.join(cwd, 'migration', '.work');
  return {
    ...defaultIo,
    treeBundle,
    startProxy: proxyStarter(proxyScript, cacheDir(cwd), defaultIo, { also }),
    browser: playwright(cli, { io: defaultIo, cwd: work, session: sessionName(cwd, 'chrome') }),
  };
}

/**
 * The worker: one run, both phases, one offline browser session. `visit` opens the first
 * page and navigates to the rest; every URL goes through the proxy.
 */
export async function workerMain(cwd, { io: given } = {}) {
  const io = given ?? await realIo(cwd);
  const { migration, runs, website } = await data(cwd);
  const m = await migration.open(cwd);
  const access = await website.readAccess(cwd);
  if (!access) throw new Error('no website/access.json; run the access step first');
  const targets = await pagesToCapture(cwd);
  const run = await runs.start(cwd, 'chrome', { capture: targets.length, minWidth: MIN_WIDTH },
    { pid: process.pid });
  await runs.update(cwd, run.id, { state: 'running', total: targets.length });
  const origin = new URL(m.source.origin).origin;
  const proxy = await io.startProxy({ offline: true });
  const config = await writeBrowserConfig(cwd, 'chrome', access, proxy.port,
    { initScript: io.treeBundle, onlyProxy: true });
  let opened = false;
  const visit = async (page) => {
    const url = viaProxy(page.url, origin, proxy.port);
    if (opened) return io.browser.goto(url);
    opened = true;
    return io.browser.open(url, { config, persistent: access.browser.persistent === true });
  };
  try {
    const captured = await captureTrees(cwd, targets, { io, run, access, visit });
    const detected = await detect(cwd, { io, run, access, visit });
    const summary = `${captured.captured} tree(s) captured, ${captured.failures.length} failed; `
      + detected.summary;
    await runs.finish(cwd, run.id, { state: 'done', summary });
    return { run: run.id, summary };
  } catch (err) {
    const error = String(err.message).split('\n')[0];
    await runs.finish(cwd, run.id, { state: 'failed', error, summary: 'see error' });
    throw err;
  } finally {
    await io.browser.close().catch(() => {});
    await proxy.stop();
  }
}
