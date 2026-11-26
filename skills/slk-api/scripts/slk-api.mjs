#!/usr/bin/env node
// Read-only Slack Web API client that reuses the sessions saved by the slk TUI.
// Credentials are read at runtime and never printed.
import { readFileSync, readdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { cleanText, formatTime, messageBody, userIds } from "./format.mjs";

const USAGE = `Usage: slk-api.mjs <command> [args] [--ws <domain|team_id>] [--limit N] [--full]
  whoami                         check the saved sessions
  search <query>                 Slack search (supports in:#chan from:@user before:YYYY-MM-DD)
  history <channelId>            latest messages of a channel
  thread <channelId> <ts>        a thread, parent first`;

const TOKEN_DIR = process.env.SLK_TOKEN_DIR ?? `${process.env.HOME}/.local/share/slk/tokens`;
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    ws: { type: "string" },
    limit: { type: "string", default: "10" },
    full: { type: "boolean", default: false },
  },
});
const [cmd, ...args] = positionals;

function loadWorkspaces() {
  let files;
  try {
    files = readdirSync(TOKEN_DIR);
  } catch {
    throw new Error(`no slk sessions in ${TOKEN_DIR}. Run "slk --add-workspace" first.`);
  }
  return files
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(`${TOKEN_DIR}/${f}`, "utf8")))
    .filter((w) => !values.ws || w.domain === values.ws || w.team_id === values.ws);
}

async function call(ws, method, params = {}) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ws.access_token}`,
      Cookie: `d=${ws.cookie.replace(/^d=/, "")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  if (res.status === 429) {
    throw new Error(`${ws.domain} ${method}: rate limited, retry in ${res.headers.get("retry-after")}s`);
  }
  const json = await res.json();
  if (!json.ok) {
    const hint = json.error === "invalid_auth" ? " (session expired: reopen slk to refresh it)" : "";
    throw new Error(`${ws.domain} ${method}: ${json.error}${hint}`);
  }
  return json;
}

const names = new Map();
async function resolveUsers(ws, ids) {
  for (const id of new Set(ids)) {
    const key = `${ws.team_id}/${id}`;
    if (names.has(key)) continue;
    const { user } = await call(ws, "users.info", { user: id }).catch(() => ({}));
    names.set(key, user?.profile?.display_name || user?.real_name || id);
  }
  return new Map([...names].filter(([k]) => k.startsWith(ws.team_id)).map(([k, v]) => [k.split("/")[1], v]));
}

async function render(ws, m) {
  const raw = messageBody(m);
  const text = cleanText(raw, await resolveUsers(ws, [m.user, ...userIds(raw)].filter(Boolean)));
  return values.full ? text : text.slice(0, 400);
}

async function printMessages(ws, messages) {
  for (const m of messages) {
    const who = (await resolveUsers(ws, [m.user])).get(m.user) ?? m.username ?? "?";
    console.log(`${formatTime(m.ts)} ${who} (ts ${m.ts}): ${await render(ws, m)}`);
  }
}

const commands = {
  async whoami(ws) {
    const j = await call(ws, "auth.test");
    console.log(`${ws.domain}: ${j.team} as ${j.user}`);
  },
  async search(ws, [query]) {
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
  async history(ws, [channel]) {
    if (!channel) throw new Error("history needs a channel ID");
    const { messages } = await call(ws, "conversations.history", { channel, limit: values.limit });
    await printMessages(ws, messages.reverse());
  },
  async thread(ws, [channel, ts]) {
    if (!channel || !ts) throw new Error("thread needs a channel ID and a ts");
    const { messages } = await call(ws, "conversations.replies", { channel, ts, limit: "200" });
    await printMessages(ws, messages);
  },
};

if (!commands[cmd]) {
  console.error(USAGE);
  process.exit(2);
}
let failed = false;
try {
  const workspaces = loadWorkspaces();
  if (workspaces.length === 0) throw new Error(`no workspace matches --ws ${values.ws}`);
  for (const ws of workspaces) {
    await commands[cmd](ws, args).catch((e) => {
      failed = true;
      console.error(`error: ${e.message}`);
    });
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  failed = true;
}
process.exit(failed ? 1 : 0);
