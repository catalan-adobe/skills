// The capture's page-side rules on real renders: small pages distilled from sites where a
// rule was missing, served on loopback, read through playwright-cli as the capture reads
// them — the FREEZE css applied, the band dump evaluated, a full-page screenshot taken.
// Skips when playwright-cli is not on PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DUMP } from './band-dump.mjs';
import { FREEZE } from './cache.mjs';

const execFileP = promisify(execFile);
const SESSION = `capture-fixtures-${process.pid}`;

const PAGES = {
  // aig.com: a navy header bar fixed at the top, kept as the site's header in the dump.
  'fixed-header': `<body style="margin:0">
    <div id="bar" style="position:fixed;top:0;left:0;right:0;height:100px;
      background:rgb(0,24,113);color:#fff">Logo <a href="#">Claims</a></div>
    <main style="padding-top:100px"><h1>Insurance</h1><p>${'Text. '.repeat(80)}</p>
    <div style="height:1500px"></div></main></body>`,
  // moosemountainvineyards.com: a parallax banner; gehealthcare.com: a slider's track
  // overflowing the page across.
  'parallax-overflow': `<body style="margin:0">
    <section id="banner" style="height:500px;background:rgb(200,90,40) fixed">
      <h2 style="margin:0;color:#fff">Steep slopes</h2></section>
    <div id="slider" style="width:1280px"><div style="width:20000px;height:300px;
      background:rgb(10,120,200)">Slide</div></div>
    <p>${'More text. '.repeat(50)}</p></body>`,
};

async function serve() {
  const server = createServer((req, res) => {
    const name = new URL(req.url, 'http://x').pathname.slice(1);
    const html = PAGES[name];
    res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html ? `<!doctype html><html><head></head>${html}</html>` : 'not found');
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const onPath = (cmd) => execFileP('which', [cmd]).then(({ stdout }) => stdout.trim(), () => null);
const result = (stdout) => {
  let value = JSON.parse((/### Result\s*\n([\s\S]*?)\n### Ran/.exec(stdout)?.[1] ?? stdout).trim());
  if (typeof value === 'string') value = JSON.parse(value);
  return value;
};
// A PNG's width and height, from its IHDR chunk.
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

test('capture fixtures', async (t) => {
  const cli = await onPath('playwright-cli');
  if (!cli) { t.skip('playwright-cli not on PATH'); return; }
  const site = await serve();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'capture-fixtures-'));
  const config = path.join(cwd, 'config.json');
  await writeFile(config, JSON.stringify({ browser: { browserName: 'chromium' },
    network: { allowedOrigins: [site.origin] } }));
  const run = (...args) => execFileP(cli, [`-s=${SESSION}`, ...args], { cwd, maxBuffer: 1 << 24 });
  const load = async (name) => {
    await run('goto', `${site.origin}/${name}`);
    await run('eval', `(() => { const s = document.createElement('style');
      s.textContent = ${JSON.stringify(FREEZE)}; document.head.append(s); return 1; })()`);
  };
  await run('open', '--config', config, `${site.origin}/fixed-header`);
  await run('resize', '1280', '900');
  try {
    await t.test('a fixed header bar kept in the dump keeps its own background', async () => {
      await load('fixed-header');
      const dump = result((await run('eval', DUMP)).stdout);
      const bar = dump.bgs.find((b) => b.y === 0 && b.h === 100);
      assert.equal(bar?.bg, 'color:rgb(0, 24, 113)', JSON.stringify(dump.bgs));
      assert.ok(dump.leaves.some((l) => l.t === 'Claims'), 'its content is read');
    });
    await t.test('a fixed background scrolls; what overflows across is clipped', async () => {
      await load('parallax-overflow');
      const attachment = result((await run('eval',
        'JSON.stringify(getComputedStyle(document.querySelector("#banner")).backgroundAttachment)'))
        .stdout);
      assert.equal(attachment, 'scroll');
      const shot = path.join(cwd, 'shot.png');
      await run('screenshot', '--full-page', '--filename', shot);
      assert.equal(pngSize(await readFile(shot)).width, 1280, 'the page\'s own width');
    });
  } finally {
    await run('close').catch(() => {});
    site.close();
  }
});
