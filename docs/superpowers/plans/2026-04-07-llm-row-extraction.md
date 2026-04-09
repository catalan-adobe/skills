# LLM Row Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace migrate-header's script-based content extraction with parallel LLM row agents that extract content and styles per visual header row.

**Architecture:** Phase 2 gains row identification + screenshot capture (steps 2.4–2.6). Phase 3 becomes parallel LLM row agents (one per visual row) producing `row-N.json` files. Phase 4 scaffold and Phase 5 polish loop consume row files instead of `layout.json` + `styles.json`. Four extraction scripts (~1200 lines) are deleted.

**Tech Stack:** Node.js 22 (ESM), vitest, playwright-cli, pngjs

**Design spec:** `docs/2026-04-07-llm-row-extraction-design.md`

---

### Task 1: Create test fixtures for row-*.json format

**Files:**
- Create: `tests/migrate-header/fixtures/row-0.json`
- Create: `tests/migrate-header/fixtures/row-1.json`

These fixtures match the schema defined in the design spec (section "Row agent output schema") and serve as test inputs for the setup-polish-loop.js refactor.

- [ ] **Step 1: Create fixtures directory**

Run: `mkdir -p tests/migrate-header/fixtures`

- [ ] **Step 2: Write row-0.json fixture**

Create `tests/migrate-header/fixtures/row-0.json`:

```json
{
  "index": 0,
  "description": "Top bar with logo and utility links",
  "bounds": { "y": 0, "height": 44 },
  "suggestedSectionStyle": "brand",
  "elements": [
    {
      "role": "logo",
      "position": "left",
      "content": {
        "tag": "a",
        "href": "/",
        "children": [
          {
            "tag": "img",
            "src": "/img/logo.png",
            "alt": "TestCorp logo"
          }
        ]
      },
      "styles": {
        "width": "108px",
        "padding": "0 0 0 1.25rem"
      }
    },
    {
      "role": "utility-link",
      "position": "right",
      "content": {
        "text": "Global Sites",
        "href": "/global"
      },
      "styles": {
        "font-size": "10px",
        "color": "rgb(60, 66, 66)",
        "letter-spacing": "0.8px"
      }
    },
    {
      "role": "utility-link",
      "position": "right",
      "content": {
        "text": "Contact",
        "href": "/contact"
      },
      "styles": {
        "font-size": "10px",
        "color": "rgb(60, 66, 66)",
        "letter-spacing": "0.8px"
      }
    }
  ],
  "rowStyles": {
    "background-color": "rgba(0, 0, 0, 0)",
    "height": "44px",
    "border-bottom": "1px solid #e0e0e0",
    "font-family": "\"Helvetica Neue\", Helvetica, Arial, sans-serif"
  }
}
```

- [ ] **Step 3: Write row-1.json fixture**

Create `tests/migrate-header/fixtures/row-1.json`:

```json
{
  "index": 1,
  "description": "Main navigation with 4 top-level links and submenus",
  "bounds": { "y": 44, "height": 50 },
  "suggestedSectionStyle": "main-nav",
  "elements": [
    {
      "role": "nav-link",
      "position": "left",
      "content": {
        "text": "Products",
        "href": "/products",
        "children": [
          { "text": "All Products", "href": "/products/all" },
          { "text": "New Arrivals", "href": "/products/new" }
        ]
      },
      "styles": {
        "font-size": "15px",
        "font-weight": "400",
        "color": "rgb(60, 66, 66)"
      }
    },
    {
      "role": "nav-link",
      "position": "left",
      "content": {
        "text": "Solutions",
        "href": "/solutions"
      },
      "styles": {
        "font-size": "15px",
        "font-weight": "400",
        "color": "rgb(60, 66, 66)"
      }
    },
    {
      "role": "nav-link",
      "position": "left",
      "content": {
        "text": "About",
        "href": "/about"
      },
      "styles": {
        "font-size": "15px",
        "font-weight": "400",
        "color": "rgb(60, 66, 66)"
      }
    },
    {
      "role": "nav-link",
      "position": "left",
      "content": {
        "text": "Careers",
        "href": "/careers"
      },
      "styles": {
        "font-size": "15px",
        "font-weight": "400",
        "color": "rgb(60, 66, 66)"
      }
    },
    {
      "role": "cta",
      "position": "right",
      "content": {
        "text": "Get Started",
        "href": "/signup"
      },
      "styles": {
        "background-color": "rgb(0, 120, 212)",
        "color": "rgb(255, 255, 255)",
        "border-radius": "4px",
        "font-size": "14px"
      }
    }
  ],
  "rowStyles": {
    "background-color": "rgb(255, 255, 255)",
    "height": "50px",
    "font-family": "\"Helvetica Neue\", Helvetica, Arial, sans-serif"
  }
}
```

- [ ] **Step 4: Commit fixtures**

```bash
git add tests/migrate-header/fixtures/
git commit -m "test(migrate-header): add row-*.json fixtures for setup-polish-loop"
```

---

### Task 2: Refactor setup-polish-loop.js to read row-*.json (TDD)

**Files:**
- Create: `tests/migrate-header/setup-polish-loop.test.js`
- Modify: `skills/migrate-header/scripts/setup-polish-loop.js`

The script currently reads `layout.json` + `styles.json` + `snapshot.json` to build
template variables. Refactor it to read `row-*.json` files and accept `--url` directly.

Key integration: the judge templates read `{{STYLES_JSON}}` for CSS reference
values. The refactored script synthesizes a `styles.json` from row data so the
judge templates (`judge.md.tmpl`, `judge-first.md.tmpl`) need no changes.

- [ ] **Step 1: Write failing tests**

Create `tests/migrate-header/setup-polish-loop.test.js`:

```javascript
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  loadRowFiles,
  buildHeaderDescription,
  countNavItems,
  buildNavStructure,
  synthesizeStyles,
} from '../../skills/migrate-header/scripts/setup-polish-loop.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

function loadFixtures() {
  return [
    JSON.parse(readFileSync(join(FIXTURES, 'row-0.json'), 'utf-8')),
    JSON.parse(readFileSync(join(FIXTURES, 'row-1.json'), 'utf-8')),
  ];
}

describe('loadRowFiles', () => {
  it('loads and sorts row files by index', () => {
    const rows = loadRowFiles(FIXTURES);
    expect(rows).toHaveLength(2);
    expect(rows[0].index).toBe(0);
    expect(rows[1].index).toBe(1);
  });

  it('ignores non-row files', () => {
    const rows = loadRowFiles(FIXTURES);
    expect(rows.every(r => typeof r.index === 'number')).toBe(true);
  });
});

describe('buildHeaderDescription', () => {
  it('builds description from row data', () => {
    const rows = loadFixtures();
    const desc = buildHeaderDescription(rows);
    expect(desc).toContain('brand');
    expect(desc).toContain('~44px');
    expect(desc).toContain('main-nav');
    expect(desc).toContain('~50px');
    expect(desc).toContain('logo');
    expect(desc).toContain('nav-link');
  });

  it('includes background color when present', () => {
    const rows = loadFixtures();
    const desc = buildHeaderDescription(rows);
    expect(desc).toContain('rgb(255, 255, 255) background');
  });

  it('omits background for transparent rows', () => {
    const rows = loadFixtures();
    const desc = buildHeaderDescription(rows);
    const line1 = desc.split('\n')[0];
    expect(line1).not.toContain('background');
  });
});

describe('countNavItems', () => {
  it('counts nav-link and utility-link elements', () => {
    const rows = loadFixtures();
    expect(countNavItems(rows)).toBe(6);
  });

  it('excludes non-nav roles', () => {
    const rows = loadFixtures();
    const total = rows.reduce((s, r) => s + r.elements.length, 0);
    expect(countNavItems(rows)).toBeLessThan(total);
  });
});

describe('buildNavStructure', () => {
  it('extracts nav and utility links', () => {
    const rows = loadFixtures();
    const nav = buildNavStructure(rows);
    expect(nav.topNav).toHaveLength(6);
    expect(nav.topNav[0]).toEqual({ text: 'Global Sites', href: '/global' });
    expect(nav.topNav[2]).toEqual({ text: 'Products', href: '/products' });
  });

  it('skips non-link elements', () => {
    const rows = loadFixtures();
    const nav = buildNavStructure(rows);
    const texts = nav.topNav.map(n => n.text);
    expect(texts).not.toContain('TestCorp logo');
    expect(texts).not.toContain('Get Started');
  });
});

describe('synthesizeStyles', () => {
  it('builds header-level styles from rows', () => {
    const rows = loadFixtures();
    const styles = synthesizeStyles(rows);
    expect(styles.header['background-color'].value).toBe('rgba(0, 0, 0, 0)');
    expect(styles.header.height.value).toBe('94px');
    expect(styles.header['font-family'].value).toContain('Helvetica Neue');
  });

  it('builds per-row background colors', () => {
    const rows = loadFixtures();
    const styles = synthesizeStyles(rows);
    expect(styles.rows).toHaveLength(2);
    expect(styles.rows[0]['background-color'].value).toBe('rgba(0, 0, 0, 0)');
    expect(styles.rows[1]['background-color'].value).toBe('rgb(255, 255, 255)');
  });

  it('extracts nav link styles from first nav-link element', () => {
    const rows = loadFixtures();
    const styles = synthesizeStyles(rows);
    expect(styles.navLinks['font-size'].value).toBe('15px');
    expect(styles.navLinks['font-weight'].value).toBe('400');
    expect(styles.navLinks.color.value).toBe('rgb(60, 66, 66)');
  });

  it('extracts CTA styles when present', () => {
    const rows = loadFixtures();
    const styles = synthesizeStyles(rows);
    expect(styles.cta['background-color'].value).toBe('rgb(0, 120, 212)');
    expect(styles.cta.color.value).toBe('rgb(255, 255, 255)');
    expect(styles.cta['border-radius'].value).toBe('4px');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/migrate-header/setup-polish-loop.test.js`

Expected: FAIL — `loadRowFiles` etc. are not exported from setup-polish-loop.js.

- [ ] **Step 3: Add readdirSync import and new exported functions**

In `skills/migrate-header/scripts/setup-polish-loop.js`, add `readdirSync` to the
`node:fs` import (line 3):

```javascript
import {
  copyFileSync, existsSync, mkdirSync, readdirSync,
  readFileSync, writeFileSync, chmodSync,
} from 'node:fs';
```

Then add these new functions after the existing `loadJSON` function (after line 73):

```javascript
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
```

- [ ] **Step 4: Rewrite buildHeaderDescription for row data**

Replace the existing `buildHeaderDescription` function (lines 84–101) with:

```javascript
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
```

- [ ] **Step 5: Rewrite countNavItems for row data**

Replace the existing `countNavItems` function (lines 103–107) with:

```javascript
export function countNavItems(rows) {
  return rows.reduce((count, row) => {
    const links = row.elements.filter(
      (e) => e.role === 'nav-link' || e.role === 'utility-link',
    );
    return count + links.length;
  }, 0);
}
```

- [ ] **Step 6: Rewrite buildNavStructure for row data**

Replace the existing `buildNavStructure` function (lines 109–127) with:

```javascript
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
```

- [ ] **Step 7: Add synthesizeStyles function**

Add after `buildNavStructure`:

```javascript
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
```

- [ ] **Step 8: Update parseArgs — replace --layout/--styles with --rows-dir/--url**

Replace the `parseArgs` function (lines 29–60) with:

```javascript
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
```

- [ ] **Step 9: Update main() to use row data**

Replace the `main` function (lines 194–326) with:

```javascript
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
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `npx vitest run tests/migrate-header/setup-polish-loop.test.js`

Expected: all 10 tests pass.

- [ ] **Step 11: Commit**

```bash
git add tests/migrate-header/setup-polish-loop.test.js \
  skills/migrate-header/scripts/setup-polish-loop.js
git commit -m "refactor(migrate-header): setup-polish-loop reads row-*.json instead of layout/styles"
```

---

### Task 3: Update scaffold-prompt.md for row-based generation

**Files:**
- Modify: `skills/migrate-header/references/scaffold-prompt.md`

The scaffold subagent reads extraction data to customize header.css and generate
nav.plain.html. Change it from layout.json + styles.json to row-*.json files.

- [ ] **Step 1: Replace Input Data section**

Replace the "Input Data" section (lines 8–19) with:

```markdown
## Input Data

Read these files:
- Row extractions: <PROJECT_ROOT>/autoresearch/extraction/row-*.json
  (one file per visual row — row-0.json is topmost, row-1.json below, etc.)
- Fonts (if exists): <PROJECT_ROOT>/autoresearch/extraction/fonts-detected.json

Each row-N.json contains classified elements with per-element CSS styles
queried from the source page via CDP. These are the source of truth for
all styling decisions. See the design spec for the full schema.

If fonts-detected.json exists, use its `fonts.heading.stack` and
`fonts.body.stack` values for `font-family` in header.css. These
are the actual rendered fonts detected from the source page, and
the corresponding font files are already installed in head.html.
```

- [ ] **Step 2: Replace Task 1 (CSS customization)**

Replace the "Task 1: Customize header.css" section (lines 38–56) with:

```markdown
## Task 1: Customize header.css

Open <PROJECT_ROOT>/blocks/header/header.css and update ONLY the CSS
custom properties block at the top (.header.block { ... }) to match the
source site's styles from the row extraction files.

**How to read styles from row files:**

Each row file has `rowStyles` (row-level CSS) and per-element `styles`.
Use element styles matching the role for each property:

- --header-background: from row-0.json rowStyles["background-color"]
- --header-nav-font-size: from the first nav-link element's styles["font-size"]
- --header-nav-font-weight: from the first nav-link element's styles["font-weight"]
- font-family: from the first nav-link element's styles["font-family"]
  (or rowStyles["font-family"] if not on the element)
- --header-text-color: from the first nav-link element's styles.color
- --header-section-padding: from row rowStyles padding (if present)
- For multi-row headers: each row's rowStyles["background-color"]
- For CTA buttons: from elements with role "cta" (background-color, color, border-radius)

**Important:** Use the font-size from nav-link elements for nav styling,
utility-link elements for utility styling. Do not mix them.

Do NOT modify the structural CSS (layout, dropdowns, etc.).
```

- [ ] **Step 3: Replace Task 2 (nav.plain.html generation)**

Replace the "Task 2: Generate nav.plain.html" section (lines 58–95) with:

```markdown
## Task 2: Generate nav.plain.html

Create <PROJECT_ROOT>/nav.plain.html following the content-mapping
guide patterns. Use the row extraction data:

**Key rule: one section per row file.** Each row-N.json represents one
visual row of the header. Generate exactly one nav.plain.html `<div>`
section per row file.

- Use `suggestedSectionStyle` from each row file for the section-metadata
  Style property
- Element roles tell you what each element is: logo, nav-link (with
  children for submenus), utility-link, cta, search, icon, text
- All elements are included regardless of role — do not filter any out.
  Promotional cards, featured links, etc. should appear in nav.plain.html
- Element `position` (left/right/center) guides layout within the section

### Logo Handling

Find the element with role "logo" in the row files. It will have content
with a tag, src, alt, and href.

1. Download the logo image to <PROJECT_ROOT>/images/logo.png (or
   matching extension). Use curl or fetch.
2. In nav.plain.html, use the local path:
   `<p><a href="<href>"><img src="./images/logo.png" alt="<alt>"></a></p>`

If no logo element exists, use text: `<p><a href="/">Company Name</a></p>`

### Nav links with submenus

Elements with role "nav-link" may have `content.children` — these are
submenu items (possibly from hidden dropdown panels). Render them as
nested `<ul>` structures per the content-mapping guide.

Each section needs a section-metadata block with Style property.
See content-mapping.md for exact HTML patterns per section type.
```

- [ ] **Step 4: Commit**

```bash
git add skills/migrate-header/references/scaffold-prompt.md
git commit -m "docs(migrate-header): update scaffold prompt for row-*.json input"
```

---

### Task 4: Update SKILL.md Phase 2 — add steps 2.4, 2.5, 2.6

**Files:**
- Modify: `skills/migrate-header/SKILL.md`

Phase 2 currently ends with step 2.3 (header detection + session close).
Move session close to new step 2.6, add row identification (2.4) and
screenshot capture (2.5) between header detection and session close.

- [ ] **Step 1: Remove session close from step 2.3**

In SKILL.md, find the "Close the visual-tree session" block at the end
of section 2.3 (lines 427–431):

```markdown
**Close the visual-tree session** (always, regardless of which path ran):

```bash
playwright-cli -s=visual-tree close 2>/dev/null || true
```
```

Remove these 4 lines. The session close moves to new step 2.6.

- [ ] **Step 2: Add steps 2.4, 2.5, 2.6 before "Mark Phase 2 as completed"**

Insert the following before the `Mark Phase 2 as completed.` line
(currently line 433):

```markdown
#### 2.4 Row Identification

Read the header subtree from `visual-tree.txt` and `visual-tree.json`
(produced in step 2.1). Identify direct child rows within the header
node identified in step 2.3.

**How to identify rows:**

Using the header's node ID from `header-detection.json`, find that
node in `visual-tree.txt`. Its direct children that are vertically
stacked (non-overlapping Y ranges) and have meaningful height (>15px)
are the visual rows.

For each row, extract from `visual-tree.json`'s nodeMap:
- `nodeId` — the row node's ID in the visual tree
- `selector` — CSS selector from `nodeMap[nodeId].selector`
- `bounds` — `{ y, height }` from the visual tree spatial data

Write a short description of each row's content based on what you see
in the visual tree text (e.g., "Top bar: logo left, utility links right").

Also extract the visual-tree text lines for each row node and its
children — this is the `vtSubtree` field that gives downstream row
agents context.

**Save to** `$PROJECT_ROOT/autoresearch/source/rows.json`:

```json
{
  "headerSelector": "<from header-detection.json>",
  "headerHeight": 94,
  "rows": [
    {
      "index": 0,
      "nodeId": "<visual tree node ID>",
      "selector": "<CSS selector from nodeMap>",
      "bounds": { "y": 0, "height": 44 },
      "vtSubtree": "<visual tree text for this node>",
      "description": "Top bar: logo left, utility links right"
    }
  ]
}
```

#### 2.5 Screenshot Capture

Before closing the visual-tree session, capture the header screenshot
for the evaluator and polish loop.

**Full viewport screenshot:**

```bash
playwright-cli -s=visual-tree resize 1440 900
sleep 1
playwright-cli -s=visual-tree screenshot \
  --filename=$PROJECT_ROOT/autoresearch/source/desktop-full.png
```

**Crop to header region** using bounds from `header-detection.json`.
Use pngjs from the skill's scripts/node_modules:

```bash
node --input-type=module -e "
  import { readFileSync, writeFileSync } from 'fs';
  import { createRequire } from 'module';
  const require = createRequire('$SKILL_HOME/scripts/package.json');
  const { PNG } = require('pngjs');

  const full = PNG.sync.read(readFileSync(
    '$PROJECT_ROOT/autoresearch/source/desktop-full.png'));
  const y = 0;
  const h = Math.min(${HEADER_HEIGHT}, full.height);
  const w = full.width;
  const cropped = new PNG({ width: w, height: h });
  PNG.bitblt(full, cropped, 0, y, w, h, 0, 0);
  writeFileSync(
    '$PROJECT_ROOT/autoresearch/source/desktop.png',
    PNG.sync.write(cropped));
  console.log('Cropped header: ' + w + 'x' + h);
"
```

Where `${HEADER_HEIGHT}` is the `headerHeight` from `rows.json`
(or `header-detection.json` bounds).

#### 2.6 Close Visual-Tree Session

```bash
playwright-cli -s=visual-tree close 2>/dev/null || true
```

Mark Phase 2 as completed.
```

- [ ] **Step 3: Commit**

```bash
git add skills/migrate-header/SKILL.md
git commit -m "feat(migrate-header): add row identification + screenshot to Phase 2"
```

---

### Task 5: Update SKILL.md Phase 3 — replace with row agents

**Files:**
- Modify: `skills/migrate-header/SKILL.md`

Replace the current Phase 3 content (steps 3.1, 3.1b, 3.2 for snapshot
capture, nav classification, layout/style extraction) with row agent
dispatch. Keep icon collection (3.3) and font detection (3.4) renumbered
as 3.2 and 3.3.

- [ ] **Step 1: Replace steps 3.1, 3.1b, 3.2 with row agent dispatch**

Find Phase 3 in SKILL.md (starts at `### Phase 3: Source Extraction`).
Replace everything from `#### 3.1 Snapshot Capture` through the end of
`#### 3.2 Layout & Style Extraction` (lines 439–538) with:

```markdown
#### 3.1 Row Agent Dispatch

Read `$PROJECT_ROOT/autoresearch/source/rows.json` (produced in step 2.4).
Dispatch one subagent per row **in parallel** using the Agent tool.

**Row agent prompt** (customize per row — replace bracketed values):

```
You are extracting content and styles from one row of a website header.

## Your Row

- **Row [INDEX]** of [TOTAL_ROWS]: [DESCRIPTION]
- **CSS selector:** [SELECTOR]
- **Visual tree context:**
[VT_SUBTREE]

## Tools

css-query.js for browser CSS queries:
```bash
node [CSS_QUERY_PATH] open [URL] --session=row-[INDEX] [BROWSER_RECIPE_FLAG]
node [CSS_QUERY_PATH] query "<selector>" "<properties>"
node [CSS_QUERY_PATH] close --session=row-[INDEX]
```

playwright-cli for DOM reads:
```bash
playwright-cli -s=row-[INDEX] eval "<expression>"
```

## Steps

1. Open a css-query session:
   ```bash
   node [CSS_QUERY_PATH] open [URL] --session=row-[INDEX] [BROWSER_RECIPE_FLAG]
   ```

2. Read the row's DOM content:
   ```bash
   playwright-cli -s=row-[INDEX] eval "document.querySelector('[SELECTOR]').innerHTML"
   ```

3. Analyze the DOM to classify elements. Assign each a role:
   logo, nav-link, utility-link, promotional-card, search, icon, cta, text.
   For nav-link elements, also extract children from nested <ul>s —
   including items in hidden submenus (display:none panels). These are
   real navigation links that belong in the output.

4. Query CSS values for each element type via css-query:
   ```bash
   node [CSS_QUERY_PATH] query "[SELECTOR]" "background-color, height, padding, font-family"
   node [CSS_QUERY_PATH] query "[SELECTOR] a" "font-size, color, font-weight, letter-spacing"
   ```
   Query each distinct element type separately to avoid mixing styles.

5. Close the session:
   ```bash
   node [CSS_QUERY_PATH] close --session=row-[INDEX]
   ```

6. Write output to [PROJECT_ROOT]/autoresearch/extraction/row-[INDEX].json

## Output Schema

```json
{
  "index": [INDEX],
  "description": "[DESCRIPTION]",
  "bounds": { "y": [Y], "height": [HEIGHT] },
  "suggestedSectionStyle": "<brand|main-nav|utility|top-bar>",
  "elements": [
    {
      "role": "<logo|nav-link|utility-link|cta|search|icon|text>",
      "position": "<left|right|center>",
      "content": { "text": "...", "href": "...", "children": [...] },
      "styles": { "font-size": "15px", "color": "rgb(60, 66, 66)" }
    }
  ],
  "rowStyles": {
    "background-color": "...",
    "height": "...",
    "font-family": "..."
  }
}
```

All elements are included regardless of role — nothing is filtered.
The `suggestedSectionStyle` is your best guess for the section-metadata
Style value based on the row's content.
```

After all row agents complete, verify the output files:

```bash
for f in $PROJECT_ROOT/autoresearch/extraction/row-*.json; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: Row agent failed — missing $f"
    exit 1
  fi
done
ROW_COUNT=$(ls -1 $PROJECT_ROOT/autoresearch/extraction/row-*.json | wc -l)
echo "Row extraction complete: $ROW_COUNT rows"
```
```

- [ ] **Step 2: Renumber icon collection from 3.3 to 3.2**

Find `#### 3.3 Icon Collection` and change to `#### 3.2 Icon Collection`.

- [ ] **Step 3: Renumber font detection from 3.4 to 3.3**

Find `#### 3.4 Font Detection & Installation` and change to
`#### 3.3 Font Detection & Installation`.

- [ ] **Step 4: Commit**

```bash
git add skills/migrate-header/SKILL.md
git commit -m "feat(migrate-header): replace Phase 3 with parallel row agents"
```

---

### Task 6: Update SKILL.md Phases 4, 5, and script listing

**Files:**
- Modify: `skills/migrate-header/SKILL.md`

Update the scaffold dispatch (Phase 4), polish loop setup (Phase 5),
and the script listing at the top of the file.

- [ ] **Step 1: Update script listing**

In the "Scripts:" section near the top of SKILL.md (lines 43–54),
remove these three lines:

```
- `node $SKILL_HOME/scripts/capture-snapshot.js <url> <output-dir> [--header-selector=header] [--overlay-recipe=path] [--browser-recipe=path]`
- `node $SKILL_HOME/scripts/extract-layout.js <snapshot.json>` (stdout JSON)
- `node $SKILL_HOME/scripts/extract-styles.js <snapshot.json> <url> [--browser-recipe=path]` (stdout JSON)
```

Update the setup-polish-loop.js line from:
```
- `node $SKILL_HOME/scripts/setup-polish-loop.js --layout=... --styles=... --source-dir=... --target-dir=... --port=3000 --max-iterations=N`
```
to:
```
- `node $SKILL_HOME/scripts/setup-polish-loop.js --rows-dir=... --url=... --source-dir=... --target-dir=... --port=3000 --max-iterations=N`
```

- [ ] **Step 2: Update Phase 5 setup-polish-loop invocation**

Find the `#### 5.1 Polish Loop Setup` section. Replace the
setup-polish-loop.js command (lines 699–707):

```bash
node "$SKILL_HOME/scripts/setup-polish-loop.js" \
  "--layout=$PROJECT_ROOT/autoresearch/extraction/layout.json" \
  "--styles=$PROJECT_ROOT/autoresearch/extraction/styles.json" \
  "--source-dir=$PROJECT_ROOT/autoresearch/source" \
  "--target-dir=$PROJECT_ROOT" \
  "--port=3000" \
  "--max-iterations=$MAX_ITERATIONS" \
  "--skill-home=$SKILL_HOME"
```

with:

```bash
node "$SKILL_HOME/scripts/setup-polish-loop.js" \
  "--rows-dir=$PROJECT_ROOT/autoresearch/extraction" \
  "--url=$URL" \
  "--source-dir=$PROJECT_ROOT/autoresearch/source" \
  "--target-dir=$PROJECT_ROOT" \
  "--port=3000" \
  "--max-iterations=$MAX_ITERATIONS" \
  "--skill-home=$SKILL_HOME"
```

- [ ] **Step 3: Update pipeline overview text**

In the Pipeline Overview ascii table (lines 26–32), change Phase 3 from:
```
Phase 3: Source Extraction      │ Snapshot → Layout/styles → Icons → Fonts
```
to:
```
Phase 3: Source Extraction      │ Row agents (parallel) → Icons → Fonts
```

- [ ] **Step 4: Update Phase 3 task tracking description**

In the Pipeline Tracking section (line 70), change:
```
3. **Phase 3: Source Extraction** — Snapshot, layout/styles, icons, fonts
```
to:
```
3. **Phase 3: Source Extraction** — Row agents (parallel), icons, fonts
```

- [ ] **Step 5: Commit**

```bash
git add skills/migrate-header/SKILL.md
git commit -m "feat(migrate-header): update Phases 4-5 refs and script listing for row extraction"
```

---

### Task 7: Delete obsolete scripts and verify

**Files:**
- Delete: `skills/migrate-header/scripts/capture-snapshot.js`
- Delete: `skills/migrate-header/scripts/capture-helpers.js`
- Delete: `skills/migrate-header/scripts/extract-layout.js`
- Delete: `skills/migrate-header/scripts/extract-styles.js`
- Delete: `tests/migrate-header/capture-snapshot.test.js`
- Delete: `tests/migrate-header/capture-helpers.integration.test.js`

- [ ] **Step 1: Delete the four extraction scripts**

```bash
git rm skills/migrate-header/scripts/capture-snapshot.js \
  skills/migrate-header/scripts/capture-helpers.js \
  skills/migrate-header/scripts/extract-layout.js \
  skills/migrate-header/scripts/extract-styles.js
```

- [ ] **Step 2: Delete tests for deleted scripts**

```bash
git rm tests/migrate-header/capture-snapshot.test.js \
  tests/migrate-header/capture-helpers.integration.test.js
```

- [ ] **Step 3: Verify no dangling references to deleted scripts**

Run these searches. Each must return zero results (excluding this plan
file, MEMORY.md, git history, and the design spec):

```bash
rg "capture-snapshot\.js" skills/migrate-header/ tests/migrate-header/
rg "capture-helpers\.js" skills/migrate-header/ tests/migrate-header/
rg "extract-layout\.js" skills/migrate-header/ tests/migrate-header/
rg "extract-styles\.js" skills/migrate-header/ tests/migrate-header/
```

If any references remain in SKILL.md or other files, remove them.

- [ ] **Step 4: Verify no dangling references to layout.json or snapshot.json in SKILL.md**

```bash
rg "layout\.json|snapshot\.json" skills/migrate-header/SKILL.md
```

Expected: zero matches. If any remain, they are stale references that
need removal.

- [ ] **Step 5: Run remaining tests**

```bash
npx vitest run tests/migrate-header/
```

Expected: all tests pass. The deleted test files are gone; the new
setup-polish-loop.test.js and remaining tests (cdp-helpers, capture-visual-tree,
detect-overlays-fallback) should all pass.

- [ ] **Step 6: Run tessl lint**

```bash
tessl skill lint skills/migrate-header
```

Expected: zero warnings. If orphaned file warnings appear, fix the
markdown link syntax in SKILL.md (use `[label](references/FILE.md)`).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(migrate-header): delete 4 extraction scripts replaced by row agents"
```
