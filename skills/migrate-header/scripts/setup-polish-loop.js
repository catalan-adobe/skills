#!/usr/bin/env node

/**
 * Reads extraction JSON + templates and writes populated loop
 * infrastructure into a target directory (the worktree where the
 * header migration is happening).
 *
 * Usage:
 *   node setup-polish-loop.js \
 *     --layout=path/to/layout.json \
 *     --styles=path/to/styles.json \
 *     --source-dir=path/to/source/ \
 *     --target-dir=path/to/worktree/ \
 *     --port=3000 \
 *     --max-iterations=30
 */

import {
  copyFileSync, existsSync, mkdirSync,
  readFileSync, writeFileSync, chmodSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', 'templates');

function parseArgs(argv) {
  const named = {};
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([a-z-]+)=(.+)$/);
    if (m) named[m[1]] = m[2];
  }

  const required = ['layout', 'source-dir', 'target-dir'];
  const missing = required.filter((k) => !named[k]);
  if (missing.length > 0) {
    console.error(
      `Missing required arguments: ${missing.map((k) => `--${k}`).join(', ')}`
    );
    console.error(
      'Usage: node setup-polish-loop.js'
      + ' --layout=<path> --styles=<path>'
      + ' --source-dir=<path> --target-dir=<path>'
      + ' [--port=3000] [--max-iterations=30]'
    );
    process.exit(1);
  }

  return {
    layoutPath: resolve(named['layout']),
    stylesPath: named['styles'] ? resolve(named['styles']) : null,
    sourceDir: resolve(named['source-dir']),
    targetDir: resolve(named['target-dir']),
    explicitPort: named['port'] || null,
    maxIterations: named['max-iterations'] || '30',
    skillHome: named['skill-home'] || '',
  };
}

function loadJSON(path, label) {
  if (!existsSync(path)) {
    console.error(`${label} not found: ${path}`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    console.error(`Failed to parse ${label}: ${err.message}`);
    process.exit(1);
  }
}

function loadTemplate(name) {
  const path = join(TEMPLATES_DIR, name);
  if (!existsSync(path)) {
    console.error(`Template not found: ${path}`);
    process.exit(1);
  }
  return readFileSync(path, 'utf-8');
}

function buildHeaderDescription(layout, styles) {
  const rows = styles?.rows || [];
  const lines = [];

  for (let i = 0; i < layout.rows.length; i++) {
    const row = layout.rows[i];
    const heightStr = `~${Math.round(row.height)}px`;
    const elements = row.elements.join(', ') || 'unknown';
    const bgColor = rows[i]?.['background-color']?.value;
    const bgStr = bgColor ? `, ${bgColor} background` : '';
    lines.push(
      `${lines.length + 1}. **${row.role}** (${heightStr}): `
      + `${elements}${bgStr}`
    );
  }

  return lines.join('\n');
}

function countNavItems(layout) {
  const primary = layout.navItems?.primary?.length || 0;
  const secondary = layout.navItems?.secondary?.length || 0;
  return primary + secondary;
}

function buildNavStructure(layout) {
  const primary = layout.navItems?.primary || [];
  const secondary = layout.navItems?.secondary || [];
  const topNav = [...primary, ...secondary].map((item) => ({
    text: typeof item === 'string' ? item : item.text,
    href: typeof item === 'string' ? '#' : (item.href || '#'),
  }));

  for (const entry of topNav) {
    if (typeof entry.text !== 'string') {
      throw new Error(
        `nav-structure: expected .text to be a string, got ${typeof entry.text}`
        + ` — check layout.json navItems format`
      );
    }
  }

  return { topNav };
}

function buildIconGuidance(targetDir) {
  const manifestPath = join(
    targetDir, 'autoresearch', 'extraction', 'icons', 'icons.json'
  );
  if (!existsSync(manifestPath)) {
    return 'No pre-extracted icons available. Create icons as needed using inline SVGs or CSS.';
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  if (!manifest.icons || manifest.icons.length === 0) {
    return 'No pre-extracted icons available. Create icons as needed using inline SVGs or CSS.';
  }

  const iconList = manifest.icons
    .map((i) => `- \`:${i.name}:\` (${i.class}) — ${i.context}`)
    .join('\n');

  return `Pre-extracted SVG icons are in \`/icons/\`. These are referenced via
\`:iconname:\` notation in nav.plain.html and rendered by decorateIcons().
Do NOT recreate these as inline SVGs or CSS. Adjust size via CSS
\`width\`/\`height\` on \`.icon-{name} img\`, color is inherited via
the SVG's currentColor fill.

Available icons:
${iconList}`;
}

function copySourceFile(sourceDir, targetDir, filename) {
  const src = join(sourceDir, filename);
  if (!existsSync(src)) {
    console.error(`  WARNING: source file not found: ${src}`);
    return;
  }
  copyFileSync(src, join(targetDir, filename));
}

function isLinkedWorktree(dir) {
  try {
    const gitDir = execSync('git rev-parse --git-dir', {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // Linked worktrees have .git files pointing to main repo's
    // .git/worktrees/<name>, so --git-dir returns an absolute path
    // containing "/worktrees/". The main working tree returns ".git".
    return gitDir !== '.git' && gitDir.includes('/worktrees/');
  } catch {
    return false;
  }
}

function detectPort(targetDir, explicitPort) {
  if (explicitPort) return explicitPort;
  if (isLinkedWorktree(targetDir)) {
    log('  Detected git worktree — using port 3050 (AEM CLI worktree default)');
    return '3050';
  }
  return '3000';
}

function log(msg) {
  console.error(msg);
}

function main() {
  const args = parseArgs(process.argv);

  // Load extraction data
  const layout = loadJSON(args.layoutPath, 'layout.json');
  const styles = args.stylesPath
    ? loadJSON(args.stylesPath, 'styles.json')
    : {};

  // Load snapshot.json to get URL
  const snapshotPath = join(args.sourceDir, 'snapshot.json');
  const snapshot = loadJSON(snapshotPath, 'snapshot.json');
  const sourceUrl = snapshot.url;
  if (!sourceUrl) {
    console.error('snapshot.json is missing the "url" field');
    process.exit(1);
  }

  // Build template values
  const headerDescription = buildHeaderDescription(layout, styles);
  const navItemCount = countNavItems(layout);
  const headerHeight = Math.round(layout.headerHeight || 0);
  const port = detectPort(args.targetDir, args.explicitPort);

  const replacements = {
    '{{PORT}}': port,
    '{{PAGE_PATH}}': '/',
    '{{MAX_ITERATIONS}}': args.maxIterations,
    '{{MAX_CONSECUTIVE_REVERTS}}': '5',
    '{{HEADER_FILES}}': 'blocks/header/ nav.plain.html',
    '{{HEADER_DESCRIPTION}}': headerDescription,
    '{{HEADER_HEIGHT}}': String(headerHeight),
    '{{NAV_ITEM_COUNT}}': String(navItemCount),
    '{{URL}}': sourceUrl,
    '{{ICON_GUIDANCE}}': buildIconGuidance(args.targetDir),
    '{{SKILL_HOME}}': args.skillHome,
  };

  // Load templates
  const evaluateTmpl = loadTemplate('evaluate.js.tmpl');
  const loopTmpl = loadTemplate('loop.sh.tmpl');
  const programTmpl = loadTemplate('program.md.tmpl');

  // Apply replacements
  function applyReplacements(template) {
    let result = template;
    for (const [key, value] of Object.entries(replacements)) {
      while (result.includes(key)) {
        result = result.replace(key, value);
      }
    }
    return result;
  }

  const evaluateContent = applyReplacements(evaluateTmpl);
  const loopContent = applyReplacements(loopTmpl);
  const programContent = applyReplacements(programTmpl);

  // Create directory structure
  const autoresearchDir = join(args.targetDir, 'autoresearch');
  const sourceOutDir = join(autoresearchDir, 'source');
  const resultsDir = join(autoresearchDir, 'results');

  mkdirSync(sourceOutDir, { recursive: true });
  mkdirSync(resultsDir, { recursive: true });
  log(`Created ${autoresearchDir}/`);

  // Write populated templates
  writeFileSync(join(autoresearchDir, 'evaluate.js'), evaluateContent);
  log('  Wrote autoresearch/evaluate.js');

  const loopPath = join(args.targetDir, 'loop.sh');
  writeFileSync(loopPath, loopContent);
  chmodSync(loopPath, 0o755);
  log('  Wrote loop.sh (chmod +x)');

  writeFileSync(join(args.targetDir, 'program.md'), programContent);
  log('  Wrote program.md');

  // Copy source screenshots
  for (const file of ['desktop.png']) {
    copySourceFile(args.sourceDir, sourceOutDir, file);
    log(`  Copied source/${file}`);
  }

  // Generate nav-structure.json
  const navStructure = buildNavStructure(layout);
  writeFileSync(
    join(sourceOutDir, 'nav-structure.json'),
    JSON.stringify(navStructure, null, 2)
  );
  log(`  Wrote source/nav-structure.json (${navStructure.topNav.length} items)`);

  // Install npm dependencies for evaluator
  log('Installing evaluator dependencies...');
  execSync('npm init -y', {
    cwd: autoresearchDir,
    stdio: 'pipe',
  });
  // Set type: module for ESM imports in evaluate.js
  const pkgPath = join(autoresearchDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkg.type = 'module';
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  execSync('npm install pixelmatch pngjs', {
    cwd: autoresearchDir,
    stdio: 'pipe',
  });
  log('  Installed pixelmatch + pngjs');

  log('');
  log('Polish loop infrastructure ready.');
  log(`  Target: ${args.targetDir}`);
  log(`  Source URL: ${sourceUrl}`);
  log(`  Header: ${headerHeight}px, ${layout.rows.length} rows, ${navItemCount} nav items`);
  log(`  Run: cd ${args.targetDir} && ./loop.sh`);
}

main();
