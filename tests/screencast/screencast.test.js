'use strict';

const { describe, it, afterEach, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

// ─── Task 6: State helpers ────────────────────────────────────────────────────

const TEST_STATE = path.join(os.tmpdir(), `screencast-test-${process.pid}.state`);

describe('state helpers', () => {
  afterEach(() => {
    // Clean up test state file between tests
    try { fs.unlinkSync(TEST_STATE); } catch { /* already gone */ }
    delete require.cache[SCRIPT];
    mod = null;
  });

  it('writeState/readState roundtrip', () => {
    load();
    const data = { pid: 12345, output: '/tmp/test.mp4', started: 1000, target: 'screen:0' };
    mod.writeState(data, TEST_STATE);
    const got = mod.readState(TEST_STATE);
    assert.deepEqual(got, data);
  });

  it('readState returns null when file does not exist', () => {
    load();
    const result = mod.readState(TEST_STATE);
    assert.equal(result, null);
  });

  it('clearState removes the file', () => {
    load();
    mod.writeState({ pid: 1 }, TEST_STATE);
    assert.ok(fs.existsSync(TEST_STATE), 'file should exist after writeState');
    mod.clearState(TEST_STATE);
    assert.ok(!fs.existsSync(TEST_STATE), 'file should be gone after clearState');
  });

  it('clearState is idempotent when file does not exist', () => {
    load();
    // Should not throw
    assert.doesNotThrow(() => mod.clearState(TEST_STATE));
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

// ─── Task 3: buildFfmpegArgs ──────────────────────────────────────────────────

describe('buildFfmpegArgs', () => {
  afterEach(() => {
    delete require.cache[SCRIPT];
    mod = null;
  });

  it('macOS full-screen uses avfoundation', () => {
    load();
    const args = mod.buildFfmpegArgs({
      backend: 'avfoundation',
      screenInput: '1',
      fps: 30,
      region: null,
      output: '/tmp/out.mp4',
      screenSize: '1920x1080',
      display: ':0.0',
    });
    assert.ok(args.includes('-f'), 'should include -f flag');
    assert.ok(args.includes('avfoundation'), 'should use avfoundation backend');
    assert.ok(args.includes('-framerate'), 'should include -framerate flag');
    assert.ok(args.includes('30'), 'should use fps 30');
    assert.ok(args.includes('-capture_cursor'), 'should capture cursor');
    assert.ok(args.includes('/tmp/out.mp4'), 'should include output path');
  });

  it('macOS with region adds crop filter', () => {
    load();
    const args = mod.buildFfmpegArgs({
      backend: 'avfoundation',
      screenInput: '1',
      fps: 30,
      region: '10,20,640,480',
      output: '/tmp/out.mp4',
      screenSize: '1920x1080',
      display: ':0.0',
    });
    const argsStr = args.join(' ');
    assert.ok(argsStr.includes('crop'), 'should include crop filter for region');
    assert.ok(argsStr.includes('640'), 'crop filter should include width');
    assert.ok(argsStr.includes('480'), 'crop filter should include height');
  });

  it('Linux full-screen uses x11grab with screen size', () => {
    load();
    const args = mod.buildFfmpegArgs({
      backend: 'x11grab',
      screenInput: null,
      fps: 30,
      region: null,
      output: '/tmp/out.mp4',
      screenSize: '1920x1080',
      display: ':0.0',
    });
    assert.ok(args.includes('x11grab'), 'should use x11grab backend');
    assert.ok(args.includes('-video_size'), 'should include -video_size for x11grab');
    assert.ok(args.includes('1920x1080'), 'should use screen size');
    assert.ok(args.includes(':0.0'), 'should use display');
  });

  it('Linux with region uses native offset in x11grab', () => {
    load();
    const args = mod.buildFfmpegArgs({
      backend: 'x11grab',
      screenInput: null,
      fps: 30,
      region: '10,20,640,480',
      output: '/tmp/out.mp4',
      screenSize: '1920x1080',
      display: ':0.0',
    });
    const argsStr = args.join(' ');
    assert.ok(args.includes('x11grab'), 'should use x11grab backend');
    assert.ok(argsStr.includes('640x480'), 'region size should be in video_size');
    assert.ok(argsStr.includes(':0.0+10,20'), 'display input should include offset');
  });

  it('Windows full-screen uses gdigrab', () => {
    load();
    const args = mod.buildFfmpegArgs({
      backend: 'gdigrab',
      screenInput: null,
      fps: 30,
      region: null,
      output: '/tmp/out.mp4',
      screenSize: '1920x1080',
      display: null,
    });
    assert.ok(args.includes('gdigrab'), 'should use gdigrab backend');
    assert.ok(args.includes('desktop'), 'should use desktop input for gdigrab');
  });

  it('Windows with region adds offset and video_size', () => {
    load();
    const args = mod.buildFfmpegArgs({
      backend: 'gdigrab',
      screenInput: null,
      fps: 30,
      region: '10,20,640,480',
      output: '/tmp/out.mp4',
      screenSize: '1920x1080',
      display: null,
    });
    const argsStr = args.join(' ');
    assert.ok(args.includes('gdigrab'), 'should use gdigrab backend');
    assert.ok(argsStr.includes('-offset_x'), 'should include -offset_x for region');
    assert.ok(argsStr.includes('-offset_y'), 'should include -offset_y for region');
    assert.ok(argsStr.includes('640x480'), 'should include video_size for region');
  });

  it('common output settings are always present', () => {
    load();
    const args = mod.buildFfmpegArgs({
      backend: 'avfoundation',
      screenInput: '1',
      fps: 30,
      region: null,
      output: '/tmp/out.mp4',
      screenSize: '1920x1080',
      display: ':0.0',
    });
    assert.ok(args.includes('-y'), 'should have -y (overwrite)');
    assert.ok(args.includes('-c:v'), 'should have -c:v');
    assert.ok(args.includes('libx264'), 'should use libx264');
    assert.ok(args.includes('-pix_fmt'), 'should have -pix_fmt');
    assert.ok(args.includes('yuv420p'), 'should use yuv420p');
    assert.ok(args.includes('-preset'), 'should have -preset');
    assert.ok(args.includes('ultrafast'), 'should use ultrafast preset');
    assert.ok(args.includes('-crf'), 'should have -crf');
    assert.ok(args.includes('23'), 'should use crf 23');
  });
});

// ─── Task: compilePicker ─────────────────────────────────────────────────────

describe('compilePicker', () => {
  const CACHE_DIR = path.join(os.tmpdir(), `screencast-picker-test-${process.pid}`);
  const FAKE_SOURCE = path.join(os.tmpdir(), `screencast-picker-test-${process.pid}.swift`);

  before(() => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(FAKE_SOURCE, '// fake swift source\n');
  });

  afterEach(() => {
    delete require.cache[SCRIPT];
    mod = null;
  });

  it('returns error when not on macOS', () => {
    load();
    if (os.platform() !== 'darwin') {
      assert.throws(() => mod.compilePicker(FAKE_SOURCE, CACHE_DIR), /macOS/);
    }
  });

  it('throws when source file does not exist', function () {
    if (os.platform() !== 'darwin') { this.skip(); return; }
    load();
    assert.throws(
      () => mod.compilePicker('/tmp/nonexistent-picker.swift', CACHE_DIR),
      /ENOENT|not found|No such file/
    );
  });

  it('returns binary path after compilation on macOS', function () {
    if (os.platform() !== 'darwin') { this.skip(); return; }
    load();
    const result = mod.compilePicker(
      path.resolve(__dirname, '../../skills/screencast/scripts/screencast-picker.swift'),
      CACHE_DIR
    );
    assert.ok(result.endsWith('screencast-picker'), `expected binary path, got: ${result}`);
    assert.ok(fs.existsSync(result), 'binary should exist after compilation');
  });

  it('skips recompilation when binary is newer than source', function () {
    if (os.platform() !== 'darwin') { this.skip(); return; }
    load();
    // First compile
    const binaryPath = mod.compilePicker(
      path.resolve(__dirname, '../../skills/screencast/scripts/screencast-picker.swift'),
      CACHE_DIR
    );
    const stat1 = fs.statSync(binaryPath);
    // Second compile (should skip)
    const binaryPath2 = mod.compilePicker(
      path.resolve(__dirname, '../../skills/screencast/scripts/screencast-picker.swift'),
      CACHE_DIR
    );
    const stat2 = fs.statSync(binaryPath2);
    assert.equal(stat1.mtimeMs, stat2.mtimeMs, 'binary mtime should not change');
  });
});
