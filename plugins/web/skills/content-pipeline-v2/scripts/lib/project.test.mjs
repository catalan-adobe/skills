import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProject, upsertSection } from './project.mjs';

test('upsertSection replaces an existing "## <id>" block and appends a new one', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cpv2-report-'));
  const project = resolveProject(dir);
  await mkdir(project.dir, { recursive: true });
  await upsertSection(project, 'setup', 'Node 24.');
  let text = await readFile(project.report, 'utf8');
  assert.match(text, /^# Migration report\n/);
  assert.match(text, /## setup\n\nNode 24\.\n/);
  await upsertSection(project, 'probe', 'Loads headless.');
  await upsertSection(project, 'setup', 'Node 24, all skills present.');
  text = await readFile(project.report, 'utf8');
  assert.equal((text.match(/^## setup$/gm) ?? []).length, 1, 'replaced, not duplicated');
  assert.match(text, /## setup\n\nNode 24, all skills present\.\n\n## probe\n\nLoads headless\./);
  assert.ok(!text.includes('Node 24.\n'), 'old body gone');
});
