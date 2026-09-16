// `status.mjs cache …`: the local cache as something every later step can find and use.
// `serve` starts the page-cache proxy in offline mode on a free port (or reuses the live one)
// and records it in .work/cache-server.json; `url` turns a site URL into the proxied form;
// `ls`, `has`, `get` read the inventory and the cache directory without any server.
import { access, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { cacheRelativePath } from './checks.mjs';
import { readInventory } from './inventory.mjs';
import { readProject } from './project.mjs';

const START_TIMEOUT_MS = 10_000;

const defaultIo = {
  spawn: async (script, port, cacheDir, logFile) => {
    const log = await open(logFile, 'a');
    const child = spawn(process.execPath, [
      script, '--port', String(port), '--cache', cacheDir, '--offline',
    ], { detached: true, stdio: ['ignore', log.fd, log.fd] });
    child.unref();
    await log.close();
    return child.pid;
  },
  status: (port) => fetch(`http://127.0.0.1:${port}/__status`)
    .then((r) => (r.ok ? r.json() : null), () => null),
  alive: (pid) => {
    try { return process.kill(pid, 0); } catch { return false; }
  },
  kill: (pid) => {
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  },
  sleep,
};

export const cacheDirOf = (project) => path.join(project.step('cache'), '.page-cache');
const stateFile = (project) => path.join(project.work, 'cache-server.json');
const browserConfigFile = (project) => path.join(project.work, 'cache-browser-config.json');

/**
 * A playwright-cli config for browsing the cache: the probe's config (stealth and the like)
 * plus `network.allowedOrigins` = the proxy only, so nothing leaves the machine — no
 * analytics beacon, no live CDN. A resource that is not cached simply fails to load.
 */
async function writeBrowserConfig(project, url) {
  const probe = path.join(project.step('probe'), 'playwright-config.json');
  const base = await readFile(probe, 'utf8').then(JSON.parse, () => ({}));
  const config = { ...base, network: { ...base.network, allowedOrigins: [url] } };
  await writeFile(browserConfigFile(project), `${JSON.stringify(config, null, 2)}\n`);
  return browserConfigFile(project);
}
const readState = (project) => readFile(stateFile(project), 'utf8').then(JSON.parse, () => null);

const sameDir = (a, b) => path.resolve(a ?? '') === path.resolve(b);

async function requireCacheDir(project) {
  const dir = cacheDirOf(project);
  await access(dir).catch(() => {
    throw new Error(`no cache at ${dir}; the cache step has not stored anything yet`);
  });
  return dir;
}

/** The live server recorded in .work/cache-server.json, or null when it is gone. */
export async function cacheServerStatus(project, io = defaultIo) {
  const current = await readState(project);
  if (!current || !io.alive(current.pid)) return null;
  const status = await io.status(current.port);
  if (!status || (status.dir && !sameDir(status.dir, current.dir))) return null;
  return { ...current, cached: status.cached, hits: status.hits, misses: status.misses };
}

/**
 * Starts the offline proxy on `cache/.page-cache` unless ours is already answering.
 * `proxyScript` is page-cache's script (from setup.json, see warm-cli's setupPaths).
 */
export async function serveCache(project, proxyScript, freePort, io = defaultIo) {
  const dir = await requireCacheDir(project);
  const live = await cacheServerStatus(project, io);
  if (live) {
    return { ...live, browserConfig: await writeBrowserConfig(project, live.url), reused: true };
  }
  await mkdir(project.work, { recursive: true });
  const logFile = path.join(project.work, 'cache-server.log');
  // Two projects starting at once can pick the same free port; the loser's proxy dies and
  // the winner's would answer /__status for it. Only a server reporting our directory counts.
  let port; let pid; let status = null;
  for (let attempt = 0; attempt < 5 && !status; attempt += 1) {
    port = await freePort(3001 + attempt);
    pid = await io.spawn(proxyScript, port, dir, logFile);
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      const answer = await io.status(port);
      if (answer && sameDir(answer.dir, dir)) { status = answer; break; }
      if (answer) { io.kill(pid); break; } // another project's server holds this port: next
      if (Date.now() > deadline || !io.alive(pid)) {
        io.kill(pid);
        throw new Error(`cache server did not answer on port ${port}; see ${logFile}`);
      }
      await io.sleep(100);
    }
  }
  if (!status) throw new Error('cache server: no free port answered for our cache directory');
  const state = { pid, port, dir, offline: true, url: `http://127.0.0.1:${port}` };
  await writeFile(stateFile(project), `${JSON.stringify(state, null, 2)}\n`);
  const browserConfig = await writeBrowserConfig(project, state.url);
  return { ...state, cached: status.cached, browserConfig, reused: false };
}

/** Stops the recorded server, if any, and forgets it. */
export async function stopCacheServer(project, io = defaultIo) {
  const current = await readState(project);
  await rm(stateFile(project), { force: true });
  if (!current) return { stopped: false, reason: 'no cache server is recorded' };
  io.kill(current.pid);
  return { stopped: true, pid: current.pid, port: current.port };
}

/**
 * The proxied form of a site URL: `http://127.0.0.1:<port><path>?<query>&_origin=<origin>`.
 * The one place that knows page-cache's addressing. Refuses URLs off the project origin.
 */
export function proxiedUrl(origin, url, port) {
  const u = new URL(url);
  if (u.origin !== new URL(origin).origin) {
    throw new Error(`${url} is not on the project origin ${origin}; only the site is cached`);
  }
  const proxied = new URL(`http://127.0.0.1:${port}${u.pathname}${u.search}`);
  proxied.searchParams.set('_origin', u.origin);
  return proxied.href;
}

/** Cached URLs from the inventory (records with a stored body), filtered by group or kind. */
export async function cacheLs(project, { group, kind } = {}) {
  const records = await readInventory(project.step('urls'));
  return records
    .filter((r) => r.cache?.path)
    .filter((r) => (group ? r.group === group : true))
    .filter((r) => (kind ? r.kind === kind : true))
    .map((r) => r.url);
}

/** Whether the cache holds a body for `url` (any URL, assets included — it reads the dir). */
export async function cacheHas(project, url) {
  const file = path.join(cacheDirOf(project), cacheRelativePath(url));
  return access(file).then(() => true, () => false);
}

/** The stored body of `url`, with the sidecar's status and headers when asked. */
export async function cacheGet(project, url, { headers = false } = {}) {
  const file = path.join(cacheDirOf(project), cacheRelativePath(url));
  const body = await readFile(file).catch(() => {
    throw new Error(`${url} is not cached (no ${path.relative(project.root, file)})`);
  });
  if (!headers) return body;
  const sidecar = await readFile(`${file}.json`, 'utf8').then(JSON.parse, () => ({}));
  return { status: sidecar.status, headers: sidecar.headers ?? {}, body: body.toString() };
}

/** The project origin, for `url`. */
export async function projectOrigin(project) {
  const data = await readProject(project);
  if (!data) throw new Error(`No project at ${project.projectFile}`);
  return data.origin;
}
