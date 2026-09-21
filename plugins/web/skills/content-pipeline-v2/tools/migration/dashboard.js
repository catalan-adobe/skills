// Read-only dashboard over migration/: status.json (the runner's view of the steps),
// project.json, setup.json, urls/urls.json (the inventory), chrome/chrome.json,
// elements/elements.json, mapping/inventory.json, REPORT.md. No writes, no deps.
const BASE = '/migration';
const ROWS = 200;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const chip = (text, cls = '') => `<span class="chip ${esc(cls)}">${esc(text)}</span>`;

// A missing file may come back as the site's 404 page with a 200: parse, never trust.
async function json(rel) {
  const res = await fetch(`${BASE}/${rel}`, { cache: 'no-store' });
  if (!res.ok) return null;
  try { return await res.json(); } catch { return null; }
}
async function text(rel) {
  const res = await fetch(`${BASE}/${rel}`, { cache: 'no-store' });
  return res.ok ? res.text() : null;
}

function table(headers, rows) {
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const urlCell = (c, i) => i === 0 && String(c).startsWith('<a');
  const cell = (c, i) => `<td class="${urlCell(c, i) ? 'url' : ''}">${c}</td>`;
  const body = rows.map((r) => `<tr>${r.map(cell).join('')}</tr>`);
  return `<table><thead><tr>${head}</tr></thead><tbody>${body.join('')}</tbody></table>`;
}
const link = (url) => (/^https?:\/\//i.test(String(url))
  ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>` : esc(url));
const counts = (records, key) => {
  const map = new Map();
  for (const r of records) {
    const k = key(r);
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
};

function renderProject(project, setup, status) {
  const ref = project?.skills?.ref ? `@${project.skills.ref}` : '';
  const skills = project?.skills ? `${project.skills.repo}${ref}` : 'adobe/skills';
  const when = (iso) => esc(String(iso ?? '').slice(0, 16).replace('T', ' '));
  $('#project').innerHTML = project
    ? `${link(project.origin)} · created ${when(project.created)}`
      + ` · skills from <code>${esc(skills)}</code>`
      + (setup?.node ? ` · Node ${esc(setup.node.version)}` : '')
      + (status?.generatedAt ? ` · status ${when(status.generatedAt)} UTC` : '')
      + cacheServerLine(status?.cacheServer)
    : 'No <code>migration/project.json</code> — run <code>status.mjs init</code>.';
}

function cacheServerLine(server) {
  if (!server) return '';
  return server.running
    ? ` · cache server <a href="${esc(server.url)}/__status">${esc(server.url)}</a>`
      + ` (offline, ${Number(server.cached)} stored)`
    : ' · cache server not running (<code>status.mjs cache serve</code>)';
}

/** The cache step's live label from cache/progress.json, ahead of the next status.json. */
function liveCache(progress) {
  if (!progress?.open) return null;
  const r = progress.running;
  const queued = progress.jobs.filter((j) => j.state === 'queued').map((j) => j.selection);
  const head = r ? `${r.done}/${r.total} (${r.selection})` : 'worker not started';
  const now = r?.current ? ` · now ${r.current}` : '';
  return `${head}${queued.length ? ` · queued: ${queued.join(', ')}` : ''}${now}`;
}

function renderSteps(status, progress) {
  // A read that failed (a writer mid-write, a slow server) keeps what is on screen.
  if (!status && $('#steps tbody')) return;
  const live = liveCache(progress);
  const steps = (status?.steps ?? []).map((s) => (s.id === 'cache' && live
    ? { ...s, state: 'running', running: live } : s));
  $('#steps .panel').innerHTML = status
    ? table(['step', 'state', 'tier', 'blocked by', 'via'], steps.map((s) => [
      `<strong>${esc(s.id)}</strong>`,
      chip(s.state, s.state) + (s.running ? ` ${esc(s.running)}` : s.note ? ` ${esc(s.note)}` : ''),
      esc(s.tier),
      esc(s.blockedBy.join(', ')), esc(s.skill ?? 'runner'),
    ]))
    : '<p class="muted">No <code>status.json</code> yet — run <code>status.mjs</code> once.</p>';
}

function renderInventory(records) {
  if (!records.length) {
    $('#inventory .panel').innerHTML = '<p class="muted">No inventory yet (scan step).</p>';
    return;
  }
  const cached = records.filter((r) => r.cache).length;
  const unverified = records.filter((r) => r.cache && r.cache.verified === false).length;
  const byKind = counts(records, (r) => r.kind ?? 'unclassified');
  const byGroup = counts(records, (r) => r.group || '(root)');
  const cards = [
    ['URLs', records.length],
    ['cached', `${cached} <span class="muted">/ ${records.length}</span>`
      + (unverified ? `<div class="muted small">${unverified} not yet verified</div>` : '')],
    ...byKind,
  ].map(([label, n]) => `<div class="card"><div class="n">${n}</div>${chip(label, label)}</div>`);
  const groupRow = ([g, n]) => {
    const inGroup = records.filter((r) => (r.group || '(root)') === g);
    return [esc(g), n, inGroup.filter((r) => r.cache).length,
      inGroup.filter((r) => r.kind === 'page').length,
      inGroup.filter((r) => r.kind && r.kind !== 'page').length];
  };
  const groups = table(['group', 'URLs', 'cached', 'pages', 'other kinds'],
    byGroup.slice(0, 25).map(groupRow));
  const rest = byGroup.length - 25;
  const more = rest > 0 ? `<p class="muted">… and ${rest} more groups</p>` : '';
  $('#inventory .panel').innerHTML = `<div class="cards">${cards.join('')}</div><h3>By group</h3>`
    + groups + more;
}

function renderRedirects(records) {
  const rows = records.filter((r) => r.kind === 'redirect');
  $('#redirects .panel').innerHTML = rows.length
    ? table(['from', 'status', 'to', 'in list'], rows.map((r) => [
      link(r.url), esc(r.redirect?.status ?? ''), r.redirect?.target ? link(r.redirect.target)
        : esc(r.finalUrl ?? ''), r.redirect?.targetInList ? 'yes' : 'no',
    ]))
    : '<p class="muted">None recorded yet.</p>';
}

function renderNotToMigrate(records) {
  const rows = records.filter((r) => r.kind && r.kind !== 'page');
  const why = (r) => (r.kind === 'redirect' ? 'redirect — migrate the target'
    : r.kind === 'error' ? `error ${r.http?.status ?? ''}`
      : r.kind === 'binary' ? `binary ${r.http?.contentType ?? ''}` : r.kind);
  $('#not-to-migrate .panel').innerHTML = rows.length
    ? table(['url', 'kind', 'why', 'migrate'], rows.map((r) => [
      link(r.url), chip(r.kind, r.kind), esc(why(r)), esc(r.migrate ?? ''),
    ]))
    : '<p class="muted">None recorded yet.</p>';
}

let urlRecords = [];
let urlsBound = false;
// The elements inventory, by page URL, once the elements step is done: composition chips
// and the coverage badge in the URL table come from it.
let elementPages = null;
let typeIndex = new Map();

/** Called on every refresh: options are rebuilt, the operator's filter values are kept. */
function renderUrls(records) {
  urlRecords = records;
  const form = $('#urls .filters');
  const fill = (name, values) => {
    const select = form.elements[name];
    const kept = select.value;
    while (select.options.length > 1) select.remove(1);
    for (const v of values) select.insertAdjacentHTML('beforeend', `<option>${esc(v)}</option>`);
    if ([...select.options].some((o) => o.value === kept)) select.value = kept;
  };
  fill('kind', counts(records, (r) => r.kind ?? 'unclassified').map(([k]) => k));
  fill('group', counts(records, (r) => r.group || '(root)').map(([g]) => g));
  if (!urlsBound) {
    form.addEventListener('input', drawUrls);
    urlsBound = true;
  }
  drawUrls();
}

function drawUrls() {
  const records = urlRecords;
  const form = $('#urls .filters');
  const q = form.elements.q.value.trim().toLowerCase();
  const { kind, group, cached, covered } = Object.fromEntries(['kind', 'group', 'cached', 'covered']
    .map((n) => [n, form.elements[n].value]));
  form.elements.covered.hidden = !elementPages;
  const page = (r) => elementPages?.get(r.url);
  const rows = records.filter((r) => (!q || r.url.toLowerCase().includes(q))
    && (!kind || (r.kind ?? 'unclassified') === kind)
    && (!group || (r.group || '(root)') === group)
    && (!cached || (cached === 'yes') === Boolean(r.cache))
    && (!covered || page(r)?.covered === covered));
  form.querySelector('[data-count]').textContent = `${rows.length} of ${records.length}`
    + (rows.length > ROWS ? ` (first ${ROWS} shown)` : '');
  const composition = (r) => {
    const p = page(r);
    if (!p) return '';
    return chip(p.covered, `cover-${p.covered}`) + ' '
      + p.sections.map((s) => chip(typeIndex.get(s.type)?.label ?? s.type, 'type')).join(' ');
  };
  $('#urls .panel').innerHTML = table(
    ['url', 'kind', 'http', 'redirect → / final', 'migrate', 'cached', 'ms',
      ...(elementPages ? ['composition'] : [])],
    rows.slice(0, ROWS).map((r) => [
      link(r.url), chip(r.kind ?? 'unclassified', r.kind ?? 'unclassified'),
      esc(r.http ? `${r.http.status} ${r.http.contentType ?? ''}` : ''),
      esc(r.redirect?.target ?? (r.finalUrl && r.finalUrl !== r.url ? r.finalUrl : '')),
      esc(r.migrate ?? ''), esc(r.cache?.at?.slice(0, 16).replace('T', ' ') ?? ''),
      esc(r.cache?.durationMs ?? ''),
      ...(elementPages ? [composition(r)] : []),
    ]),
  );
}

/**
 * Short labels for the types: the identity without its tag, minus the class tokens more
 * than half of the types share (a framework's marker class says nothing about one type).
 */
function typeLabels(types) {
  const tokens = (t) => t.identity.replace(/^[A-Z0-9]+#\.?/, '').split('.').filter(Boolean);
  const recurring = types.filter((t) => t.recurring);
  const seen = new Map();
  for (const t of recurring) {
    for (const k of new Set(tokens(t))) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const common = new Set([...seen].filter(([, n]) => n > recurring.length / 2).map(([k]) => k));
  return new Map(types.map((t) => {
    const own = tokens(t).filter((k) => !common.has(k));
    return [t.id, own.join('.') || tokens(t).join('.') || t.identity.split('#')[0]];
  }));
}

/** The mapping's word on a type, as a chip: block <name>, default content, skip, undecided. */
function kindChip(id) {
  if (!mappingKinds) return '';
  const d = mappingKinds.get(id);
  if (!d) return '';
  if (d.kind === 'block') return chip(`block ${d.block}`, 'done');
  if (d.kind === 'default-content') return chip('default content', 'ready');
  if (d.kind === 'skip') return chip('skip', 'blocked');
  return chip('undecided', 'waiting-operator');
}

function elementType(t, label) {
  const shots = t.screenshots?.instances ?? [];
  const crop = shots[0]
    ? `<a href="${BASE}/elements/${esc(shots[0])}"><img class="shot" alt="${esc(t.id)}"
        src="${BASE}/elements/${esc(shots[0])}"></a>` : '';
  const more = shots.slice(1).map((f, i) => (
    `<a href="${BASE}/elements/${esc(f)}">crop ${i + 2}</a>`)).join(' · ');
  const defects = (t.screenshotError ?? []).map((e) => `<li class="bad">${esc(e)}</li>`).join('');
  return `<article class="variant">
    <h3>${esc(label)} · ${t.pages} pages (${Math.round(t.support * 100)} %) ${kindChip(t.id)}</h3>
    <p class="small"><code>${esc(t.identity)}</code> · ${esc(t.id)}</p>
    <p class="small">${t.instances} instances · ${t.variants.length} variants · ${
  t.heightRange[0]}–${t.heightRange[1]} px${more ? ` · ${more}` : ''}</p>
    ${crop}${defects ? `<ul>${defects}</ul>` : ''}
  </article>`;
}

/** The elements panel: coverage, the groups × compositions table, the types, the tail. */
function renderElements(r) {
  const panel = $('#elements .panel');
  if (!r) {
    panel.innerHTML = '<p class="muted">No <code>elements/elements.json</code> yet — '
      + '<code>elements.mjs</code> after the capture and chrome steps.</p>';
    elementPages = null;
    return;
  }
  elementPages = new Map(r.pages.map((p) => [p.url, p]));
  const labels = typeLabels(r.types);
  typeIndex = new Map(r.types.map((t) => [t.id, { ...t, label: labels.get(t.id) }]));
  const last = r.runs.at(-1);
  const recurring = r.types.filter((t) => t.recurring);
  const unique = r.types.filter((t) => !t.recurring);
  const cards = [
    ['pages', r.capturedPages], ['types', r.types.length], ['recurring', recurring.length],
    ['fully covered', last.covered.full], ['partially', last.covered.partial],
    ['not covered', last.covered.none], ['compositions', r.compositions.length],
    ['saturated groups', `${r.groups.filter((g) => g.saturated).length} / ${r.groups.length}`],
  ].map(([label, n]) => `<div class="card"><div class="n">${n}</div>${chip(label)}</div>`);
  const groups = table(
    ['group', 'pages', 'types', 'compositions', 'dominant', 'new types in last pages', 'saturated'],
    r.groups.map((g) => [esc(g.group), g.pages, g.types, g.compositions,
      `${Math.round(g.dominantShare * 100)} %`, g.recentNewTypes,
      g.saturated ? chip('saturated', 'done') : '']));
  const without = r.groupsWithoutPages?.length
    ? `<p class="muted small">Groups without a captured page: ${
      esc(r.groupsWithoutPages.join(', '))}</p>` : '';
  const tail = unique.length
    ? `<details><summary>Unique types (${unique.length})</summary><ul>${unique.map((t) => (
      `<li><code>${esc(t.identity)}</code> · ${link(t.sample.url)}</li>`)).join('')}</ul>
      </details>` : '';
  panel.innerHTML = `<p class="small">generated ${
    esc(String(r.generatedAt ?? '').slice(0, 16).replace('T', ' '))} UTC · run ${r.runs.length}
    · <a href="${BASE}/elements/evaluation.md">evaluation.md</a></p>
    <div class="cards">${cards.join('')}</div>
    <h3>Groups × compositions</h3>${groups}${without}
    <h3>Recurring types</h3><div class="variants">${
  recurring.map((t) => elementType(t, labels.get(t.id))).join('')}</div>
    ${tail}`;
  drawUrls();
}

function chromeVariant(role, v) {
  const members = v.members.map((m, i) => {
    const crop = v.screenshots?.members?.[i]?.file;
    return `<li><code>${esc(m.selector)}</code> · ${m.pages} pages`
      + (crop ? ` · <a href="${BASE}/chrome/${esc(crop)}">crop</a>` : '') + '</li>';
  }).join('');
  const optional = (v.optional ?? []).map((m) => (
    `<li class="muted"><code>${esc(m.selector)}</code> · optional, on ${m.onPages} pages</li>`
  )).join('');
  const defects = (v.screenshotError ?? []).map((e) => `<li class="bad">${esc(e)}</li>`).join('');
  return `<article class="variant">
    <h3>${esc(role)} ${esc(v.id)} · ${v.pages.length} pages (${Math.round(v.support * 100)} %)
      · <code>${esc(v.group)}</code></h3>
    <p class="small">representative ${link(v.representative)}</p>
    <ul>${members}${optional}${defects}</ul>
    ${v.screenshots?.full
    ? `<a href="${BASE}/chrome/${esc(v.screenshots.full)}"><img class="shot ${esc(role)}"
        alt="${esc(role)} ${esc(v.id)}"
        src="${BASE}/chrome/${esc(v.screenshots.full)}"></a>` : ''}
  </article>`;
}

/** The chrome panel: variants per role with screenshots, then what was left out. */
function renderChrome(chrome) {
  const panel = $('#chrome .panel');
  if (!chrome) {
    panel.innerHTML = '<p class="muted">No <code>chrome/chrome.json</code> yet — '
      + '<code>chrome.mjs</code> after the capture step.</p>';
    return;
  }
  const role = (name) => (chrome[name].length
    ? chrome[name].map((v) => chromeVariant(name, v)).join('')
    : `<p class="muted">no ${name} recurs on enough pages</p>`);
  const list = (items, render) => (items.length ? `<ul>${items.map(render).join('')}</ul>`
    : '<p class="muted">none</p>');
  panel.innerHTML = `<p class="small">${chrome.capturedPages} pages captured · generated ${
    esc(String(chrome.generatedAt ?? '').slice(0, 16).replace('T', ' '))} UTC</p>
    <div class="variants">${role('header')}${role('footer')}</div>
    <details><summary>Pages without a header (${chrome.without.header.length}) or footer (${
  chrome.without.footer.length})</summary>
      ${list([...new Set([...chrome.without.header, ...chrome.without.footer])],
    (u) => `<li>${link(u)}</li>`)}</details>
    <details><summary>Unplaced (${chrome.unplaced.length}) and rejected (${
  chrome.rejected.length})</summary>
      ${list([...chrome.unplaced.map((m) => ({ ...m, reason: 'unplaced' })), ...chrome.rejected],
    (m) => `<li><code>${esc(m.selector)}</code> · ${Math.round(m.support * 100)} % · ${
      esc(m.reason)}</li>`)}</details>
    <details><summary>Limits</summary>${
  list(chrome.limits, (l) => `<li>${esc(l)}</li>`)}</details>`;
}

function renderReport(md) {
  $('#report .panel').innerHTML = md
    ? `<pre class="report">${esc(md)}</pre>`
    : '<p class="muted">No <code>REPORT.md</code> yet.</p>';
}

/** The block inventory panel: blocks with a crop each, default content, skipped, coverage. */
function renderBlocks(inv) {
  const panel = $('#blocks .panel');
  if (!inv) {
    panel.innerHTML = '<p class="muted">No <code>mapping/inventory.json</code> yet — '
      + '<code>mapping.mjs</code> after the elements step; the panel shows once every type is'
      + ' decided.</p>';
    return;
  }
  const cards = [
    ['blocks', inv.blocks.length], ['default content types', inv.defaultContent.types.length],
    ['skipped', inv.skipped.length], ['undecided', inv.undecided.length],
    ['pages covered', `${inv.coverage.covered} / ${inv.coverage.pages}`],
  ].map(([label, n]) => `<div class="card"><div class="n">${n}</div>${chip(label)}</div>`);
  const block = (b) => {
    const shot = b.screenshots?.[0];
    const crop = shot ? `<a href="${BASE}/elements/${esc(shot)}"><img class="shot"
        alt="${esc(b.name)}" src="${BASE}/elements/${esc(shot)}"></a>` : '';
    const types = b.identities.map((i) => `<code>${esc(i)}</code>`).join(' ');
    return `<article class="variant">
    <h3>${esc(b.name)} · ${b.pages} pages</h3>
    <p class="small">${types}</p>
    <p class="small">${b.instances} instances · ${b.variants} variants · ${b.medianHeight} px${
  b.sample ? ` · ${link(b.sample.url)}` : ''}</p>
    ${b.notes?.length ? `<p class="small">${esc(b.notes.join(' · '))}</p>` : ''}${crop}
  </article>`;
  };
  const dc = inv.defaultContent.types.map((id) => `<code>${esc(typeIndex?.get(id)?.identity
    ?? id)}</code>`).join(' ');
  const skipped = inv.skipped.length ? `<h3>Skipped</h3><ul>${inv.skipped.map((s) => (
    `<li><code>${esc(s.identity)}</code> · ${s.pages} pages${
      s.notes ? ` — ${esc(s.notes)}` : ''}</li>`)).join('')}</ul>` : '';
  const open = inv.coverage.uncovered.length ? table(['page', 'open types'],
    inv.coverage.uncovered.slice(0, 25).map((u) => [link(u.url), u.types.map((id) => (
      `<code>${esc(typeIndex?.get(id)?.identity ?? id)}</code>`)).join(' ')])) : '';
  panel.innerHTML = `<p class="small"><a href="${BASE}/mapping/mapping.md">mapping.md</a> ·
    <a href="${BASE}/mapping/mapping.json">mapping.json</a></p>
    <div class="cards">${cards.join('')}</div>
    <h3>Blocks</h3><div class="variants">${inv.blocks.map(block).join('')}</div>
    <h3>Default content</h3><p class="small">${dc || '<span class="muted">none</span>'} · ${
  inv.defaultContent.instances} instances on ${inv.defaultContent.pages} pages</p>
    ${skipped}${open ? `<h3>Pages with an open section</h3>${open}` : ''}`;
}

let chromeSeen = null;
let elementsSeen = null;
let mappingSeen = null;
let mappingKinds = null;
/** inventory.json is fetched when the mapping step is done; the kinds then dress the types. */
async function refreshMapping(status) {
  const step = status?.steps?.find((s) => s.id === 'mapping');
  if (!step) return;
  if (step.state !== 'done') {
    if (mappingSeen === null) { renderBlocks(null); mappingSeen = 'none'; }
    return;
  }
  if (mappingSeen === status.generatedAt) return;
  mappingSeen = status.generatedAt;
  const [inv, mapping] = await Promise.all([
    json('mapping/inventory.json'), json('mapping/mapping.json'),
  ]);
  mappingKinds = mapping ? new Map(Object.entries(mapping.types)) : null;
  renderBlocks(inv);
  if (elementsSeen && elementsSeen !== 'none') {
    renderElements(await json('elements/elements.json'));
  }
}
/** elements.json (large) is fetched like chrome.json: only when the step is done and new. */
async function refreshElements(status) {
  const step = status?.steps?.find((s) => s.id === 'elements');
  if (!step) return;
  if (step.state !== 'done') {
    if (elementsSeen === null) { renderElements(null); elementsSeen = 'none'; }
    return;
  }
  if (elementsSeen === status.generatedAt) return;
  elementsSeen = status.generatedAt;
  renderElements(await json('elements/elements.json'));
}
/**
 * chrome.json is fetched only once status.json says the chrome step is done, and again
 * when that status was produced later: a missing file is slow to answer (the local server
 * asks the remote origin for it), and nothing else may wait behind such a request.
 */
async function refreshChrome(status) {
  const step = status?.steps?.find((s) => s.id === 'chrome');
  if (!step) return;
  if (step.state !== 'done') {
    if (chromeSeen === null) { renderChrome(null); chromeSeen = 'none'; }
    return;
  }
  if (chromeSeen === status.generatedAt) return;
  chromeSeen = status.generatedAt;
  renderChrome(await json('chrome/chrome.json'));
}

const POLL_MS = 5000;
const IDLE_POLL_MS = 15000;

/** Everything that changes while a cache job runs; polled every 5 s while work is open. */
async function refreshLive() {
  const [status, progress, records] = await Promise.all([
    json('status.json'), json('cache/progress.json'), json('urls/urls.json'),
  ]);
  renderSteps(status, progress);
  await refreshChrome(status);
  await refreshElements(status);
  await refreshMapping(status);
  if (records || !$('#inventory .card')) {
    renderInventory(records ?? []);
    renderRedirects(records ?? []);
    renderNotToMigrate(records ?? []);
    renderUrls(records ?? []);
  }
  $('#live').textContent = progress?.open
    ? `live · updated ${String(progress.updatedAt ?? '').slice(11, 19)} UTC`
    : '';
  return Boolean(progress?.open);
}

const [project, setup, status, report] = await Promise.all([
  json('project.json'), json('setup.json'), json('status.json'), text('REPORT.md'),
]);
renderProject(project, setup, status);
renderReport(report);
let open = await refreshLive();
// Poll always, faster while a job is open: a job started after the page loaded must show
// up too, and the local server no longer reloads the page on file changes.
const tick = async () => {
  open = await refreshLive();
  setTimeout(tick, open ? POLL_MS : IDLE_POLL_MS);
};
setTimeout(tick, open ? POLL_MS : IDLE_POLL_MS);
