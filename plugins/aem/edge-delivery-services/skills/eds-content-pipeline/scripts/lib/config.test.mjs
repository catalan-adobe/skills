import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, originAliasHosts } from './config.mjs';

async function tmpConfig(obj) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'migration-config-'));
  const file = path.join(dir, 'site.config.json');
  await writeFile(file, JSON.stringify(obj));
  return file;
}

test('loads config with expected structure', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ecp-test-'));
  const file = path.join(dir, 'site.config.json');
  const cfg_obj = {
    origin: 'https://www.example.com',
    sitemapIndex: 'https://www.example.com/sitemap.xml',
    exclusions: {},
    overlaySelectors: [],
    viewports: [1440],
    concurrency: { fetch: 2, browser: 3 },
    rateLimit: { perSecond: 2 },
    thresholds: {},
    bundles: { pageTree: 'x.js' },
    templateSeeds: { post: 'blog-post' },
    da: {
      org: 'o',
      site: 's',
      ref: 'main',
      adminHost: 'a',
      sourceHost: 'b',
    },
    templates: {},
  };
  await writeFile(file, JSON.stringify(cfg_obj));
  const cfg = await loadConfig(file);
  assert.equal(cfg.origin, 'https://www.example.com');
  assert.equal(cfg.templateSeeds.post, 'blog-post');
  assert.equal(cfg.concurrency.browser, 3);
});

test('rejects a configuration with missing keys and names them', async () => {
  const file = await tmpConfig({ origin: 'https://x.test' });
  await assert.rejects(
    () => loadConfig(file),
    /missing keys: sitemapIndex, exclusions/,
  );
});

const validBase = {
  origin: 'https://x.test',
  sitemapIndex: 'https://x.test/sitemap.xml',
  exclusions: {},
  overlaySelectors: [],
  viewports: {},
  concurrency: {},
  rateLimit: {},
  thresholds: {},
  bundles: { pageTree: 'x.js' },
  templateSeeds: {},
  da: {
    org: 'o',
    site: 's',
    ref: 'r',
    adminHost: 'https://admin.hlx.page',
    sourceHost: 'https://admin.da.live',
  },
  templates: {
    'case-study': {
      sourceRoot: '#contentCntr',
      needsBrowser: false,
      sourceUrlPattern: '^/case-study/[^/]+/$',
    },
  },
};

test('da field is present and validated in config', async () => {
  const file = await tmpConfig(validBase);
  const cfg = await loadConfig(file);
  assert.ok(cfg.da, 'da object must be present in site.config.json');
  assert.equal(cfg.da.org, 'o');
  assert.equal(cfg.da.site, 's');
  assert.equal(cfg.da.ref, 'r');
  assert.equal(cfg.da.adminHost, 'https://admin.hlx.page');
  assert.equal(cfg.da.sourceHost, 'https://admin.da.live');
});

test('rejects config when da.sourceHost is missing', async () => {
  const file = await tmpConfig({
    ...validBase,
    da: {
      org: 'o', site: 's', ref: 'r', adminHost: 'https://admin.hlx.page',
    },
  });
  await assert.rejects(() => loadConfig(file), /da missing: sourceHost/);
});

test('templates.case-study validates url pattern correctly', async () => {
  const caseStudy = {
    sourceRoot: '#contentCntr',
    needsBrowser: false,
    sourceUrlPattern: '^/case-study/[^/]+/$',
  };
  assert.equal(caseStudy.sourceRoot, '#contentCntr');
  assert.equal(caseStudy.needsBrowser, false);
  assert.match(
    '/case-study/example-corp/',
    new RegExp(caseStudy.sourceUrlPattern),
  );
});

test('every template entry has required keys', async () => {
  const templates = {
    homepage: {
      sourceRoot: '#contentCntr',
      needsBrowser: false,
      sourceUrlPattern: '^/$',
    },
    'case-study': {
      sourceRoot: '#contentCntr',
      needsBrowser: false,
      sourceUrlPattern: '^/case-study/[^/]+/$',
    },
  };
  for (const [name, entry] of Object.entries(templates)) {
    assert.equal(
      typeof entry.sourceRoot,
      'string',
      `${name}.sourceRoot`,
    );
    assert.equal(
      typeof entry.needsBrowser,
      'boolean',
      `${name}.needsBrowser`,
    );
    assert.doesNotThrow(
      () => new RegExp(entry.sourceUrlPattern),
      `${name}.sourceUrlPattern`,
    );
  }
});

test('templates.integration url pattern validation', async () => {
  const entry = {
    sourceRoot: '#contentCntr',
    needsBrowser: false,
    sourceUrlPattern: '^/integrations/[^/]+/$',
  };
  const pattern = new RegExp(entry.sourceUrlPattern);
  assert.match('/integrations/example-slack/', pattern);
  assert.doesNotMatch('/integrations/', pattern);
  assert.doesNotMatch('/integrations/example-slack/extra/', pattern);
});

test('templates.template-detail url pattern validation', async () => {
  const detail = {
    sourceRoot: '#contentCntr',
    needsBrowser: false,
    sourceUrlPattern: '^/templates/[^/]+/$',
  };
  const pattern = new RegExp(detail.sourceUrlPattern);
  assert.match('/templates/example-mgmt/', pattern);
  assert.doesNotMatch('/templates/', pattern);
  assert.doesNotMatch('/template/use-case/workflow/', pattern);
});

test('templates.page matches multiple path patterns correctly', async () => {
  const entry = {
    sourceRoot: '#contentCntr, .elementor[data-elementor-type="wp-page"]',
    needsBrowser: false,
    sourceUrlPattern: '(^/health/|^/compare/)',
  };
  const pattern = new RegExp(entry.sourceUrlPattern);
  assert.match('/health/telehealth/', pattern);
  assert.match('/compare/example-vs-base-comparison/', pattern);
  assert.doesNotMatch('/pricing/', pattern);
});

test('rejects config when a template entry is missing required fields', async () => {
  const file = await tmpConfig({
    ...validBase,
    templates: { 'case-study': { sourceRoot: '#contentCntr' } },
  });
  await assert.rejects(
    () => loadConfig(file),
    /templates\.case-study missing: needsBrowser, sourceUrlPattern/,
  );
});

test('rejects config when a template entry has a non-boolean needsBrowser', async () => {
  const file = await tmpConfig({
    ...validBase,
    templates: {
      'case-study': {
        sourceRoot: '#contentCntr',
        needsBrowser: 'no',
        sourceUrlPattern: '^/x/$',
      },
    },
  });
  await assert.rejects(
    () => loadConfig(file),
    /templates\.case-study\.needsBrowser must be boolean/,
  );
});

test('rejects config when thresholds.scorecard is not an object', async () => {
  const file = await tmpConfig({
    ...validBase,
    thresholds: { scorecard: ['nope'] },
  });
  await assert.rejects(
    () => loadConfig(file),
    /thresholds\.scorecard must be an object/,
  );
});

test('scorecard.gateLayers and gateLayersNote are optional', async () => {
  const scorecard = {
    gateLayers: ['L3'],
    gateLayersNote: 'see site-rules.md',
  };
  assert.deepEqual(scorecard.gateLayers, ['L3']);
  assert.match(scorecard.gateLayersNote, /site-rules\.md/);
});

test('rejects thresholds.scorecard.gateLayers with an unknown layer', async () => {
  const file = await tmpConfig({
    ...validBase,
    thresholds: { scorecard: { gateLayers: ['L1', 'L4'] } },
  });
  await assert.rejects(
    () => loadConfig(file),
    /thresholds\.scorecard\.gateLayers must only contain "L1", "L2" or "L3"/,
  );
});

test('rejects thresholds.scorecard.gateLayers when empty/not array', async () => {
  const file = await tmpConfig({
    ...validBase,
    thresholds: { scorecard: { gateLayers: [] } },
  });
  await assert.rejects(
    () => loadConfig(file),
    /thresholds\.scorecard\.gateLayers must be a non-empty array/,
  );
  const file2 = await tmpConfig({
    ...validBase,
    thresholds: { scorecard: { gateLayers: 'L3' } },
  });
  await assert.rejects(
    () => loadConfig(file2),
    /thresholds\.scorecard\.gateLayers must be a non-empty array/,
  );
});

test('rejects thresholds.scorecard.gateLayersNote when it is not a string', async () => {
  const file = await tmpConfig({
    ...validBase,
    thresholds: { scorecard: { gateLayers: ['L3'], gateLayersNote: 42 } },
  });
  await assert.rejects(
    () => loadConfig(file),
    /thresholds\.scorecard\.gateLayersNote must be a string/,
  );
});

test('scorecard.accept entries have required fields', async () => {
  const accept = [
    {
      check: 'h2.font-size',
      note: 'see site-rules.md',
      viewports: [375, 768],
      templates: ['case-study'],
    },
  ];
  for (const one of accept) {
    assert.match(
      one.note,
      /site-rules\.md/,
      `${one.check}: every waiver points at its rationale`,
    );
    assert.ok(
      Array.isArray(one.templates) && one.templates.length > 0,
      `${one.check}: templates`,
    );
  }
});

const accepting = (accept) => ({
  ...validBase,
  thresholds: { scorecard: { accept } },
});

/**
 * Asserts that an `accept` list is rejected with the message the operator
 * has to act on.
 */
async function rejectsAccept(accept, pattern) {
  const file = await tmpConfig(accepting(accept));
  await assert.rejects(() => loadConfig(file), pattern);
}

test('rejects thresholds.scorecard.accept when not an array', async () => {
  await rejectsAccept(
    { check: 'h2.font-size' },
    /thresholds\.scorecard\.accept must be an array/,
  );
  await rejectsAccept(
    ['h2.font-size'],
    /thresholds\.scorecard\.accept\[0\]\.check must be a non-empty string/,
  );
});

test('rejects an accept entry without a check name or a note', async () => {
  await rejectsAccept(
    [{ note: 'why' }],
    /thresholds\.scorecard\.accept\[0\]\.check must be a non-empty string/,
  );
  await rejectsAccept(
    [{ check: 'links' }],
    /thresholds\.scorecard\.accept\[0\]\.note must be a non-empty string/,
  );
});

test('rejects accept entry with malformed viewports or templates', async () => {
  const entry = { check: 'links', note: 'why' };
  await rejectsAccept(
    [{ ...entry, viewports: ['375'] }],
    /thresholds\.scorecard\.accept\[0\]\.viewports must be an array of numbers/,
  );
  await rejectsAccept(
    [{ ...entry, templates: [] }],
    /thresholds\.scorecard\.accept\[0\]\.templates must be a non-empty array/,
  );
});

test('accepts an accept entry naming neither viewports nor templates', async () => {
  const cfg = await loadConfig(
    await tmpConfig(accepting([{ check: 'links', note: 'why' }])),
  );
  assert.equal(cfg.thresholds.scorecard.accept.length, 1);
});

const base = {
  origin: 'https://www.example.com',
  sitemapIndex: 'https://www.example.com/sitemap.xml',
  exclusions: {},
  overlaySelectors: [],
  viewports: [1440],
  concurrency: { fetch: 2 },
  rateLimit: { perSecond: 2 },
  thresholds: {},
  bundles: { pageTree: 'x.js' },
  templateSeeds: {},
  da: {
    org: 'o', site: 's', ref: 'main',
    adminHost: 'a', sourceHost: 'b',
  },
  templates: {},
};

test('brand is no longer required and thresholds get defaults', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ecp-config-'));
  const file = path.join(dir, 'site.config.json');
  await writeFile(file, JSON.stringify(base));
  const config = await loadConfig(file);
  assert.equal(config.thresholds.coverage, 0.95);
  assert.deepEqual(
    config.thresholds.fidelity,
    { recall: 0.9, precision: 0.95 },
  );
  assert.equal(config.thresholds.newTemplateMin, 5);
  assert.deepEqual(config.include, []);
  assert.deepEqual(config.originAliases, ['https://www.example.com']);
});

test('bundles must contain only pageTree', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ecp-config-'));
  const file = path.join(dir, 'site.config.json');
  await writeFile(file, JSON.stringify({ ...base, bundles: { pageReduce: 'x' } }));
  await assert.rejects(loadConfig(file), /bundles\.pageTree/);
});

test('originAliasHosts strips scheme and www', () => {
  const hosts = originAliasHosts({
    originAliases: [
      'https://www.example.com',
      'http://example.com',
      'https://shop.example.com',
    ],
  });
  assert.deepEqual(
    hosts,
    ['example.com', 'example.com', 'shop.example.com'],
  );
});
