import fs from "node:fs";
import yaml from "js-yaml";
import { openDb, recordFeedback, setStarred, getStarred, getFeedbackStats } from "./db.mjs";

const SIGNAL_ALIASES = {
	"+1": "up",
	"-1": "down",
	up: "up",
	down: "down",
};

export function applyFeedback(dbPath, url, signal) {
	const resolved = SIGNAL_ALIASES[signal];
	if (!resolved) return JSON.stringify({ ok: false, error: `Unknown signal: ${signal}` });
	const db = openDb(dbPath);
	try {
		recordFeedback(db, url, resolved);
		return JSON.stringify({ ok: true, url, signal: resolved });
	} finally {
		db.close();
	}
}

export function applyStar(dbPath, url, starred = true) {
	const db = openDb(dbPath);
	try {
		setStarred(db, url, starred);
		return JSON.stringify({ ok: true, url, starred });
	} finally {
		db.close();
	}
}

export function listStarred(dbPath) {
	const db = openDb(dbPath);
	try {
		const articles = getStarred(db);
		return JSON.stringify({
			count: articles.length,
			articles: articles.map((a) => ({
				title: a.title,
				url: a.url,
				feedName: a.feed_name,
				score: a.score,
				scoreReason: a.score_reason,
			})),
		}, null, 2);
	} finally {
		db.close();
	}
}

function safeParseTags(raw) {
	if (!raw) return [];
	try {
		return JSON.parse(raw);
	} catch {
		return [];
	}
}

function extractTopics(articles) {
	const tagCounts = {};
	for (const article of articles) {
		const tags = safeParseTags(article.tags);
		for (const tag of tags) {
			tagCounts[tag] = (tagCounts[tag] || 0) + 1;
		}
	}
	return Object.entries(tagCounts)
		.sort((a, b) => b[1] - a[1])
		.map(([tag]) => tag);
}

export function learnFromFeedback(dbPath, profilePath) {
	const db = openDb(dbPath);
	try {
		const { ups, downs } = getFeedbackStats(db);
		const profile = yaml.load(fs.readFileSync(profilePath, "utf8"));

		const learned = {
			boost: extractTopics(ups),
			suppress: extractTopics(downs),
			examples: {
				liked: ups.map((a) => ({
					title: a.title,
					reason: a.score_reason || "liked by user",
				})),
				disliked: downs.map((a) => ({
					title: a.title,
					reason: a.score_reason || "disliked by user",
				})),
			},
		};

		profile.learned = learned;
		fs.writeFileSync(profilePath, yaml.dump(profile, { lineWidth: 80 }));

		return JSON.stringify({ ok: true, learned });
	} finally {
		db.close();
	}
}
