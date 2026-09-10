import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from './serve.mjs';

test('startFixtureServer serves files on an ephemeral port',
  async (t) => {
    const s = await startFixtureServer();
    t.after(async () => s.close());
    assert.match(s.origin, /^http:\/\/127\.0\.0\.1:\d+$/);

    const root = await fetch(`${s.origin}/`);
    assert.equal(root.status, 200);
    const html = await root.text();
    assert.match(html, /Welcome/);
  });

test('startFixtureServer rewrites fixture.example in XML', async (t) => {
  const s = await startFixtureServer();
  t.after(async () => s.close());

  const res = await fetch(`${s.origin}/sitemap.xml`);
  const xml = await res.text();
  assert.ok(xml.includes(s.origin));
  assert.ok(!xml.includes('https://fixture.example'));
});

test('startFixtureServer returns 404 for missing files', async (t) => {
  const s = await startFixtureServer();
  t.after(async () => s.close());

  const res = await fetch(`${s.origin}/missing.html`);
  assert.equal(res.status, 404);
});

test(
  'a path that escapes the fixture directory is refused',
  async (t) => {
    const s = await startFixtureServer();
    t.after(() => s.close());
    const res = await fetch(
      s.origin + '/..%2F..%2Fpackage.json'
    );
    assert.equal(res.status, 404);
    const raw = await fetch(
      s.origin + '/%2e%2e/%2e%2e/package.json'
    );
    assert.equal(raw.status, 404);
  },
);
