import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dirname, "../../skills/slk-api/scripts/slk-api.mjs");
const run = (args, env = {}) =>
  spawnSync("node", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

describe("slk-api CLI", () => {
  it("prints usage and exits 2 for an unknown command", () => {
    const r = run(["nope"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Usage:/);
  });

  it("explains how to set up slk when no sessions exist", () => {
    const r = run(["whoami"], { SLK_TOKEN_DIR: "/nonexistent/slk-tokens" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /slk --add-workspace/);
  });

  it("requires a query for search", () => {
    const r = run(["search"], { SLK_TOKEN_DIR: "/nonexistent/slk-tokens" });
    assert.equal(r.status, 1);
  });
});
