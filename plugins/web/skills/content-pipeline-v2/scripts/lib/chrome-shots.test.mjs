import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProject } from './project.mjs';
import {
  outlineExpression, resolveExpression, resolveMember, screenshotVariants,
} from './chrome-shots.mjs';

const ORIGIN = 'https://site.example';

// A fake page: `present` maps selector → how many elements match on it.
function fakeBrowser(present, { failShot = null } = {}) {
  const calls = { goto: [], eval: [], shots: [] };
  return {
    calls,
    goto: async (url) => { calls.goto.push(url); },
    eval: async (expr) => {
      calls.eval.push(expr);
      const list = /^JSON\.stringify\((\[.*?\])\.map/.exec(expr);
      if (list) return JSON.stringify(JSON.parse(list[1]).map((s) => present[s] ?? 0));
      return '3';
    },
    screenshot: async (file, target) => {
      if (target && target === failShot) throw new Error('Command failed\nTimeout 5000ms exceeded');
      calls.shots.push({ file: path.basename(file), target: target ?? null });
    },
  };
}

const member = (selector, ...others) => ({ selector, selectors: [selector, ...others] });

test('resolveMember prefers a selector matching one element, then any, else null', async () => {
  const b = fakeBrowser({ '#a': 0, 'div.a': 2, 'div.b': 1 });
  assert.equal(await resolveMember(b, member('#a', 'div.a', 'div.b')), 'div.b');
  assert.equal(await resolveMember(b, member('#a', 'div.a')), 'div.a');
  assert.equal(await resolveMember(b, member('#a')), null);
  assert.equal(b.calls.eval[0], resolveExpression(['#a', 'div.a', 'div.b']));
});

test('outlineExpression outlines every match and scrolls back to the top', () => {
  const expr = outlineExpression(['#a', 'div.b']);
  assert.match(expr, /querySelectorAll\(s\)/);
  assert.match(expr, /outline = "4px solid #e00"/);
  assert.match(expr, /window\.scrollTo\(0, 0\)/);
  assert.match(expr, /\["#a","div\.b"\]/);
});

test('screenshotVariants: one outlined full page and one crop per resolved member', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpv2-shots-'));
  const p = resolveProject(root);
  const b = fakeBrowser({ '#utility': 1, 'div.nav': 1, '#xf-old': 0, 'div.footer': 1 });
  const variants = [{
    id: '1', representative: `${ORIGIN}/p.html`,
    members: [member('#utility'), member('#xf-old', 'div.footer')],
  }];
  const [v] = await screenshotVariants(p, 'header', variants,
    { browser: b, origin: ORIGIN, port: 3005, prepare: '"prep"' });
  assert.equal(b.calls.goto[0], 'http://127.0.0.1:3005/p.html?_origin=https%3A%2F%2Fsite.example');
  assert.equal(b.calls.eval[0], '"prep"', 'hide rules first');
  assert.deepEqual(v.screenshots, {
    full: 'screenshots/header-1.png',
    members: [
      { selector: '#utility', file: 'screenshots/header-1-m1.png' },
      { selector: '#xf-old', file: 'screenshots/header-1-m2.png' },
    ],
  });
  assert.deepEqual(b.calls.shots, [
    { file: 'header-1.png', target: null },
    { file: 'header-1-m1.png', target: '#utility' },
    { file: 'header-1-m2.png', target: 'div.footer' },
  ], 'the crop uses the selector that resolved here');
  assert.equal(v.members[1].selectorOnRepresentative, 'div.footer');
  assert.equal(v.screenshotError, undefined);
});

test('a member that resolves to nothing, or whose crop fails, is a recorded defect', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpv2-shots-'));
  const p = resolveProject(root);
  const b = fakeBrowser({ '#a': 1, 'div.c': 1 }, { failShot: 'div.c' });
  const [v] = await screenshotVariants(p, 'footer', [{
    id: '2', representative: `${ORIGIN}/`,
    members: [member('#a'), member('#gone'), member('div.c')],
  }], { browser: b, origin: ORIGIN, port: 1 });
  assert.equal(v.screenshots.full, 'screenshots/footer-2.png');
  assert.deepEqual(v.screenshots.members.map((m) => m.selector), ['#a']);
  assert.equal(v.screenshotError.length, 2);
  assert.match(v.screenshotError[0], /#gone resolves on https:\/\/site\.example\/ to nothing/);
  assert.match(v.screenshotError[1], /div\.c: Command failed/);
  assert.equal(v.members[1].selectorOnRepresentative, null);
});
