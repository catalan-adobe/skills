import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SETTINGS, FILE, SCHEMA, approve, assetOrigins, init, open, plan, setting,
} from './migration.mjs';
import { classOf } from './schema.mjs';

const fresh = () => mkdtemp(path.join(os.tmpdir(), 'mdata-mig-'));

test('init writes the one decision file with defaults; refuses a second init', async () => {
  const cwd = await fresh();
  await assert.rejects(init(cwd, {}), /init needs the source origin/);
  const m = await init(cwd, { origin: 'https://www.example.com' });
  assert.equal(m.schema, SCHEMA);
  assert.equal(classOf(SCHEMA), 'decision');
  assert.match(m.id, /^mig-[0-9a-f]{12}$/);
  assert.deepEqual(m.source,
    { origin: 'https://www.example.com/', scope: 'https://www.example.com/', assetOrigins: [] },
    'a bare origin is canonical with its slash; the scope defaults to the origin');
  assert.deepEqual(m.target, { kind: 'eds', repo: '.', owner: null, site: null });
  assert.deepEqual(m.plan, { pages: null, selection: null });
  assert.deepEqual(m.settings, DEFAULT_SETTINGS);
  assert.deepEqual(m.approvals, {});
  assert.ok(m.created && m.updatedAt);
  await assert.rejects(init(cwd, { origin: 'https://www.example.com/' }),
    /migration\.json exists; a migration is created once/);
  assert.deepEqual(await open(cwd), m);
  const withAssets = await assetOrigins(cwd,
    ['https://images.example.com/x/y', 'https://images.example.com']);
  assert.deepEqual(withAssets.source.assetOrigins, ['https://images.example.com'], 'origins, once');
  await assert.rejects(assetOrigins(cwd, ['not a url']), /Invalid URL/);
});

test('init takes a scope under the origin, a target, a plan and settings', async () => {
  const cwd = await fresh();
  await assert.rejects(init(cwd, { origin: 'https://a.example/', scope: 'https://b.example/' }),
    /scope https:\/\/b\.example\/ is not under the origin/);
  const m = await init(cwd, {
    origin: 'https://a.example/', scope: 'https://a.example/en/products/',
    target: { repo: '../site', owner: 'acme', site: 'www' },
    plan: { pages: 500 },
    settings: { pace: 2000, skills: { ref: 'v1.2' } },
  });
  assert.equal(m.source.scope, 'https://a.example/en/products/');
  assert.deepEqual(m.target, { kind: 'eds', repo: '../site', owner: 'acme', site: 'www' });
  assert.deepEqual(m.plan, { pages: 500, selection: null });
  assert.deepEqual(m.settings, { ...DEFAULT_SETTINGS, pace: 2000,
    skills: { repo: 'adobe/skills', ref: 'v1.2' } }, 'settings merge over the defaults');
});

test('setters change one thing and keep the rest; approvals accumulate selections', async () => {
  const cwd = await fresh();
  await init(cwd, { origin: 'https://a.example/' });
  const s = await setting(cwd, 'captureMinWidth', 300);
  assert.equal(s.settings.captureMinWidth, 300);
  assert.equal(s.settings.pace, 1500);
  const sk = await setting(cwd, 'skills', { ref: 'pinned' });
  assert.deepEqual(sk.settings.skills, { repo: 'adobe/skills', ref: 'pinned' });
  const p = await plan(cwd, { pages: 200 });
  assert.deepEqual(p.plan, { pages: 200, selection: null });
  const p2 = await plan(cwd, { selection: 'migrate' });
  assert.deepEqual(p2.plan, { pages: 200, selection: 'migrate' });
  await approve(cwd, 'cache', ['sample-50']);
  const a = await approve(cwd, 'cache', ['blogs', 'sample-50']);
  assert.deepEqual(a.approvals, { cache: ['sample-50', 'blogs'] }, 'in order, once each');
  const e = await approve(cwd, 'elements');
  assert.deepEqual(e.approvals, { cache: ['sample-50', 'blogs'], elements: true });
  await assert.rejects(setting(cwd, 'pace', -1), /\$\.settings\.pace: must be >= 0/);
  assert.equal((await open(cwd)).settings.pace, 1500, 'a refused write changes nothing');
});

test('open names the command when there is no migration; a hand-edited file is checked',
  async () => {
    const cwd = await fresh();
    await assert.rejects(open(cwd), /no migration at .*migration\.json; run: migration init/);
    await init(cwd, { origin: 'https://a.example/' });
    const file = path.join(cwd, 'migration', FILE);
    const data = JSON.parse(await readFile(file, 'utf8'));
    data.target.kind = 'wordpress';
    await writeFile(file, JSON.stringify(data));
    await assert.rejects(open(cwd), /\$\.target\.kind: must be one of "eds"/);
  });
