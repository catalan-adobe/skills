'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const SCRIPT = require.resolve(
  '../../skills/screencast/scripts/screencast.js'
);

let mod;
function load() {
  delete require.cache[SCRIPT];
  mod = require(SCRIPT);
}

// ─── Task 1: parseArgs ────────────────────────────────────────────────────────

describe('parseArgs', () => {
  afterEach(() => {
    delete require.cache[SCRIPT];
    mod = null;
  });

  it('parses subcommand with no flags', () => {
    load();
    const result = mod.parseArgs(['node', 'screencast.js', 'status']);
    assert.equal(result.command, 'status');
    assert.deepEqual(result.args, []);
  });

  it('uses defaults when no flags given', () => {
    load();
    const result = mod.parseArgs(['node', 'screencast.js', 'start']);
    assert.equal(result.fps, 30);
    assert.equal(result.screen, 0);
    assert.equal(result.region, null);
    assert.equal(result.window, null);
    assert.equal(result.output, null);
  });

  it('parses --fps flag', () => {
    load();
    const result = mod.parseArgs(['node', 'screencast.js', 'start', '--fps', '60']);
    assert.equal(result.fps, 60);
  });

  it('parses --screen flag', () => {
    load();
    const result = mod.parseArgs(['node', 'screencast.js', 'start', '--screen', '1']);
    assert.equal(result.screen, 1);
  });

  it('parses --output flag', () => {
    load();
    const result = mod.parseArgs(['node', 'screencast.js', 'start', '--output', '/tmp/out.mp4']);
    assert.equal(result.output, '/tmp/out.mp4');
  });

  it('parses --window flag', () => {
    load();
    const result = mod.parseArgs(['node', 'screencast.js', 'start', '--window', 'Firefox']);
    assert.equal(result.window, 'Firefox');
  });

  it('parses --region flag as string', () => {
    load();
    const result = mod.parseArgs(['node', 'screencast.js', 'start', '--region', '10,20,640,480']);
    assert.equal(result.region, '10,20,640,480');
  });

  it('parses all start flags together', () => {
    load();
    const result = mod.parseArgs([
      'node', 'screencast.js', 'start',
      '--fps', '24',
      '--screen', '2',
      '--region', '0,0,1280,720',
      '--window', 'Chrome',
      '--output', '/tmp/demo.mp4',
    ]);
    assert.equal(result.command, 'start');
    assert.equal(result.fps, 24);
    assert.equal(result.screen, 2);
    assert.equal(result.region, '0,0,1280,720');
    assert.equal(result.window, 'Chrome');
    assert.equal(result.output, '/tmp/demo.mp4');
  });

  it('parses stop subcommand', () => {
    load();
    const result = mod.parseArgs(['node', 'screencast.js', 'stop']);
    assert.equal(result.command, 'stop');
    assert.deepEqual(result.args, []);
  });

  it('parses status subcommand', () => {
    load();
    const result = mod.parseArgs(['node', 'screencast.js', 'status']);
    assert.equal(result.command, 'status');
  });
});

// ─── Task 2: detectPlatform ───────────────────────────────────────────────────

describe('detectPlatform', () => {
  afterEach(() => {
    delete require.cache[SCRIPT];
    mod = null;
  });

  it('returns valid platform and backend', () => {
    load();
    const result = mod.detectPlatform();
    const validPlatforms = ['darwin', 'linux', 'win32'];
    const validBackends = ['avfoundation', 'x11grab', 'gdigrab'];
    assert.ok(validPlatforms.includes(result.platform),
      `platform "${result.platform}" should be one of ${validPlatforms.join(', ')}`);
    assert.ok(validBackends.includes(result.backend),
      `backend "${result.backend}" should be one of ${validBackends.join(', ')}`);
    assert.equal(typeof result.ffmpeg, 'boolean');
  });

  it('returns ffmpegVersion string when ffmpeg is present', () => {
    load();
    const result = mod.detectPlatform();
    if (result.ffmpeg) {
      assert.equal(typeof result.ffmpegVersion, 'string');
      assert.ok(result.ffmpegVersion.length > 0);
    }
  });

  it('backend matches current platform', () => {
    load();
    const result = mod.detectPlatform();
    const expected = {
      darwin: 'avfoundation',
      linux: 'x11grab',
      win32: 'gdigrab',
    }[result.platform];
    assert.equal(result.backend, expected);
  });
});
