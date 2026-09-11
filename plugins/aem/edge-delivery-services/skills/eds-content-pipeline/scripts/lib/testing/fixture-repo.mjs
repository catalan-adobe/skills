import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from '../paths.mjs';
import { upsertRecords } from '../state.mjs';
import { startFixtureServer } from '../../fixtures/example-site/serve.mjs';

const fixture = fileURLToPath(new URL('../../fixtures/example-site/', import.meta.url));

/**
 * Builds a temp EDS repo seeded exactly like the fixture site, without cluster: `urls.json`
 * assigns the four fixture URLs directly to templates `product`/`page` via `upsertRecords`, and
 * the hand-authored `migration/` artefacts (transformers, templates, blocks.json) are copied in.
 */
export async function fixtureRepo() {
  const server = await startFixtureServer();
  const repo = await mkdtemp(path.join(os.tmpdir(), 'ecp-stage-'));
  await mkdir(path.join(repo, 'scripts'), { recursive: true });
  await writeFile(path.join(repo, 'scripts/aem.js'), '');
  await writeFile(path.join(repo, 'head.html'), '');
  await mkdir(path.join(repo, 'migration'), { recursive: true });
  const transformersDir = path.join(repo, 'migration/transformers');
  await cp(path.join(fixture, 'migration/transformers'), transformersDir, { recursive: true });
  await cp(path.join(fixture, 'migration/templates'), path.join(repo, 'migration/templates'), {
    recursive: true,
  });
  await mkdir(path.join(repo, 'migration/data'), { recursive: true });
  const blocksSrc = path.join(fixture, 'migration/data/blocks.json');
  await cp(blocksSrc, path.join(repo, 'migration/data/blocks.json'));
  const cfg = JSON.parse(await readFile(path.join(fixture, 'migration/site.config.json'), 'utf8'));
  cfg.origin = server.origin;
  cfg.sitemapIndex = `${server.origin}/sitemap.xml`;
  await writeFile(path.join(repo, 'migration/site.config.json'), JSON.stringify(cfg, null, 2));
  const paths = resolvePaths({ MIGRATION_PROJECT_DIR: path.join(repo, 'migration') }, repo);
  await upsertRecords('urls', [
    {
      url: `${server.origin}/`, path: '/', sitemapType: 'page', template: 'page', status: 'todo',
    },
    {
      url: `${server.origin}/about.html`,
      path: '/about.html',
      sitemapType: 'page',
      template: 'page',
      status: 'todo',
    },
    {
      url: `${server.origin}/product-a.html`,
      path: '/product-a.html',
      sitemapType: 'page',
      template: 'product',
      status: 'todo',
    },
    {
      url: `${server.origin}/product-b.html`,
      path: '/product-b.html',
      sitemapType: 'page',
      template: 'product',
      status: 'todo',
    },
  ], paths);
  await upsertRecords('templates', [
    { name: 'product', status: 'todo' },
    { name: 'page', status: 'todo' },
  ], paths);
  return { repo, server, paths };
}

