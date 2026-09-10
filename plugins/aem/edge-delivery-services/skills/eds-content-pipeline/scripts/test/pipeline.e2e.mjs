import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cp, mkdir, mkdtemp, readFile, writeFile, rm,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from '#lib/paths.mjs';
import { startFixtureServer } from '../fixtures/example-site/serve.mjs';

const execFileP = promisify(execFile);
const lib = fileURLToPath(new URL('../lib/', import.meta.url));
const fixture = fileURLToPath(
  new URL('../fixtures/example-site/', import.meta.url),
);
const PT_BUNDLE = process.env.PAGE_TREE_BUNDLE;

async function run(cwd, script, ...args) {
  const cmd = path.join(lib, script);
  const { stdout, stderr } = await execFileP('node', [cmd, ...args], {
    cwd,
    env: { ...process.env },
  });
  const lines = stdout.trim().split('\n');
  let jsonStart = lines.length - 1;
  while (jsonStart >= 0 && !lines[jsonStart].match(/^\{|^\[/)) {
    jsonStart--;
  }
  const jsonStr = lines.slice(jsonStart).join('\n');
  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error(`Failed parsing JSON from ${script}`);
    console.error(`stdout:\n${stdout}`);
    console.error(`stderr:\n${stderr}`);
    throw err;
  }
}

test(
  'init → inventory → cluster → scaffold → transform → fidelity → bulk --dry-run',
  { skip: !PT_BUNDLE && 'set PAGE_TREE_BUNDLE' },
  async () => {
    const server = await startFixtureServer();
    const repo = await mkdtemp(
      path.join(os.tmpdir(), 'ecp-e2e-'),
    );

    try {
      // Setup repo structure
      await mkdir(path.join(repo, 'scripts'), { recursive: true });
      await writeFile(
        path.join(repo, 'scripts', 'aem.js'),
        '',
      );
      await writeFile(
        path.join(repo, 'head.html'),
        '',
      );
      await mkdir(
        path.join(
          repo,
          '.agents/skills/page-tree/scripts',
        ),
        { recursive: true },
      );
      await cp(
        PT_BUNDLE,
        path.join(
          repo,
          '.agents/skills/page-tree/scripts/page-tree-bundle.js',
        ),
      );

      // Step 1: init
      const init = await run(
        repo,
        'init.mjs',
        '--origin', server.origin,
        '--sitemap', `${server.origin}/sitemap.xml`,
        '--da-org', 'example',
        '--da-site', 'fixture',
        '--skip-checks',
      );
      assert.ok(
        init.created.includes('migration/site.config.json'),
        'init should create site.config.json',
      );

      // Hand-authored template artefacts (Plan B substitute)
      await cp(
        path.join(fixture, 'migration/transformers'),
        path.join(repo, 'migration/transformers'),
        { recursive: true },
      );
      await cp(
        path.join(fixture, 'migration/templates'),
        path.join(repo, 'migration/templates'),
        { recursive: true },
      );
      await cp(
        path.join(fixture, 'migration/data/blocks.json'),
        path.join(repo, 'migration/data/blocks.json'),
      );

      // Customize config for test
      const cfgPath = path.join(repo, 'migration/site.config.json');
      const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
      cfg.thresholds.minClusterSize = 2;
      cfg.templates.product = {
        sourceRoot: '#maincontent',
        needsBrowser: false,
        sourceUrlPattern: '^/product-[a-z]+\\.html$',
      };
      await writeFile(
        cfgPath,
        JSON.stringify(cfg, null, 2),
      );

      // Step 2: inventory
      const inv = await run(repo, 'inventory.mjs', '--no-probe');
      assert.equal(inv.total, 4, 'should find 4 URLs');

      // Step 3: cluster
      const clu = await run(
        repo,
        'cluster.mjs',
        '--no-shots',
        '--concurrency', '1',
      );
      assert.ok(
        clu.remaining === 0,
        'cluster should fingerprint all URLs',
      );
      assert.ok(
        clu.finalized,
        'cluster should finalize when remaining = 0',
      );
      // The fixture pre-defines a "product" template that matches specific URLs.
      // For testing, we re-assign product URLs to that template manually
      // (in production, Plan B's analyst would match URLs to templates).
      const { upsertRecords, listRecords } = await import(
        '#lib/state.mjs'
      );
      const paths = resolvePaths(
        { ...process.env, MIGRATION_PROJECT_DIR: path.join(repo, 'migration') },
        repo,
      );
      const allUrls = await listRecords('urls', { paths });
      const productUrls = allUrls.filter(
        (u) => /\/product-[a-z]+\.html$/.test(u.url),
      );
      if (productUrls.length) {
        await upsertRecords(
          'urls',
          productUrls.map((u) => ({
            url: u.url,
            template: 'product',
          })),
          paths,
        );
      }

      // Step 4: scaffold-block
      const scaffold = await run(
        repo,
        'scaffold-block.mjs',
        '--template', 'product',
      );
      assert.equal(
        scaffold.written.length,
        2,
        'should scaffold 2 files (js, css)',
      );

      // Step 5: transform
      const outPath = path.join(
        repo,
        'migration/data/out-a.html',
      );
      const transformRes = await run(
        repo,
        'transform.mjs',
        `${server.origin}/product-a.html`,
        '--template', 'product',
        '--out', outPath,
      );
      assert.ok(
        transformRes.path,
        'transform should return path',
      );
      assert.ok(
        transformRes.transformerVersion,
        'transform should include transformerVersion',
      );

      // Step 6: fidelity
      const srcPath = path.join(
        repo,
        'migration/data/src-a.html',
      );
      const srcHtml = await (
        await fetch(`${server.origin}/product-a.html`)
      ).text();
      await writeFile(srcPath, srcHtml);

      const fid = await run(
        repo,
        'fidelity.mjs',
        srcPath,
        outPath,
        '--source-root', '#maincontent',
        '--blocks',
        path.join(repo, 'migration/data/blocks.json'),
        '--min-recall', '0.75',
        '--min-precision', '0.75',
      );
      assert.equal(
        fid.pass,
        true,
        `fidelity should pass: ${JSON.stringify(fid)}`,
      );

      // Step 7: bulk --dry-run
      const dry = await run(
        repo,
        'bulk.mjs',
        '--template', 'product',
        '--dry-run',
      );
      assert.equal(dry.coverage, 1, 'coverage should be 100%');
      assert.equal(
        dry.longTail.length,
        0,
        'long tail should be empty',
      );

      // Ruling 3: check capture and report paths
      const captureFile = path.join(
        repo,
        'migration/data/captures/product/product-a.html',
      );
      const captureExists = await readFile(
        captureFile,
        'utf8',
      ).catch(() => null);

      assert.ok(
        captureExists,
        `capture should exist at ${captureFile}`,
      );

      const reportPath = path.join(
        repo,
        'migration/reports/bulk-product-longtail.md',
      );
      assert.ok(
        await readFile(reportPath, 'utf8').catch(() => null),
        `report should exist at ${reportPath}`,
      );
    } finally {
      await server.close();
      await rm(repo, { recursive: true, force: true });
    }
  },
);
