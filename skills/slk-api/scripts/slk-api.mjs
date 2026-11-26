#!/usr/bin/env node
// Read-only Slack Web API client that reuses the sessions saved by the slk TUI.
// Credentials are read at runtime. No error path may include their contents.
import { readFileSync, readdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { cleanText, formatTime, messageBody, userIds } from "./format.mjs";

const USAGE = `Usage: slk-api.mjs <command> [args] [--ws <domain|team_id>] [--limit N] [--full]
  whoami                         check the saved sessions
  search <query>                 Slack search (supports in:#chan from:@user before:YYYY-MM-DD)
  history <channelId>            latest messages of a channel
  thread <channelId> <ts>        a thread, parent first`;

const TOKEN_DIR = process.env.SLK_TOKEN_DIR ?? `${process.env.HOME}/.local/share/slk/tokens`;
// Tests point this at a local mock. Any other host is ignored so credentials only go to Slack.
const LOCAL_BASE = /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.SLK_API_BASE ?? "");
const API_BASE = LOCAL_BASE ? process.env.SLK_API_BASE : "https://slack.com/api";
const REQUEST_TIMEOUT_MS = 15_000;
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    ws: { type: "string" },
    limit: { type: "string", default: "10" },
    full: { type: "boolean", default: false },
  },
});
const [cmd, ...args] = positionals;

class RateLimitError extends Error {
  constructor(ws, method, retryAfter) {
    super(`${ws.domain} ${method}: rate limited, retry in ${retryAfter}s`);
    this.retryAfter = retryAfter;
  }
}

// Header values with control characters make fetch throw an error that quotes the value.
const isHeaderSafe = (v) => typeof v === "string" && v.length > 0 && !/[\x00-\x1f\x7f]/.test(v);
const isValidSession = (s) =>
  s && ["access_token", "cookie", "domain", "team_id"].every((k) => isHeaderSafe(s[k]));

/** Returns the usable sessions. Warnings name the file and never show its content. */
function loadWorkspaces() {
  let files;
  try {
    files = readdirSync(TOKEN_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    throw new Error(`cannot read ${TOKEN_DIR}. Run "slk --add-workspace" first.`);
  }
  if (files.length === 0) throw new Error(`no saved sessions in ${TOKEN_DIR}. Run "slk --add-workspace".`);
  const sessions = [];
  for (const f of files) {
    let session;
    try {
      session = JSON.parse(readFileSync(`${TOKEN_DIR}/${f}`, "utf8"));
    } catch {
      session = null;
    }
    if (isValidSession(session)) {
      sessions.push(session);
    } else {
      console.error(`warning: skipping ${f}: not a valid slk session (reopen slk to refresh it)`);
    }
  }
  const selected = sessions.filter(
    (w) => !values.ws || w.domain === values.ws || w.team_id === values.ws,
  );
  if (selected.length === 0) {
    throw new Error(values.ws ? `no usable session matches --ws ${values.ws}` : "no usable sessions");
  }
  return selected;
}

async function call(ws, method, params = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ws.access_token}`,
        Cookie: `d=${ws.cookie.replace(/^d=/, "")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`${ws.domain} ${method}: request failed (${e.name})`);
  }
  if (res.status === 429) throw new RateLimitError(ws, method, res.headers.get("retry-after") ?? "?");
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    const hint = json.error === "invalid_auth" ? " (session expired: reopen slk to refresh it)" : "";
    throw new Error(`${ws.domain} ${method}: ${json.error ?? `HTTP ${res.status}`}${hint}`);
  }
  return json;
}

const namesByTeam = new Map();
const lookupsPaused = new Set();

/** Maps user IDs to display names. Unknown users keep their ID. */
async function resolveUsers(ws, ids) {
  if (!namesByTeam.has(ws.team_id)) namesByTeam.set(ws.team_id, new Map());
  const names = namesByTeam.get(ws.team_id);
  for (const id of new Set(ids)) {
    if (names.has(id) || lookupsPaused.has(ws.team_id)) continue;
    try {
      const { user } = await call(ws, "users.info", { user: id });
      names.set(id, user?.profile?.display_name || user?.real_name || id);
    } catch (e) {
      if (e instanceof RateLimitError) {
        lookupsPaused.add(ws.team_id);
        console.error(`warning: ${ws.domain} name lookups paused, retry in ${e.retryAfter}s. Showing user IDs.`);
      } else {
        names.set(id, id);
      }
    }
  }
  return names;
}

async function render(ws, m) {
  const raw = messageBody(m);
  const text = cleanText(raw, await resolveUsers(ws, [m.user, ...userIds(raw)].filter(Boolean)));
  return values.full ? text : text.slice(0, 400);
}

async function printMessages(ws, messages) {
  for (const m of messages) {
    const who = (await resolveUsers(ws, [m.user])).get(m.user) ?? m.user ?? m.username ?? "?";
    console.log(`${formatTime(m.ts)} ${who} (ts ${m.ts}): ${await render(ws, m)}`);
  }
}

// `scoped` commands take a channel ID, which exists in only one workspace.
const commands = {
  whoami: {
    async run(ws) {
      const j = await call(ws, "auth.test");
      console.log(`${ws.domain}: ${j.team} as ${j.user}`);
    },
  },
  search: {
    async run(ws, [query]) {
      if (!query) throw new Error("search needs a query");
      const { messages } = await call(ws, "search.messages", {
        query, count: values.limit, sort: "timestamp",
      });
      console.log(`== ${ws.domain}: ${messages.total} matches, showing ${messages.matches.length}`);
      for (const m of messages.matches) {
        console.log(`${formatTime(m.ts)} #${m.channel.name} (${m.channel.id}) ${m.username} ts=${m.ts}`);
        console.log(`  ${m.permalink}\n  ${await render(ws, m)}`);
      }
    },
  },
  history: {
    scoped: true,
    async run(ws, [channel]) {
      if (!channel) throw new Error("history needs a channel ID");
      const { messages } = await call(ws, "conversations.history", { channel, limit: values.limit });
      await printMessages(ws, messages.reverse());
    },
  },
  thread: {
    scoped: true,
    async run(ws, [channel, ts]) {
      if (!channel || !ts) throw new Error("thread needs a channel ID and a ts");
      const messages = [];
      let cursor = "";
      do {
        const page = await call(ws, "conversations.replies", { channel, ts, limit: "200", cursor });
        messages.push(...page.messages);
        cursor = page.response_metadata?.next_cursor ?? "";
      } while (cursor);
      await printMessages(ws, messages);
    },
  },
};

async function main() {
  const command = commands[cmd];
  if (!command) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const workspaces = loadWorkspaces();
  const errors = [];
  let succeeded = 0;
  for (const ws of workspaces) {
    try {
      await command.run(ws, args);
      succeeded++;
      if (command.scoped) break;
    } catch (e) {
      errors.push(e.message);
    }
  }
  // A channel ID belongs to one workspace, so misses elsewhere are noise once one read worked.
  if (!(command.scoped && succeeded > 0)) errors.forEach((m) => console.error(`error: ${m}`));
  if (errors.length > 0 && !(command.scoped && succeeded > 0)) process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
}
