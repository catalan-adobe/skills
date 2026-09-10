import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderStub, scaffold, STUB_MARKER } from './scaffold-block.mjs';
import { resolvePaths } from './paths.mjs';

const execFileP = promisify(execFile);
const scaffoldCli = fileURLToPath(
  new URL('./scaffold-block.mjs', import.meta.url),
);

const block = {
  name: 'specifications',
  status: 'scaffold',
  templates: { product: 1 },
  evidence: [],
  model: {
    rows: 'repeat',
    columns: [
      { name: 'label', type: 'text' },
      { name: 'value', type: 'text' },
    ],
    header: false,
  },
};

test('renderStub emits structural JS and brand-free CSS with marker', () => {
  const { js, css } = renderStub(block);
  assert.ok(
    js.startsWith(`/* ${STUB_MARKER}`),
    'JS should start with STUB marker',
  );
  assert.ok(
    css.startsWith(`/* ${STUB_MARKER}`),
    'CSS should start with STUB marker',
  );
  assert.match(js, /export default function decorate\(block\)/);
  assert.match(js, /const columns = \["label","value"\]/);
  assert.match(js, /classList\.add\('specifications-row'\)/);
  assert.match(
    css,
    /\.specifications > div \{\s*display: grid;\s*grid-template-columns: repeat\(2, 1fr\)/,
  );
  assert.ok(!/#[0-9a-f]{3,6}|var\(--/i.test(css), 'no brand tokens');
});

test('scaffold writes stubs and refuses to overwrite a real block', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'ecp-scaffold-'));
  const first = await scaffold([block], repo);
  assert.deepEqual(first.written, [
    'blocks/specifications/specifications.js',
    'blocks/specifications/specifications.css',
  ]);
  await writeFile(
    path.join(repo, 'blocks/specifications/specifications.js'),
    'export default function decorate() {}',
  );
  const second = await scaffold([block], repo);
  assert.equal(second.written.length, 0);
  assert.match(second.skipped[0].reason, /not a stub/);
  const forced = await scaffold([block], repo, { force: true });
  assert.equal(forced.written.length, 2);
});

test('CLI --template exits 0 and writes blocks', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'ecp-cli-'));
  const repoRoot = path.dirname(repo);
  const projectDir = repo;
  const dataDir = repo;
  await mkdir(path.join(projectDir, 'migration'), { recursive: true });
  await writeFile(
    path.join(projectDir, 'migration', 'site.config.json'),
    '{}',
  );
  const paths = resolvePaths(
    { MIGRATION_PROJECT_DIR: projectDir, MIGRATION_DATA_DIR: dataDir },
  );
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    paths.stateFile('blocks'),
    JSON.stringify([block]),
  );
  const env = {
    ...process.env,
    MIGRATION_PROJECT_DIR: projectDir,
    MIGRATION_DATA_DIR: dataDir,
  };
  const { stdout, stderr } = await execFileP(
    process.execPath,
    [scaffoldCli, '--template', 'product'],
    { env, cwd: projectDir },
  );
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.equal(result.written.length, 2);
  assert.match(result.written[0], /specifications\.js$/);
  const jsPath = path.join(repoRoot, result.written[0]);
  const jsContent = await readFile(jsPath, 'utf8');
  assert.ok(jsContent.includes(STUB_MARKER));
});

test('CLI no flags exits non-zero with Usage error', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'ecp-cli-'));
  await mkdir(path.join(repo, 'migration'), { recursive: true });
  await writeFile(
    path.join(repo, 'migration', 'site.config.json'),
    '{}',
  );
  const env = {
    ...process.env,
    MIGRATION_PROJECT_DIR: repo,
    MIGRATION_DATA_DIR: repo,
  };
  await assert.rejects(
    () => execFileP(process.execPath, [scaffoldCli], { env, cwd: repo }),
    /Usage/,
  );
});

test(
  'CLI --name nope exits 1 with unknown block error',
  async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'ecp-cli-'));
    await mkdir(path.join(repo, 'migration'), { recursive: true });
    await writeFile(
      path.join(repo, 'migration', 'site.config.json'),
      '{}',
    );
    const dataDir = repo;
    const paths = resolvePaths(
      { MIGRATION_PROJECT_DIR: repo, MIGRATION_DATA_DIR: dataDir },
    );
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      paths.stateFile('blocks'),
      JSON.stringify([block]),
    );
    const env = {
      ...process.env,
      MIGRATION_PROJECT_DIR: repo,
      MIGRATION_DATA_DIR: dataDir,
    };
    const promise = execFileP(
      process.execPath,
      [scaffoldCli, '--name', 'nope'],
      { env, cwd: repo },
    );
    await assert.rejects(
      promise,
      (err) => {
        assert.equal(err.code, 1, 'exit code should be 1');
        assert.match(
          err.stderr,
          /Unknown block "nope"/,
          'stderr should contain unknown block error',
        );
        return true;
      },
    );
  },
);

test(
  'CLI --template no-such-template exits 0 with empty result',
  async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'ecp-cli-'));
    await mkdir(path.join(repo, 'migration'), { recursive: true });
    await writeFile(
      path.join(repo, 'migration', 'site.config.json'),
      '{}',
    );
    const dataDir = repo;
    const paths = resolvePaths(
      { MIGRATION_PROJECT_DIR: repo, MIGRATION_DATA_DIR: dataDir },
    );
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      paths.stateFile('blocks'),
      JSON.stringify([block]),
    );
    const env = {
      ...process.env,
      MIGRATION_PROJECT_DIR: repo,
      MIGRATION_DATA_DIR: dataDir,
    };
    const { stdout } = await execFileP(
      process.execPath,
      [scaffoldCli, '--template', 'no-such-template'],
      { env, cwd: repo },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.written.length, 0);
    assert.deepEqual(result.skipped, []);
  },
);

test(
  'renderStub header: true includes header class in JS and CSS',
  () => {
    const headerBlock = {
      ...block,
      model: { ...block.model, header: true },
    };
    const { js, css } = renderStub(headerBlock);
    assert.match(
      js,
      /row\.classList\.add\('specifications-header'\)/,
    );
    assert.match(
      css,
      /\.specifications-header \{ font-weight: 700; \}/,
    );
  },
);

test('renderStub without a header row emits no header branch or rule', () => {
  const { js, css } = renderStub(block);
  assert.ok(!js.includes('-header'), 'no dead header branch in the stub');
  assert.ok(!css.includes('-header'), 'no unused header rule');
});
