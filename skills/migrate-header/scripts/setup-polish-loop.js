#!/usr/bin/env node

/**
 * Reads row-*.json extraction files + templates and writes populated
 * loop infrastructure into a target directory (the worktree where the
 * header migration is happening).
 *
 * Usage:
 *   node setup-polish-loop.js \
 *     --rows-dir=path/to/rows/ \
 *     --url=https://example.com \
 *     --source-dir=path/to/source/ \
 *     --target-dir=path/to/worktree/ \
 *     --port=3000 \
 *     --max-iterations=30
 */

import {
  copyFileSync, existsSync, mkdirSync, readdirSync,
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

  const required = ['rows-dir', 'url', 'source-dir', 'target-dir'];
  const missing = required.filter((k) => !named[k]);
  if (missing.length > 0) {
    console.error(
      `Missing required arguments: ${missing.map((k) => `--${k}`).join(', ')}`,
    );
    console.error(
      'Usage: node setup-polish-loop.js'
      + ' --rows-dir=<path> --url=<url>'
      + ' --source-dir=<path> --target-dir=<path>'
      + ' [--port=3000] [--max-iterations=30]',
    );
    process.exit(1);
  }

  return {
    rowsDir: resolve(named['rows-dir']),
    url: named['url'],
    sourceDir: resolve(named['source-dir']),
    targetDir: resolve(named['target-dir']),
    explicitPort: named['port'] || null,
    maxIterations: named['max-iterations'] || '30',
    skillHome: named['skill-home'] || join(__dirname, '..'),
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

export function loadRowFiles(rowsDir) {
  const files = readdirSync(rowsDir)
    .filter((f) => /^row-\d+\.json$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)[0], 10);
      const numB = parseInt(b.match(/\d+/)[0], 10);
      return numA - numB;
    });

  return files.map((f) =>
    JSON.parse(readFileSync(join(rowsDir, f), 'utf-8')),
  );
}

function loadTemplate(name) {
  const path = join(TEMPLATES_DIR, name);
  if (!existsSync(path)) {
    console.error(`Template not found: ${path}`);
    process.exit(1);
  }
  return readFileSync(path, 'utf-8');
}

export function buildHeaderDescription(rows) {
  const lines = [];

  for (const row of rows) {
    const heightStr = `~${Math.round(row.bounds.height)}px`;
    const elements = row.elements.map((e) => e.role).join(', ') || 'unknown';
    const bg = row.rowStyles?.['background-color'];
    const isTransparent = !bg
      || bg === 'transparent'
      || bg === 'rgba(0, 0, 0, 0)';
    const bgStr = isTransparent ? '' : `, ${bg} background`;
    lines.push(
      `${lines.length + 1}. **${row.suggestedSectionStyle}** (${heightStr}): `
      + `${elements}${bgStr}`,
    );
  }

  return lines.join('\n');
}

export function countNavItems(rows) {
  return rows.reduce((count, row) => {
    const links = row.elements.filter(
      (e) => e.role === 'nav-link' || e.role === 'utility-link',
    );
    return count + links.length;
  }, 0);
}

export function buildNavStructure(rows) {
  const topNav = [];
  for (const row of rows) {
    for (const el of row.elements) {
      if (el.role !== 'nav-link' && el.role !== 'utility-link') continue;
      const text = el.content.text;
      if (typeof text !== 'string') {
        throw new Error(
          `nav-structure: expected .content.text to be a string, got `
          + `${typeof text} — check row-${row.index}.json element format`,
        );
      }
      topNav.push({ text, href: el.content.href || '#' });
    }
  }
  return { topNav };
}

export function synthesizeStyles(rows) {
  const styles = {
    header: {},
    rows: [],
    navLinks: {},
    navSpacing: { value: '2rem' },
    cta: null,
  };

  const totalHeight = rows.reduce(
    (max, r) => Math.max(max, (r.bounds?.y || 0) + (r.bounds?.height || 0)),
    0,
  );

  if (rows.length > 0) {
    const first = rows[0];
    styles.header = {
      'background-color': {
        value: first.rowStyles?.['background-color'] || 'transparent',
      },
      height: { value: `${totalHeight}px` },
      padding: { value: first.rowStyles?.padding || '0' },
      'font-family': {
        value: first.rowStyles?.['font-family'] || 'inherit',
      },
    };
  }

  for (const row of rows) {
    styles.rows.push({
      'background-color': {
        value: row.rowStyles?.['background-color'] || 'transparent',
      },
    });
  }

  for (const row of rows) {
    const navLink = row.elements.find((e) => e.role === 'nav-link');
    if (navLink?.styles) {
      styles.navLinks = Object.fromEntries(
        Object.entries(navLink.styles).map(
          ([k, v]) => [k, { value: v }],
        ),
      );
      break;
    }
  }

  for (const row of rows) {
    const cta = row.elements.find((e) => e.role === 'cta');
    if (cta?.styles) {
      styles.cta = Object.fromEntries(
        Object.entries(cta.styles).map(
          ([k, v]) => [k, { value: v }],
        ),
      );
      break;
    }
  }

  return styles;
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

  // Load row extraction data
  const rows = loadRowFiles(args.rowsDir);
  if (rows.length === 0) {
    console.error(`No row-*.json files found in: ${args.rowsDir}`);
    process.exit(1);
  }
  log(`Loaded ${rows.length} row files from ${args.rowsDir}`);

  const sourceUrl = args.url;

  // Build template values
  const headerDescription = buildHeaderDescription(rows);
  const navItemCount = countNavItems(rows);
  const headerHeight = Math.round(
    rows.reduce(
      (max, r) => Math.max(max, (r.bounds?.y || 0) + (r.bounds?.height || 0)),
      0,
    ),
  );
  const port = detectPort(args.targetDir, args.explicitPort);

  // Synthesize styles.json for the judge templates
  const styles = synthesizeStyles(rows);
  const stylesOutPath = join(
    args.targetDir, 'autoresearch', 'extraction', 'styles.json',
  );
  mkdirSync(dirname(stylesOutPath), { recursive: true });
  writeFileSync(stylesOutPath, JSON.stringify(styles, null, 2));
  log('  Wrote synthesized styles.json for judge reference');

  // Read visual-tree text format if available
  const vtPath = join(args.sourceDir, 'visual-tree.txt');
  let visualTreeText = 'Visual tree not available for this migration.';
  if (existsSync(vtPath)) {
    visualTreeText = readFileSync(vtPath, 'utf-8');
    log(`  Loaded visual-tree.txt (${visualTreeText.split('\n').length} lines)`);
  }

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
    '{{VISUAL_TREE}}': visualTreeText,
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
  const navStructure = buildNavStructure(rows);
  writeFileSync(
    join(sourceOutDir, 'nav-structure.json'),
    JSON.stringify(navStructure, null, 2),
  );
  log(`  Wrote source/nav-structure.json (${navStructure.topNav.length} items)`);

  // Install npm dependencies for evaluator
  log('Installing evaluator dependencies...');
  execSync('npm init -y', {
    cwd: autoresearchDir,
    stdio: 'pipe',
  });
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
  log(`  Header: ${headerHeight}px, ${rows.length} rows, ${navItemCount} nav items`);
  log(`  Run: cd ${args.targetDir} && ./loop.sh`);
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
