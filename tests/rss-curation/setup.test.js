import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SETUP_MOD = path.resolve(
  import.meta.dirname,
  '../../skills/rss-curation/scripts/setup.mjs',
);

const REFS = path.resolve(
  import.meta.dirname,
  '../../skills/rss-curation/references',
);

describe('setup', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-setup-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initDataDir creates directory structure with config and profile', async () => {
    const { initDataDir } = await import(`${SETUP_MOD}?t=${Date.now()}`);
    const dataDir = path.join(tmpDir, 'rss');
    const result = initDataDir(
      dataDir,
      path.join(REFS, 'default-config.yaml'),
      path.join(REFS, 'default-profile.yaml'),
    );

    assert.ok(fs.existsSync(result.configPath));
    assert.ok(fs.existsSync(result.profilePath));
    assert.ok(fs.existsSync(result.dbPath));
    assert.ok(fs.existsSync(path.join(dataDir, 'digests')));
  });

  it('generateLaunchdPlist returns valid plist XML', async () => {
    const { generateLaunchdPlist } = await import(
      `${SETUP_MOD}?t=${Date.now()}`
    );
    const plist = generateLaunchdPlist(
      '/path/to/rss-feed.mjs',
      '/path/to/config.yaml',
      '/path/to/feeds.db',
      '0 7 * * *',
    );

    assert.ok(plist.includes('<!DOCTYPE plist'));
    assert.ok(plist.includes('rss-feed.mjs'));
    assert.ok(plist.includes('<key>Hour</key>'));
    assert.ok(plist.includes('<integer>7</integer>'));
  });
});
