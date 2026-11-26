import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dirname, "../../skills/slk-api/scripts/slk-api.mjs");
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
      const method = req.url.replace("/", "");
      const team = (req.headers.authorization ?? "").split("-").pop();
      const params = Object.fromEntries(new URLSearchParams(body));
      calls.push({ method, team, params });
      const out = handlers[method]?.(params, team) ?? { ok: false, error: "unknown_method" };
      res.statusCode = out.status ?? 200;
      if (out.retryAfter) res.setHeader("retry-after", out.retryAfter);
      res.end(JSON.stringify(out.body ?? out));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
});
after(() => server.close());

function run(args, dir, { slowStdout = false } = {}) {
  const env = {
    ...process.env,
    SLK_TOKEN_DIR: dir,
    SLK_API_BASE: `http://127.0.0.1:${server.address().port}`,
  };
  return new Promise((resolve) => {
    const child = spawn("node", [SCRIPT, ...args], { env });
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
