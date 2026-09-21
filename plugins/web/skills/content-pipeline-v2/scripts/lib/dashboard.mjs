// `status.mjs dashboard [stop]`: serves tools/migration/ with the EDS local server on a free
// port so nobody has to pick one. The process is detached and recorded in .work/dashboard.json.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { installDashboard } from './project.mjs';

const DASHBOARD = '/tools/migration/';
const START_TIMEOUT_MS = 30_000;

const defaultIo = {
  spawn: (port, root) => {
    // No live-reload: the workers write files under migration/ all the time, and every
    // change would reload the page (the dashboard polls what changes by itself).
    const child = spawn('aem', ['up', '--no-open', '--no-livereload', '--port', String(port)], {
      cwd: root, detached: true, stdio: 'ignore',
    });
    child.unref();
    return child.pid;
  },
  reachable: (url) => fetch(url).then((r) => r.ok, () => false),
  alive: (pid) => {
    try { return process.kill(pid, 0); } catch { return false; }
  },
  kill: (pid) => {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* group gone */ }
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  },
  sleep,
};

const stateFile = (project) => path.join(project.work, 'dashboard.json');
const readState = (project) => readFile(stateFile(project), 'utf8').then(JSON.parse, () => null);

/** Starts the server if none of ours is alive, waits for the dashboard, returns its URL. */
export async function dashboard(project, freePort, io = defaultIo) {
  const { updated } = await installDashboard(project);
  const current = await readState(project);
  if (current && io.alive(current.pid) && await io.reachable(current.url)) {
    return { ...current, started: false, updated };
  }
  const port = await freePort(3000);
  const pid = io.spawn(port, project.root);
  const url = `http://localhost:${port}${DASHBOARD}`;
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!(await io.reachable(url))) {
    if (Date.now() > deadline || !io.alive(pid)) {
      io.kill(pid);
      throw new Error(`dashboard: aem up did not answer on port ${port} — is @adobe/aem-cli `
        + 'installed (npx -y @adobe/aem-cli up) and is this an EDS repository?');
    }
    await io.sleep(250);
  }
  const state = { pid, port, url };
  await mkdir(project.work, { recursive: true });
  await writeFile(stateFile(project), `${JSON.stringify(state, null, 2)}\n`);
  return { ...state, started: true, updated };
}

/** Stops the server recorded in .work/dashboard.json, if any. */
export async function stopDashboard(project, io = defaultIo) {
  const current = await readState(project);
  if (!current) return { stopped: false };
  io.kill(current.pid);
  await rm(stateFile(project), { force: true });
  return { stopped: true, pid: current.pid, port: current.port };
}
