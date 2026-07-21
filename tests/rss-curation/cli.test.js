import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

const SCRIPT = path.resolve(
	import.meta.dirname,
	"../../skills/rss-curation/scripts/rss-feed.mjs",
);

describe("CLI", () => {
	it("exits with error when no subcommand given", () => {
		assert.throws(
			() => execFileSync("node", [SCRIPT], { encoding: "utf8" }),
			(err) => {
				assert.ok(err.stderr.includes("Usage:"));
				return true;
			},
		);
	});

	it("exits with error for unknown subcommand", () => {
		assert.throws(
			() => execFileSync("node", [SCRIPT, "bogus"], { encoding: "utf8" }),
			(err) => {
				assert.ok(err.stderr.includes("Unknown subcommand"));
				return true;
			},
		);
	});
});
