// Read-only dashboard over migration/: status.json (the runner's view of the steps),
// project.json, setup.json, urls/urls.json (the inventory), REPORT.md. No writes, no deps.
const BASE = '/migration';
const ROWS = 200;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const chip = (text, cls = '') => `<span class="chip ${esc(cls)}">${esc(text)}</span>`;

async function json(rel) {
  const res = await fetch(`${BASE}/${rel}`, { cache: 'no-store' });
  if (!res.ok) return null;
  return res.json();
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
const link = (url) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
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
    : 'No <code>migration/project.json</code> — run <code>status.mjs init</code>.';
}

function renderSteps(status) {
  $('#steps .panel').innerHTML = status
    ? table(['step', 'state', 'tier', 'blocked by', 'via'], status.steps.map((s) => [
      `<strong>${esc(s.id)}</strong>`,
      chip(s.state, s.state) + (s.running ? ` ${esc(s.running)}` : ''),
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
  const byKind = counts(records, (r) => r.kind ?? 'unclassified');
  const byGroup = counts(records, (r) => r.group || '(root)');
  const cards = [
    ['URLs', records.length],
    ['cached', `${cached} <span class="muted">/ ${records.length}</span>`],
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

function renderUrls(records) {
  const form = $('#urls .filters');
  const fill = (name, values) => {
    const select = form.elements[name];
    for (const v of values) select.insertAdjacentHTML('beforeend', `<option>${esc(v)}</option>`);
  };
  fill('kind', counts(records, (r) => r.kind ?? 'unclassified').map(([k]) => k));
  fill('group', counts(records, (r) => r.group || '(root)').map(([g]) => g));
  const draw = () => {
    const q = form.elements.q.value.trim().toLowerCase();
    const { kind, group, cached } = Object.fromEntries(['kind', 'group', 'cached']
      .map((n) => [n, form.elements[n].value]));
    const rows = records.filter((r) => (!q || r.url.toLowerCase().includes(q))
      && (!kind || (r.kind ?? 'unclassified') === kind)
      && (!group || (r.group || '(root)') === group)
      && (!cached || (cached === 'yes') === Boolean(r.cache)));
    form.querySelector('[data-count]').textContent = `${rows.length} of ${records.length}`
      + (rows.length > ROWS ? ` (first ${ROWS} shown)` : '');
    $('#urls .panel').innerHTML = table(
      ['url', 'kind', 'http', 'redirect → / final', 'migrate', 'cached', 'ms'],
      rows.slice(0, ROWS).map((r) => [
        link(r.url), chip(r.kind ?? 'unclassified', r.kind ?? 'unclassified'),
        esc(r.http ? `${r.http.status} ${r.http.contentType ?? ''}` : ''),
        esc(r.redirect?.target ?? (r.finalUrl && r.finalUrl !== r.url ? r.finalUrl : '')),
        esc(r.migrate ?? ''), esc(r.cache?.at?.slice(0, 16).replace('T', ' ') ?? ''),
        esc(r.cache?.durationMs ?? ''),
      ]),
    );
  };
  form.addEventListener('input', draw);
  draw();
}

function renderReport(md) {
  $('#report .panel').innerHTML = md
    ? `<pre class="report">${esc(md)}</pre>`
    : '<p class="muted">No <code>REPORT.md</code> yet.</p>';
}

const [project, setup, status, records, report] = await Promise.all([
  json('project.json'), json('setup.json'), json('status.json'), json('urls/urls.json'),
  text('REPORT.md'),
]);
renderProject(project, setup, status);
renderSteps(status);
renderInventory(records ?? []);
renderRedirects(records ?? []);
renderNotToMigrate(records ?? []);
renderUrls(records ?? []);
renderReport(report);
