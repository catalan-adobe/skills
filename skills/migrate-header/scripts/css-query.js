#!/usr/bin/env node

/**
 * css-query — On-demand CSS inspection via CDP.
 *
 * Usage:
 *   node css-query.js open <url> [--browser-recipe=path] [--session=name]
 *   node css-query.js query <selector|node:N> <props>
 *   node css-query.js cascade <selector|node:N>
 *   node css-query.js vars
 *   node css-query.js close
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractPropertiesFromMatched,
  parseRunCodeOutput,
} from './cdp-helpers.js';

const DEFAULT_SESSION = 'css-query';
const EXEC_OPTS = {
  encoding: 'utf-8',
  maxBuffer: 10 * 1024 * 1024,
};

export function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0];
  const result = { command, session: DEFAULT_SESSION };

  for (const arg of args) {
    if (arg.startsWith('--browser-recipe=')) {
      result.browserRecipe = arg.split('=').slice(1).join('=') || null;
    }
    if (arg.startsWith('--session=')) {
      result.session = arg.split('=')[1] || DEFAULT_SESSION;
    }
    if (arg.startsWith('--snapshot=')) {
      result.snapshotPath = arg.split('=').slice(1).join('=');
    }
  }

  const positional = args.slice(1).filter(a => !a.startsWith('--'));

  switch (command) {
    case 'open':
      result.url = positional[0];
      break;
    case 'query':
      result.target = positional[0];
      result.properties = positional[1]
        ? positional[1].split(',').map(p => p.trim())
        : [];
      break;
    case 'cascade':
      result.target = positional[0];
      break;
    case 'vars':
    case 'close':
      break;
  }

  return result;
}

export function parseTarget(target) {
  if (target.startsWith('node:')) {
    return { type: 'node', value: parseInt(target.slice(5), 10) };
  }
  return { type: 'selector', value: target };
}

function cli(session, ...args) {
  return execFileSync(
    'playwright-cli', [`-s=${session}`, ...args], EXEC_OPTS
  ).trim();
}

function runCDP(session, code) {
  const raw = cli(session, 'run-code', `async page => { ${code} }`);
  return parseRunCodeOutput(raw);
}

function buildRecipeConfig(browserRecipe) {
  if (!browserRecipe) return [];
  let recipe;
  try {
    recipe = JSON.parse(readFileSync(browserRecipe, 'utf-8'));
  } catch (err) {
    console.error(
      `Failed to load browser recipe: ${browserRecipe}: ${err.message}`
    );
    process.exit(1);
  }

  const tempFiles = [];
  const config = { ...recipe.cliConfig };

  if (recipe.stealthInitScript) {
    const stealthPath = join(
      tmpdir(), `css-query-stealth-${Date.now()}.js`
    );
    writeFileSync(stealthPath, recipe.stealthInitScript);
    tempFiles.push(stealthPath);
    if (!config.browser) config.browser = {};
    config.browser.initScript = [stealthPath];
  }

  const configPath = join(
    tmpdir(), `css-query-config-${Date.now()}.json`
  );
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  tempFiles.push(configPath);

  return { extraArgs: [`--config=${configPath}`], tempFiles };
}

function cmdOpen(args) {
  if (!args.url) {
    console.error(
      'Usage: node css-query.js open <url> [--browser-recipe=path]'
    );
    process.exit(1);
  }
  const { extraArgs, tempFiles } = buildRecipeConfig(args.browserRecipe);
  try {
    cli(args.session, 'open', args.url, ...extraArgs);
  } finally {
    for (const f of tempFiles) {
      try { unlinkSync(f); } catch { /* temp file cleanup */ }
    }
  }
  console.error(
    `CSS query session "${args.session}" opened on ${args.url}`
  );
}

function buildSelectorResolve(target) {
  return `const {nodeId} = await cdp.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: ${JSON.stringify(target.value)},
      });
      if (!nodeId) {
        return JSON.stringify({
          error: 'Element not found: ' + ${JSON.stringify(target.value)}
        });
      }`;
}

function buildNodeResolve(target) {
  // TODO: Full depth-first walk for node:N lookup.
  // For now, use a simple DFS over the header subtree.
  return `function walkDFS(node, counter) {
        if (counter.idx === ${target.value}) return node;
        counter.idx++;
        for (const child of node.children || []) {
          const found = walkDFS(child, counter);
          if (found) return found;
        }
        return null;
      }
      const headerNode = await cdp.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: 'header, nav, [role=banner]',
      });
      if (!headerNode.nodeId) {
        return JSON.stringify({error: 'Header element not found'});
      }
      const fullTree = await cdp.send('DOM.describeNode', {
        nodeId: headerNode.nodeId, depth: -1,
      });
      const targetNode = walkDFS(fullTree.node, {idx: 0});
      if (!targetNode) {
        return JSON.stringify({
          error: 'Node ${target.value} not found'
        });
      }
      const nodeId = targetNode.backendNodeId
        ? (await cdp.send('DOM.pushNodesByBackendIdsToFrontend', {
            backendNodeIds: [targetNode.backendNodeId]
          })).nodeIds[0]
        : headerNode.nodeId;`;
}

function cmdQuery(args) {
  const target = parseTarget(args.target);
  const propsFilter = args.properties;

  const resolveExpr = target.type === 'selector'
    ? buildSelectorResolve(target)
    : buildNodeResolve(target);

  const code = `
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      const {root} = await cdp.send('DOM.getDocument');
      ${resolveExpr}
      const [computed, matched] = await Promise.all([
        cdp.send('CSS.getComputedStyleForNode', {nodeId}),
        cdp.send('CSS.getMatchedStylesForNode', {nodeId}),
      ]);
      return JSON.stringify({computed, matched});
    } finally {
      await cdp.detach();
    }
  `;

  const raw = runCDP(args.session, code);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('Failed to parse CDP response');
    process.exit(1);
  }

  if (parsed.error) {
    console.error(parsed.error);
    process.exit(1);
  }

  const allProps = extractPropertiesFromMatched(
    parsed.matched, {}, true
  );

  const computedMap = new Map();
  for (const prop of parsed.computed?.computedStyle || []) {
    computedMap.set(prop.name, prop.value);
  }

  const output = { selector: args.target, properties: {} };
  for (const [name, info] of allProps) {
    if (propsFilter.length > 0 && !propsFilter.includes(name)) {
      continue;
    }
    output.properties[name] = {
      ...info,
      value: computedMap.get(name) || info.value,
    };
  }

  // Add requested computed-only props not in matched rules
  for (const prop of propsFilter) {
    if (!output.properties[prop] && computedMap.has(prop)) {
      output.properties[prop] = {
        value: computedMap.get(prop),
        source: 'computed',
        selector: null,
        file: null,
        inherited: false,
      };
    }
  }

  console.log(JSON.stringify(output, null, 2));
}

function cmdCascade(args) {
  const target = parseTarget(args.target);
  const selectorExpr = target.type === 'selector'
    ? JSON.stringify(target.value)
    : `'header, nav, [role=banner]'`;

  const code = `
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      const {root} = await cdp.send('DOM.getDocument');
      const {nodeId} = await cdp.send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: ${selectorExpr},
      });
      if (!nodeId) return JSON.stringify({error: 'Element not found'});
      const matched = await cdp.send(
        'CSS.getMatchedStylesForNode', {nodeId}
      );
      return JSON.stringify(matched);
    } finally {
      await cdp.detach();
    }
  `;

  const raw = runCDP(args.session, code);
  console.log(raw);
}

function cmdVars(args) {
  const code = `
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      const {root} = await cdp.send('DOM.getDocument');
      const {nodeId} = await cdp.send('DOM.querySelector', {
        nodeId: root.nodeId, selector: ':root',
      });
      const matched = await cdp.send(
        'CSS.getMatchedStylesForNode', {nodeId}
      );
      const vars = {};
      for (const match of matched.matchedCSSRules || []) {
        if (match.rule.origin !== 'regular') continue;
        for (const prop of match.rule.style.cssProperties || []) {
          if (prop.name?.startsWith('--') && !prop.disabled) {
            vars[prop.name] = prop.value;
          }
        }
      }
      return JSON.stringify(vars);
    } finally {
      await cdp.detach();
    }
  `;

  const raw = runCDP(args.session, code);
  console.log(raw);
}

function cmdClose(args) {
  try {
    cli(args.session, 'close');
    console.error(`Session "${args.session}" closed.`);
  } catch {
    console.error(`Session "${args.session}" was not open.`);
  }
}

function main() {
  const args = parseArgs(process.argv);

  switch (args.command) {
    case 'open': cmdOpen(args); break;
    case 'query': cmdQuery(args); break;
    case 'cascade': cmdCascade(args); break;
    case 'vars': cmdVars(args); break;
    case 'close': cmdClose(args); break;
    default:
      console.error(
        'Usage: node css-query.js'
        + ' <open|query|cascade|vars|close> [args]'
      );
      process.exit(1);
  }
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
