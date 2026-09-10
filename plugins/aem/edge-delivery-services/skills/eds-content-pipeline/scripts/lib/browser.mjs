import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Parses `playwright-cli --raw eval` output: JSON, JSON-encoded JSON, or plain text.
 * @param {string} stdout
 */
export function parseEvalOutput(stdout) {
  const text = stdout.trim();
  if (text === '') return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * Thin wrapper around the `playwright-cli` binary bound to one named session.
 *
 * @param {object} [options]
 * @param {string} [options.session='migration'] playwright-cli session name.
 * @param {string} [options.cli='playwright-cli'] Binary to execute.
 * @param {(cli: string, args: string[], opts: object) => Promise<{stdout: string}>} [options.exec]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 */
export function createBrowser({
  session = 'migration', cli = 'playwright-cli', exec = execFileP, sleep = defaultSleep,
} = {}) {
  let tmpDir = null;
  const run = async (args) => {
    const { stdout } = await exec(cli, [`-s=${session}`, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  };

  async function open(url, { initScripts = [], contextOptions } = {}) {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'migration-browser-'));
    const configPath = path.join(tmpDir, 'cli.config.json');
    const browser = { initScript: initScripts };
    if (contextOptions) browser.contextOptions = contextOptions;
    await writeFile(configPath, JSON.stringify({ browser }));
    await run(['open', url, `--config=${configPath}`]);
  }

  const resize = (width, height) => run(['resize', String(width), String(height)]);
  const goto = (url) => run(['goto', url]);

  async function evalJson(expression) {
    return parseEvalOutput(await run(['eval', expression, '--raw']));
  }

  async function pollJson(expression, { timeoutMs = 20000, intervalMs = 500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await evalJson(expression);
      if (value !== null && value !== undefined) return value;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for ${expression}`);
      }
      await sleep(intervalMs);
    }
  }

  async function screenshot(file, { fullPage = false, target, hires = false } = {}) {
    const args = ['screenshot', ...(target ? [target] : []), `--filename=${file}`];
    if (fullPage) args.push('--full-page');
    if (hires) args.push('--hires');
    await run(args);
  }

  async function close() {
    try {
      await run(['close']);
    } finally {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    }
  }

  return {
    open, resize, goto, evalJson, pollJson, screenshot, close,
  };
}
