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

      // Hand-authored template artefacts stand in for the analysis stage
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
        sourceUrlPattern: '^/product-[a-z]+\\.html$',
      };
      await writeFile(
        cfgPath,
        JSON.stringify(cfg, null, 2),
      );

      // Step 2: inventory
      const inv = await run(repo, 'inventory.mjs', '--no-probe');
      assert.equal(inv.total, 4, 'should find 4 URLs');
      assert.deepEqual(inv.sitemaps.failed, []);

      // Step 2b: the overlay recipe the prep unit would write (hand-authored for the fixture)
      await cp(
        path.join(fixture, 'migration/page-prep.json'),
        path.join(repo, 'migration/page-prep.json'),
      );

      // Step 3: cluster
      const clu = await run(
        repo,
        'cluster.mjs',
        '--no-shots',
        '--concurrency', '1',
      );
      assert.equal(clu.errors, 0, 'every URL fingerprinted');
      assert.equal(clu.failed, 0, 'no URL left without a fingerprint');
      assert.ok(clu.finalized, 'cluster finalizes when nothing remains');
      assert.equal(clu.templates, 2, 'products cluster apart from index/about');
      const aboutTree = JSON.parse(await readFile(
        path.join(repo, 'migration/data/visual-trees/about.json'), 'utf8',
      ));
      assert.ok(
        !JSON.stringify(aboutTree).toLowerCase().includes('cookie'),
        'the recipe removed the cookie banner before the tree was captured',
      );
      assert.deepEqual(aboutTree.data.children.map((c) => c.tag), ['HEADER', 'MAIN', 'FOOTER']);
      // Templates get generic names (`<seed>-N`); the analyst names them in the template
      // stage. Stand in for that step: find the cluster holding the product pages, check it
      // holds exactly those, and rename it `product` so the hand-authored artefacts apply.
      const { listRecords, upsertRecords } = await import('#lib/state.mjs');
      const paths = resolvePaths(
        { ...process.env, MIGRATION_PROJECT_DIR: path.join(repo, 'migration') },
        repo,
      );
      const allUrls = await listRecords('urls', { paths });
      const isProduct = (u) => /\/product-[a-z]+\.html$/.test(u.url);
      const clusterName = allUrls.find(isProduct).template;
      assert.ok(clusterName, 'product pages were assigned a template');
      assert.deepEqual(
        allUrls.filter((u) => u.template === clusterName).map((u) => u.path).sort(),
        ['/product-a.html', '/product-b.html'],
        'the product cluster holds exactly the product pages',
      );
      await upsertRecords(
        'urls',
        allUrls.filter((u) => u.template === clusterName)
          .map((u) => ({ url: u.url, template: 'product' })),
        paths,
      );
      const templates = await listRecords('templates', { paths });
      const productTemplate = templates.find((t) => t.name === clusterName);
      assert.equal(productTemplate.urlCount, 2);
      // Find and rename the page template (root + about)
      const isPage = (u) => !isProduct(u) &&
        (u.path === '/' || u.path === '/about.html');
      const pageClusterName = allUrls.find(isPage).template;
      assert.ok(pageClusterName, 'root and about were assigned a template');
      assert.deepEqual(
        allUrls.filter((u) => u.template === pageClusterName)
          .map((u) => u.path).sort(),
        ['/', '/about.html'],
        'the page cluster holds exactly root and about',
      );
      await upsertRecords(
        'urls',
        allUrls.filter((u) => u.template === pageClusterName)
          .map((u) => ({ url: u.url, template: 'page' })),
        paths,
      );

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
        // analysis.md "Not migrated": the breadcrumb trail is navigation, not content.
        '--ignore', 'nav.breadcrumbs',
        '--blocks',
        path.join(repo, 'migration/data/blocks.json'),
        '--template', 'product',
      );
      assert.equal(fid.recall, 1, `every source token survived: ${JSON.stringify(fid)}`);
      assert.equal(fid.precision, 1, `nothing invented: ${JSON.stringify(fid)}`);
      assert.equal(
        fid.pass,
        true,
        `fidelity should pass: ${JSON.stringify(fid)}`,
      );

      // Step 7: run the bulk stage for product, no LLM and no DA available.
      const bulkProduct = await run(
        repo,
        'stage.mjs',
        'run', 'bulk', 'template=product', '--skip-llm',
      );
      assert.deepEqual(bulkProduct.units.map((u) => [u.id, u.verdict]), [
        ['dry-run', 'done'], ['run', 'skipped-no-da'], ['sample-fidelity', 'skipped-no-da'],
        ['retro', 'skipped'],
      ]);
      const dry = JSON.parse(await readFile(
        path.join(repo, 'migration/data/bulk/product-dryrun.json'), 'utf8',
      ));
      assert.equal(dry.coverage, 1, 'coverage should be 100%');
      assert.equal(
        dry.longTail.length,
        0,
        'long tail should be empty',
      );

      // Step 8: transform page (about.html)
      const outAbout = path.join(repo, 'migration/data/out-about.html');
      await run(repo, 'transform.mjs', `${server.origin}/about.html`,
        '--template', 'page', '--out', outAbout);

      // Step 9: fidelity for page
      const srcAbout = path.join(
        repo,
        'migration/data/src-about.html',
      );
      const srcAboutHtml = await (
        await fetch(`${server.origin}/about.html`)
      ).text();
      await writeFile(srcAbout, srcAboutHtml);
      const fidAbout = await run(
        repo,
        'fidelity.mjs',
        srcAbout,
        outAbout,
        '--source-root', '#maincontent',
      );
      assert.equal(
        fidAbout.recall,
        1,
        JSON.stringify(fidAbout),
      );
      assert.equal(
        fidAbout.precision,
        1,
        JSON.stringify(fidAbout),
      );

      // Step 10: run the bulk stage for page, no LLM and no DA available.
      const bulkPage = await run(
        repo,
        'stage.mjs',
        'run', 'bulk', 'template=page', '--skip-llm',
      );
      assert.deepEqual(bulkPage.units.map((u) => [u.id, u.verdict]), [
        ['dry-run', 'done'], ['run', 'skipped-no-da'], ['sample-fidelity', 'skipped-no-da'],
        ['retro', 'skipped'],
      ]);
      const dryPage = JSON.parse(await readFile(
        path.join(repo, 'migration/data/bulk/page-dryrun.json'), 'utf8',
      ));
      assert.equal(dryPage.total, 2);
      assert.equal(dryPage.coverage, 1);

      // Captures and reports written by bulk
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
