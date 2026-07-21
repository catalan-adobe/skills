import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_MOD = path.resolve(
	import.meta.dirname,
	"../../skills/rss-curation/scripts/db.mjs",
);
const SEARCH_MOD = path.resolve(
	import.meta.dirname,
	"../../skills/rss-curation/scripts/search.mjs",
);
const FB_MOD = path.resolve(
	import.meta.dirname,
	"../../skills/rss-curation/scripts/feedback.mjs",
);
const DIGEST_MOD = path.resolve(
	import.meta.dirname,
	"../../skills/rss-curation/scripts/digest.mjs",
);

/** @param {string} s */
function parseJSON(s) {
	try {
		return JSON.parse(s);
	} catch (e) {
		throw new Error(`Invalid JSON output: ${e.message}`);
	}
}

describe("integration: full pipeline", () => {
	let tmpDir;
	let dbPath;
	let profilePath;
	let outDir;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rss-int-"));
		dbPath = path.join(tmpDir, "test.db");
		profilePath = path.join(tmpDir, "profile.yaml");
		outDir = path.join(tmpDir, "digests");

		fs.writeFileSync(
			profilePath,
			[
				"explicit:",
				"  interests:",
				'    - "AI"',
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

	it("stores, scores, searches, feedback, and generates digest", async () => {
		const { openDb, insertArticle, writeScores } = await import(
			`${DB_MOD}?t=${Date.now()}`
		);
		const { runSearch } = await import(`${SEARCH_MOD}?t=${Date.now()}`);
		const { applyFeedback, learnFromFeedback } = await import(
			`${FB_MOD}?t=${Date.now()}`
		);
		const { generateDigest } = await import(`${DIGEST_MOD}?t=${Date.now()}`);

		// 1. Store articles
		const db = openDb(dbPath);
		insertArticle(db, {
			url: "https://example.com/ai-post",
			title: "AI Agent Patterns",
			feedName: "AI Weekly",
			feedUrl: "https://ai.com/rss",
			publishedAt: "2025-07-21T10:00:00Z",
			summary: "Practical patterns for building AI agents",
		});
		insertArticle(db, {
			url: "https://example.com/css-post",
			title: "CSS Container Queries",
			feedName: "CSS Tricks",
			feedUrl: "https://css.com/rss",
			publishedAt: "2025-07-21T11:00:00Z",
			summary: "Container queries are now baseline",
		});

		// 2. Score them
		writeScores(db, [
			{
				url: "https://example.com/ai-post",
				score: 9.0,
				scoreReason: "AI agent architecture",
				tags: ["ai", "agents"],
			},
			{
				url: "https://example.com/css-post",
				score: 7.5,
				scoreReason: "CSS advancement",
				tags: ["css", "web"],
			},
		]);
		db.close();

		// 3. Search
		const searchResult = parseJSON(runSearch(dbPath, "AI"));
		assert.ok(searchResult.results.length >= 1);

		// 4. Feedback
		applyFeedback(dbPath, "https://example.com/ai-post", "up");
		const learnResult = parseJSON(learnFromFeedback(dbPath, profilePath));
		assert.ok(learnResult.learned.examples.liked.length > 0);

		// 5. Digest
		const today = new Date().toISOString().slice(0, 10);
		const results = generateDigest(dbPath, today, { outDir });
		const md = results["2025-07-21"];
		assert.ok(md, "Expected digest for publication date 2025-07-21");
		assert.ok(md.includes("AI Agent Patterns"));
		assert.ok(md.includes("CSS Container Queries"));
		assert.ok(fs.existsSync(path.join(outDir, "2025-07-21.md")));
	});
});
