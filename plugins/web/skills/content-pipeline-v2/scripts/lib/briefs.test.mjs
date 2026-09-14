import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEPS, STEP_IDS } from './steps.mjs';

const skillRoot = fileURLToPath(new URL('../../', import.meta.url));
const briefsDir = path.join(skillRoot, 'steps');
const MAX_BRIEF_LINES = 60;
const MAX_LINE_LENGTH = 100;
const CLOCK_TEXT = new RegExp(
  [
    String.raw`\bDate\s*\.\s*now\s*\(`,
    String.raw`\bnew\s+Date\s*\(`,
    String.raw`\bperformance\s*\.\s*now\s*\(`,
    String.raw`\btimestamp\b`,
    String.raw`\bcurrent (time|date)\b`,
  ].join('|'),
  'i',
);

const lines = (text) => text.replace(/\n$/, '').split('\n');

async function readBrief(id) {
  return readFile(path.join(briefsDir, `${id}.md`), 'utf8');
}

test('every step has a brief and every brief belongs to a step', async () => {
  const files = (await readdir(briefsDir)).filter((f) => f.endsWith('.md'));
  assert.deepEqual(files.map((f) => f.replace(/\.md$/, '')).sort(), [...STEP_IDS].sort());
});

test('every brief names its check command, sibling skill and artefacts', async () => {
  for (const step of STEPS) {
    const text = await readBrief(step.id);
    assert.ok(text.includes(`status.mjs check ${step.id}`), `${step.id}: check command`);
    if (step.skill) assert.ok(text.includes(step.skill), `${step.id}: names ${step.skill}`);
    for (const artefact of step.writes) {
      assert.ok(text.includes(artefact), `${step.id}: names ${artefact}`);
    }
  }
});

test('briefs stay short, within the line limit and free of clock text', async () => {
  for (const id of STEP_IDS) {
    const text = await readBrief(id);
    const all = lines(text);
    assert.ok(all.length <= MAX_BRIEF_LINES, `${id}: ${all.length} lines`);
    all.forEach((line, i) => {
      assert.ok(line.length <= MAX_LINE_LENGTH, `${id}.md:${i + 1} is ${line.length} chars`);
    });
    assert.ok(!CLOCK_TEXT.test(text), `${id}: contains clock or timestamp text`);
  }
});

test('every brief ends its Done section with the check command in a bash block', async () => {
  for (const id of STEP_IDS) {
    const done = (await readBrief(id)).split('\n## Done\n')[1];
    assert.ok(done, `${id}: has a Done section`);
    const block = /```bash\nnode <skill>\/scripts\/status\.mjs check \S+\n```/;
    assert.match(done, block, `${id}: bash block`);
  }
});

test('the cache brief opens on the approval gate', async () => {
  const [first] = lines(await readBrief('cache')).filter((l) => l.trim() && !l.startsWith('#'));
  assert.match(first, /status\.mjs approve cache/);
});

test('SKILL.md mentions every step id and keeps every line within the limit', async () => {
  const text = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
  for (const id of STEP_IDS) assert.ok(text.includes(`\`${id}\``), `SKILL.md mentions ${id}`);
  lines(text).forEach((line, i) => {
    assert.ok(line.length <= MAX_LINE_LENGTH, `SKILL.md:${i + 1} is ${line.length} chars`);
  });
  const cmds = ['status.mjs init --origin', 'setup --install', 'status.mjs --text'];
  for (const cmd of [...cmds, 'approve cache']) {
    assert.ok(text.includes(cmd), `SKILL.md quick start names ${cmd}`);
  }
});

test('the project-structure reference lists every declared artefact', async () => {
  const file = path.join(skillRoot, 'references', 'project-structure.md');
  const text = await readFile(file, 'utf8');
  const declared = new Set(['project.json', 'setup.json', 'REPORT.md', '.work/']);
  for (const step of STEPS) step.writes.forEach((w) => declared.add(w));
  for (const artefact of declared) assert.ok(text.includes(artefact), `lists ${artefact}`);
  lines(text).forEach((line, i) => {
    assert.ok(line.length <= MAX_LINE_LENGTH, `project-structure.md:${i + 1} too long`);
  });
});

test('browser briefs keep screenshots under migration/ and warn about eval expressions',
  async () => {
    for (const id of ['prep', 'prep-verify']) {
      const text = await readBrief(id);
      assert.ok(text.includes('migration/prep/'), `${id}: screenshots under migration/prep/`);
      assert.match(text, /\(\(\) => \{ … \}\)\(\)/, `${id}: eval takes an expression`);
    }
  });

test('SKILL.md makes the harness rung and the tier column actionable', async () => {
  const text = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
  assert.match(text, /say which one and why before the first\s+step/);
  assert.match(text, /The tier column is an instruction/);
  assert.match(text, /REPORT\.md.*## setup/s);
  assert.match(text, /never two steps in one item/);
});

test('the cache brief runs the driver and forbids plain HTTP warming and deletions', async () => {
  const text = await readBrief('cache');
  assert.match(text, /scripts\/warm\.mjs/);
  assert.match(text, /Never fetch pages with `curl`/);
  assert.match(text, /Never delete anything under `migration\/cache\/`/);
  assert.match(text, /pick --count <n> --write <name>/);
  const skill = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
  assert.match(skill, /warm\.mjs/);
  assert.match(skill, /Never warm the cache with `curl`/);
});
