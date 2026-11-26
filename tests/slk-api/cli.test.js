import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dirname, "../../skills/slk-api/scripts/slk-api.mjs");
const PRELOAD = path.resolve(import.meta.dirname, "mock-fetch.mjs");
const SECRET = "xoxc-SECRET-TOKEN-VALUE";

const session = (team, extra = {}) => ({
  access_token: `${SECRET}-${team}`,
  cookie: `xoxd-SECRET-COOKIE-${team}`,
  domain: team.toLowerCase(),
  team_id: team,
  ...extra,
});

function tokenDir(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "slk-tokens-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}

// Mock Slack. `handlers` maps a method name to (params, team) => response object or { status }.
let server;
let handlers = {};
let calls = [];
before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const method = req.url.replace("/api/", "");
      const team = (req.headers.authorization ?? "").split("-").pop();
      const params = Object.fromEntries(new URLSearchParams(body));
      calls.push({ method, team, params });
      const cookieOk = (req.headers.cookie ?? "") === `d=xoxd-SECRET-COOKIE-${team}`;
      const out = !cookieOk
        ? { ok: false, error: "invalid_auth" }
        : (handlers[method]?.(params, team) ?? { ok: false, error: "unknown_method" });
      if (out.hang) return; // never answer, so the client's own timeout fires
      res.statusCode = out.status ?? 200;
      if (out.retryAfter) res.setHeader("retry-after", out.retryAfter);
      res.end(JSON.stringify(out.body ?? out));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
});
after(() => server.close());

function run(args, dir, { slowStdout = false, env: extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    ...(dir === undefined ? {} : { SLK_TOKEN_DIR: dir }),
    SLK_TEST_MOCK_PORT: String(server.address().port),
    ...extraEnv,
  };
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", PRELOAD, SCRIPT, ...args], { env });
    let stdout = "";
    let stderr = "";
    if (slowStdout) child.stdout.pause();
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (slowStdout) setTimeout(() => child.stdout.resume(), 300);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const reset = () => {
  handlers = {};
  calls = [];
};

describe("usage and setup errors", () => {
  it("prints usage and exits 2 for an unknown command", async () => {
    const r = await run(["nope"], tokenDir({}));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Usage:/);
  });

  it("points to slk --add-workspace when the token directory is empty", async () => {
    const r = await run(["whoami"], tokenDir({}));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /slk --add-workspace/);
  });

  it("requires a query for search", async () => {
    reset();
    const r = await run(["search"], tokenDir({ "T1.json": session("T1") }));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /search needs a query/);
    assert.equal(calls.length, 0);
  });

  it("reports an unknown --ws as a missing session, not a missing setup", async () => {
    const r = await run(["whoami", "--ws", "nope"], tokenDir({ "T1.json": session("T1") }));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no usable session matches --ws nope/);
  });
});

describe("credential secrecy", () => {
  it("never prints a cookie with a control character", async () => {
    reset();
    const dir = tokenDir({ "T1.json": session("T1", { cookie: "xoxd-SECRET\nCOOKIE" }) });
    const r = await run(["whoami"], dir);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout + r.stderr, /SECRET/);
    assert.match(r.stderr, /T1\.json/);
  });

  it("never prints fragments of a malformed token file", async () => {
    reset();
    const dir = tokenDir({ "T1.json": '{"access_token":"xoxc-SECRET-FRAGMENT" oops' });
    const r = await run(["whoami"], dir);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout + r.stderr, /SECRET/);
  });

  it("keeps a healthy session usable next to a broken one", async () => {
    reset();
    handlers["auth.test"] = () => ({ ok: true, team: "Good", user: "me" });
    const dir = tokenDir({
      "BAD.json": "not json",
      "T1.json": session("T1"),
    });
    const r = await run(["whoami", "--ws", "T1"], dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /t1: Good as me/);
    assert.match(r.stderr, /skipping BAD\.json/);
    assert.doesNotMatch(r.stdout + r.stderr, /SECRET/);
  });
});

describe("channel-scoped reads", () => {
  const dir = () => tokenDir({ "T1.json": session("T1"), "T2.json": session("T2") });

  it("exits 0 when one workspace owns the channel and the other does not", async () => {
    reset();
    handlers["conversations.history"] = (_p, team) =>
      team === "T1"
        ? { ok: false, error: "channel_not_found" }
        : { ok: true, messages: [{ ts: "1795615289.0", user: "U1", text: "hello" }] };
    handlers["users.info"] = () => ({ ok: true, user: { real_name: "Ana", profile: {} } });
    const r = await run(["history", "C1"], dir());
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Ana .*hello/);
    assert.equal(r.stderr, "");
  });

  it("stops after the first workspace that reads the channel", async () => {
    reset();
    handlers["conversations.history"] = () => ({ ok: true, messages: [] });
    const r = await run(["history", "C1"], dir());
    assert.equal(r.status, 0);
    assert.equal(calls.filter((c) => c.method === "conversations.history").length, 1);
  });

  it("fails when no workspace can read the channel", async () => {
    reset();
    handlers["conversations.history"] = () => ({ ok: false, error: "channel_not_found" });
    const r = await run(["history", "C1"], dir());
    assert.equal(r.status, 1);
    assert.match(r.stderr, /channel_not_found/);
  });
});

describe("thread pagination", () => {
  it("follows the cursor and keeps the parent first", async () => {
    reset();
    handlers["conversations.replies"] = (p) =>
      p.cursor === "c2"
        ? { ok: true, messages: [{ ts: "3.0", user: "U1", text: "third" }] }
        : {
            ok: true,
            messages: [
              { ts: "1.0", user: "U1", text: "parent" },
              { ts: "2.0", user: "U1", text: "second" },
            ],
            response_metadata: { next_cursor: "c2" },
          };
    handlers["users.info"] = () => ({ ok: true, user: { real_name: "Ana", profile: {} } });
    const r = await run(["thread", "C1", "1.0"], tokenDir({ "T1.json": session("T1") }));
    assert.equal(r.status, 0);
    const order = ["parent", "second", "third"].map((t) => r.stdout.indexOf(t));
    assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], r.stdout);
  });
});

describe("rate limits", () => {
  it("stops name lookups after a 429 and still prints the messages", async () => {
    reset();
    handlers["conversations.history"] = () => ({
      ok: true,
      messages: [
        { ts: "1.0", user: "U1", text: "a" },
        { ts: "2.0", user: "U2", text: "b" },
        { ts: "3.0", user: "U3", text: "c" },
      ],
    });
    handlers["users.info"] = () => ({ status: 429, retryAfter: "7", body: {} });
    const r = await run(["history", "C1"], tokenDir({ "T1.json": session("T1") }));
    assert.equal(calls.filter((c) => c.method === "users.info").length, 1);
    assert.match(r.stderr, /retry in 7s/);
    assert.match(r.stdout, /U1 .*a/);
    assert.match(r.stdout, /U3 .*c/);
  });
});

describe("output", () => {
  it("does not lose lines when stdout drains slowly", async () => {
    reset();
    const messages = Array.from({ length: 200 }, (_, i) => ({
      ts: `${i + 1}.0`, user: "U1", text: `line-${i}-${"x".repeat(900)}`,
    }));
    handlers["conversations.replies"] = () => ({ ok: true, messages });
    handlers["users.info"] = () => ({ ok: true, user: { real_name: "Ana", profile: {} } });
    const r = await run(["thread", "C1", "1.0", "--full"], tokenDir({ "T1.json": session("T1") }), {
      slowStdout: true,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim().split("\n").length, 200);
  });
});

describe("search", () => {
  const dir = () => tokenDir({ "T1.json": session("T1"), "T2.json": session("T2") });
  const match = (extra = {}) => ({
    ts: "1795615289.0", permalink: "https://x.slack.com/archives/C1/p1", text: "found it",
    channel: { id: "C1", name: "general" }, ...extra,
  });

  it("queries every workspace and passes the query and limit to Slack", async () => {
    reset();
    handlers["search.messages"] = () => ({ ok: true, messages: { total: 1, matches: [match({ username: "bob" })] } });
    const r = await run(["search", "java in:#general", "--limit", "3"], dir());
    assert.equal(r.status, 0);
    const sent = calls.filter((c) => c.method === "search.messages");
    assert.deepEqual(sent.map((c) => c.team).sort(), ["T1", "T2"]);
    assert.ok(sent.every((c) => c.params.query === "java in:#general" && c.params.count === "3"));
    assert.match(r.stdout, /#general \(C1\) bob ts=1795615289\.0/);
    assert.match(r.stdout, /https:\/\/x\.slack\.com\/archives\/C1\/p1/);
  });

  it("uses the resolved name when a match has a user ID but no username", async () => {
    reset();
    handlers["search.messages"] = () => ({ ok: true, messages: { total: 1, matches: [match({ user: "U1" })] } });
    handlers["users.info"] = () => ({ ok: true, user: { real_name: "Alice", profile: {} } });
    const r = await run(["search", "x", "--ws", "T1"], dir());
    assert.match(r.stdout, /#general \(C1\) Alice ts=/);
    assert.doesNotMatch(r.stdout, /undefined/);
  });

  it("falls back to the user ID when the lookup fails", async () => {
    reset();
    handlers["search.messages"] = () => ({ ok: true, messages: { total: 1, matches: [match({ user: "U9" })] } });
    const r = await run(["search", "x", "--ws", "T1"], dir());
    assert.match(r.stdout, /\(C1\) U9 ts=/);
  });
});

describe("workspace selection", () => {
  it("rejects an empty --ws before any API call", async () => {
    reset();
    const r = await run(["search", "secret topic", "--ws", ""], tokenDir({ "T1.json": session("T1"), "T2.json": session("T2") }));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--ws is empty/);
    assert.equal(calls.length, 0);
  });
});

describe("session discovery and destination", () => {
  it("finds sessions under XDG_DATA_HOME like slk does", async () => {
    reset();
    handlers["auth.test"] = () => ({ ok: true, team: "Xdg", user: "me" });
    const home = mkdtempSync(path.join(tmpdir(), "xdg-"));
    mkdirSync(path.join(home, "slk", "tokens"), { recursive: true });
    writeFileSync(path.join(home, "slk", "tokens", "TX.json"), JSON.stringify(session("TX")));
    const r = await run(["whoami"], undefined, { env: { SLK_TOKEN_DIR: "", XDG_DATA_HOME: home } });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /tx: Xdg as me/);
  });

  it("ignores SLK_API_BASE so credentials only go to slack.com", async () => {
    reset();
    let hits = 0;
    const decoy = createServer((_q, res) => { hits++; res.end("{}"); });
    await new Promise((r) => decoy.listen(0, "127.0.0.1", r));
    handlers["auth.test"] = () => ({ ok: true, team: "Real", user: "me" });
    const r = await run(["whoami"], tokenDir({ "T1.json": session("T1") }), {
      env: { SLK_API_BASE: `http://127.0.0.1:${decoy.address().port}` },
    });
    decoy.close();
    assert.equal(hits, 0);
    assert.equal(r.status, 0);
    assert.equal(calls.length, 1);
  });

  for (const code of ["invalid_auth", "token_expired", "token_revoked"]) {
    it(`tells the user to refresh the session on ${code}`, async () => {
      reset();
      handlers["auth.test"] = () => ({ ok: false, error: code });
      const r = await run(["whoami"], tokenDir({ "T1.json": session("T1") }));
      assert.equal(r.status, 1);
      assert.match(r.stderr, /reopen slk/);
    });
  }
});

describe("review round 3", () => {
  const one = () => tokenDir({ "T1.json": session("T1") });
  const ana = () => ({ ok: true, user: { real_name: "Ana", profile: {} } });

  it("accepts a legacy session without a domain and labels it by team ID", async () => {
    reset();
    handlers["auth.test"] = () => ({ ok: true, team: "Legacy", user: "me" });
    const { domain: _omit, ...legacy } = session("T1");
    const r = await run(["whoami", "--ws", "T1"], tokenDir({ "T1.json": legacy }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /T1: Legacy as me/);
  });

  it("follows the cursor until --limit messages are collected, oldest first", async () => {
    reset();
    handlers["users.info"] = ana;
    handlers["conversations.history"] = (p) =>
      p.cursor === "c2"
        ? { ok: true, messages: [{ ts: "1.0", user: "U1", text: "one" }] }
        : {
            ok: true,
            messages: [{ ts: "3.0", user: "U1", text: "three" }, { ts: "2.0", user: "U1", text: "two" }],
            response_metadata: { next_cursor: "c2" },
          };
    const r = await run(["history", "C1", "--limit", "3"], one());
    assert.equal(r.status, 0);
    const order = ["one", "two", "three"].map((t) => r.stdout.indexOf(t));
    assert.ok(order[0] >= 0 && order[0] < order[1] && order[1] < order[2], r.stdout);
    assert.equal(calls.filter((c) => c.method === "conversations.history")[1].params.limit, "1");
  });

  it("does not report an empty channel when the first page is empty but a cursor exists", async () => {
    reset();
    handlers["users.info"] = ana;
    handlers["conversations.history"] = (p) =>
      p.cursor
        ? { ok: true, messages: [{ ts: "1.0", user: "U1", text: "late page" }] }
        : { ok: true, messages: [], response_metadata: { next_cursor: "c2" } };
    const r = await run(["history", "C1", "--limit", "3"], one());
    assert.match(r.stdout, /late page/);
  });

  it("stops at --limit without asking for another page", async () => {
    reset();
    handlers["users.info"] = ana;
    handlers["conversations.history"] = () => ({
      ok: true,
      messages: [{ ts: "2.0", user: "U1", text: "b" }, { ts: "1.0", user: "U1", text: "a" }],
      response_metadata: { next_cursor: "more" },
    });
    await run(["history", "C1", "--limit", "2"], one());
    assert.equal(calls.filter((c) => c.method === "conversations.history").length, 1);
  });

  it("warns once and stops name lookups when the session expires mid-read", async () => {
    reset();
    handlers["conversations.history"] = () => ({
      ok: true,
      messages: ["U1", "U2", "U3"].map((u, i) => ({ ts: `${i + 1}.0`, user: u, text: `m${i}` })),
    });
    handlers["users.info"] = () => ({ ok: false, error: "token_revoked" });
    const r = await run(["history", "C1"], one());
    assert.equal(calls.filter((c) => c.method === "users.info").length, 1);
    assert.equal((r.stderr.match(/reopen slk/g) ?? []).length, 1);
    assert.match(r.stdout, /U1 .*m0/);
    assert.match(r.stdout, /U3 .*m2/);
  });

  it("joins extra search words instead of dropping them", async () => {
    reset();
    handlers["search.messages"] = () => ({ ok: true, messages: { total: 0, matches: [] } });
    await run(["search", "incident", "in:#ops", "--ws", "T1"], one());
    assert.equal(calls.find((c) => c.method === "search.messages").params.query, "incident in:#ops");
  });

  for (const bad of ["abc", "0", "1.5"]) {
    it(`rejects --limit ${bad} before any API call`, async () => {
      reset();
      const r = await run(["history", "C1", "--limit", bad], one());
      assert.equal(r.status, 2);
      assert.match(r.stderr, /--limit must be a positive whole number/);
      assert.equal(calls.length, 0);
    });
  }

  it("accepts a session whose domain is an empty string and labels it by team ID", async () => {
    reset();
    handlers["auth.test"] = () => ({ ok: true, team: "Legacy", user: "me" });
    const r = await run(["whoami", "--ws", "T1"], tokenDir({ "T1.json": session("T1", { domain: "" }) }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /T1: Legacy as me/);
    assert.equal(calls.filter((c) => c.method === "auth.test").length, 1);
  });

  it("pauses name lookups after one timeout and still prints the messages", async () => {
    reset();
    handlers["conversations.history"] = () => ({
      ok: true,
      messages: ["U1", "U2", "U3"].map((u, i) => ({ ts: `${i + 1}.0`, user: u, text: `m${i}` })),
    });
    handlers["users.info"] = () => ({ hang: true });
    const r = await run(["history", "C1"], one(), { env: { SLK_TEST_TIMEOUT_MS: "150" } });
    assert.equal(r.status, 0);
    assert.equal(calls.filter((c) => c.method === "users.info").length, 1);
    assert.equal((r.stderr.match(/lookups paused/g) ?? []).length, 1);
    assert.match(r.stdout, /U1 .*m0/);
    assert.match(r.stdout, /U3 .*m2/);
  });

  it("accepts a search that starts with a hyphen after --", async () => {
    reset();
    handlers["search.messages"] = () => ({ ok: true, messages: { total: 0, matches: [] } });
    const r = await run(["search", "--ws", "T1", "--", "-from:@ci", "incident"], one());
    assert.equal(r.status, 0, r.stderr);
    assert.equal(calls.find((c) => c.method === "search.messages").params.query, "-from:@ci incident");
  });

  it("turns an unknown option into a short usage message, not a stack trace", async () => {
    reset();
    const r = await run(["search", "-from:@ci incident"], one());
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Usage:/);
    assert.doesNotMatch(r.stderr, /node:internal|^\s+at .+\(.+:\d+:\d+\)/m);
    assert.equal(calls.length, 0);
  });
});
