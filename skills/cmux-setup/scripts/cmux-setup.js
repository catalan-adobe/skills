#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.config', 'cmux-setup');
const CONFIG_FILE = path.join(CONFIG_DIR, 'rules.json');
const HOOK_START = '# cmux-setup-hook-start';
const HOOK_END = '# cmux-setup-hook-end';

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function usage() {
  console.log(`cmux-setup -- manage cmux workspace colors

Usage: cmux-setup.js <command> [options]

Commands:
  apply [dir]           Apply matching color rule (default: $PWD)
  list                  Show current rules
  add                   Add a rule (--pattern --color --icon --label)
  remove                Remove a rule (--pattern)
  match [dir]           Show which rule matches (default: $PWD)
  install-hook          Install chpwd hook in .zshrc
  uninstall-hook        Remove chpwd hook from .zshrc`);
}

function requireCmux() {
  try {
    execFileSync('which', ['cmux'], { stdio: 'ignore' });
  } catch {
    die('cmux CLI not found. Is cmux running?');
  }
}

function ensureConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const initial = { rules: [], status_key: 'project' };
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify(initial, null, 2) + '\n',
    );
  }
}

function readConfig() {
  ensureConfig();
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function writeConfig(config) {
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify(config, null, 2) + '\n',
  );
}

// --- Pattern matching -------------------------------------------------------

function expandPattern(pat) {
  return pat.startsWith('~') ? HOME + pat.slice(1) : pat;
}

function countSegments(p) {
  return p.replace(/\/$/, '').split('/').filter(Boolean).length;
}

function findMatch(dir) {
  const config = readConfig();
  let bestRule = null;
  let bestDepth = -1;

  for (const rule of config.rules) {
    let expanded = expandPattern(rule.pattern);
    let isPrefix = false;

    if (expanded.endsWith('/*')) {
      isPrefix = true;
      expanded = expanded.slice(0, -2);
    }

    const matched = isPrefix
      ? dir === expanded || dir.startsWith(expanded + '/')
      : dir === expanded;

    if (matched) {
      const depth = countSegments(expanded);
      // Strict > so first rule wins at equal depth (tiebreaker per spec).
      if (depth > bestDepth) {
        bestDepth = depth;
        bestRule = rule;
      }
    }
  }

  return bestRule;
}

// --- Commands ---------------------------------------------------------------

function cmdMatch(dir) {
  dir = dir || process.cwd();
  const result = findMatch(dir);

  if (!result) {
    console.log(`No matching rule for: ${dir}`);
    return;
  }

  console.log(`Match for: ${dir}`);
  console.log(JSON.stringify(result, null, 2));
}

function cmdApply(dir) {
  dir = dir || process.cwd();
  requireCmux();

  const config = readConfig();
  const statusKey = config.status_key || 'project';
  const result = findMatch(dir);

  if (!result) {
    execFileSync('cmux', ['clear-status', statusKey], {
      stdio: 'inherit',
    });
    return;
  }

  execFileSync('cmux', [
    'set-status', statusKey, result.label,
    '--color', result.color,
    '--icon', result.icon,
  ], { stdio: 'inherit' });
}

function cmdList() {
  const config = readConfig();

  if (config.rules.length === 0) {
    console.log("No rules configured. Use 'add' to create one.");
    return;
  }

  const statusKey = config.status_key || 'project';
  console.log(`Status key: ${statusKey}\n`);

  const fmt = (pat, col, ico, lbl) =>
    `${pat.padEnd(40)} ${col.padEnd(10)} ${ico.padEnd(8)} ${lbl}`;

  console.log(fmt('PATTERN', 'COLOR', 'ICON', 'LABEL'));
  console.log(fmt('-------', '-----', '----', '-----'));

  for (const rule of config.rules) {
    console.log(fmt(rule.pattern, rule.color, rule.icon, rule.label));
  }
}

function validateHex(color) {
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
    die(`Invalid hex color '${color}'. Expected format: #RRGGBB`);
  }
}

function parseFlags(args, allowed) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!flag.startsWith('--')) die(`Unknown flag: ${flag}`);
    const name = flag.slice(2);
    if (!allowed.includes(name)) die(`Unknown flag: ${flag}`);
    if (i + 1 >= args.length) die(`Missing value for ${flag}`);
    result[name] = args[i + 1];
  }
  return result;
}

function cmdAdd(args) {
  const flags = parseFlags(args, ['pattern', 'color', 'icon', 'label']);
  const { pattern, color, icon, label } = flags;

  if (!pattern || !color || !icon || !label) {
    die(
      'Usage: cmux-setup.js add --pattern <pat> --color <hex>'
      + ' --icon <icon> --label <text>',
    );
  }

  validateHex(color);

  const config = readConfig();
  config.rules.push({ pattern, color, icon, label });
  writeConfig(config);

  console.log(`Added rule: ${pattern} -> ${label} (${color})`);
}

function cmdRemove(args) {
  const flags = parseFlags(args, ['pattern']);

  if (!flags.pattern) {
    die('Usage: cmux-setup.js remove --pattern <pat>');
  }

  const config = readConfig();
  const before = config.rules.length;
  config.rules = config.rules.filter((r) => r.pattern !== flags.pattern);
  writeConfig(config);

  if (config.rules.length === before) {
    console.log(`No rule found with pattern: ${flags.pattern}`);
  } else {
    console.log(`Removed rule: ${flags.pattern}`);
  }
}

// --- Shell hook -------------------------------------------------------------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripHookBlock(content) {
  const re = new RegExp(
    `\\n?${escapeRegExp(HOOK_START)}[\\s\\S]*?${escapeRegExp(HOOK_END)}\\n?`,
    'g',
  );
  return content.replace(re, '');
}

function cmdInstallHook() {
  const zshrc = path.join(HOME, '.zshrc');

  // Copy script to ~/.local/bin for a stable PATH-based location.
  const stableDir = path.join(HOME, '.local', 'bin');
  fs.mkdirSync(stableDir, { recursive: true });
  fs.copyFileSync(__filename, path.join(stableDir, 'cmux-setup.js'));
  fs.chmodSync(path.join(stableDir, 'cmux-setup.js'), 0o755);
  console.log(`Copied script to ${stableDir}/cmux-setup.js`);

  const hookBlock = [
    HOOK_START,
    '# Auto-apply cmux workspace colors on directory change.',
    '# Installed by cmux-setup skill. Remove with: cmux-setup.js uninstall-hook',
    '_cmux_setup_chpwd() {',
    '  command -v cmux >/dev/null 2>&1 || return 0',
    '  command -v node >/dev/null 2>&1 || return 0',
    '  [[ -f "${HOME}/.config/cmux-setup/rules.json" ]] || return 0',
    '  "${HOME}/.local/bin/cmux-setup.js" apply "$PWD" 2>/dev/null || true',
    '}',
    'chpwd_functions=(${chpwd_functions:#_cmux_setup_chpwd} _cmux_setup_chpwd)',
    HOOK_END,
  ].join('\n');

  // Idempotent: strip existing block before appending.
  if (fs.existsSync(zshrc)) {
    const content = fs.readFileSync(zshrc, 'utf8');
    if (content.includes(HOOK_START)) {
      fs.writeFileSync(zshrc, stripHookBlock(content));
    }
  }

  fs.appendFileSync(zshrc, `\n${hookBlock}\n`);
  console.log(`Hook installed in ${zshrc}`);
  console.log(
    "Run 'source ~/.zshrc' or open a new terminal to activate.",
  );
}

function cmdUninstallHook() {
  const zshrc = path.join(HOME, '.zshrc');

  if (!fs.existsSync(zshrc)) {
    console.log(`No cmux-setup hook found in ${zshrc}`);
    return;
  }

  const content = fs.readFileSync(zshrc, 'utf8');
  if (!content.includes(HOOK_START)) {
    console.log(`No cmux-setup hook found in ${zshrc}`);
    return;
  }

  fs.writeFileSync(zshrc, stripHookBlock(content));
  console.log(`Hook removed from ${zshrc}`);
}

// --- Dispatch ---------------------------------------------------------------

const [,, cmd, ...rest] = process.argv;

switch (cmd) {
  case 'apply':          cmdApply(rest[0]); break;
  case 'list':           cmdList(); break;
  case 'add':            cmdAdd(rest); break;
  case 'remove':         cmdRemove(rest); break;
  case 'match':          cmdMatch(rest[0]); break;
  case 'install-hook':   cmdInstallHook(); break;
  case 'uninstall-hook': cmdUninstallHook(); break;
  case '-h': case '--help': case undefined: usage(); break;
  default: die(`Unknown command: ${cmd}`);
}
