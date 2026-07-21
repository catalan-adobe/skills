import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_MOD = path.resolve(
	import.meta.dirname,
	"../../skills/rss-curation/scripts/db.mjs",
);
const FB_MOD = path.resolve(
	import.meta.dirname,
	"../../skills/rss-curation/scripts/feedback.mjs",
);

/** @param {string} s */
function parseJSON(s) {
	try {
		return JSON.parse(s);
	} catch (e) {
		throw new Error(`Invalid JSON output: ${e.message}`);
	}
}

describe("feedback", () => {
	let tmpDir;
	let dbPath;
	let profilePath;

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rss-fb-"));
		dbPath = path.join(tmpDir, "test.db");
		profilePath = path.join(tmpDir, "profile.yaml");

		const { openDb, insertArticle, writeScores } = await import(
			`${DB_MOD}?t=${Date.now()}`
		);
		const db = openDb(dbPath);
		insertArticle(db, {
			url: "https://example.com/ai-agents",
			title: "Building AI Agents",
			feedName: "AI Blog",
			feedUrl: "https://ai.com/rss",
			publishedAt: "2025-07-21T10:00:00Z",
			summary: "How to build AI agents with tool use",
		});
		insertArticle(db, {
			url: "https://example.com/crypto-hype",
			title: "Top 10 Crypto Coins",
			feedName: "Crypto Daily",
			feedUrl: "https://crypto.com/rss",
			publishedAt: "2025-07-21T11:00:00Z",
			summary: "The hottest crypto coins this week",
		});
		writeScores(db, [
			{
				url: "https://example.com/ai-agents",
				score: 9.0,
				scoreReason: "AI agents",
				tags: ["ai", "agents"],
			},
			{
				url: "https://example.com/crypto-hype",
				score: 2.0,
				scoreReason: "crypto listicle",
				tags: ["crypto"],
			},
		]);
		db.close();

		fs.writeFileSync(
			profilePath,
			[
				"explicit:",
				"  interests:",
				'    - "AI agents"',
				"  anti-interests: []",
				"inferred:",
				"  sources: []",
				"  topics: []",
				"learned:",
				"  boost: []",
				"  suppress: []",
				"  examples:",
				"    liked: []",
				"    disliked: []",
				"",
			].join("\n"),
		);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("applyFeedback records signal and returns confirmation", async () => {
		const { applyFeedback } = await import(`${FB_MOD}?t=${Date.now()}`);
		const output = applyFeedback(dbPath, "https://example.com/ai-agents", "up");
		const parsed = parseJSON(output);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.signal, "up");
	});

	it("applyFeedback accepts text aliases +1 and -1", async () => {
		const { applyFeedback } = await import(`${FB_MOD}?t=${Date.now()}`);
		const up = parseJSON(
			applyFeedback(dbPath, "https://example.com/ai-agents", "+1"),
		);
		assert.equal(up.ok, true);
		assert.equal(up.signal, "up");

		const down = parseJSON(
			applyFeedback(dbPath, "https://example.com/crypto-hype", "-1"),
		);
		assert.equal(down.ok, true);
		assert.equal(down.signal, "down");
	});

	it("applyStar and listStarred", async () => {
		const { applyStar, listStarred } = await import(
			`${FB_MOD}?t=${Date.now()}`
		);

		const starResult = parseJSON(
			applyStar(dbPath, "https://example.com/ai-agents", true),
		);
		assert.equal(starResult.ok, true);
		assert.equal(starResult.starred, true);

		const list = parseJSON(listStarred(dbPath));
		assert.equal(list.count, 1);
		assert.equal(list.articles[0].title, "Building AI Agents");

		// Unstar
		applyStar(dbPath, "https://example.com/ai-agents", false);
		const empty = parseJSON(listStarred(dbPath));
		assert.equal(empty.count, 0);
	});

	it("learnFromFeedback updates profile with patterns", async () => {
		const { applyFeedback, learnFromFeedback } = await import(
			`${FB_MOD}?t=${Date.now()}`
		);
		applyFeedback(dbPath, "https://example.com/ai-agents", "up");
		applyFeedback(dbPath, "https://example.com/crypto-hype", "down");

		const output = learnFromFeedback(dbPath, profilePath);
		const parsed = parseJSON(output);
		assert.ok(parsed.learned);
		assert.ok(parsed.learned.examples.liked.length > 0);
		assert.ok(parsed.learned.examples.disliked.length > 0);

		const profile = fs.readFileSync(profilePath, "utf8");
		assert.ok(profile.includes("Building AI Agents"));
	});
});
