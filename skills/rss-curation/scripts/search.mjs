import { openDb, searchArticles } from "./db.mjs";

function safeParseTags(raw) {
	if (!raw) return [];
	try {
		return JSON.parse(raw);
	} catch {
		return [];
	}
}

export function formatSearchResults(results, query) {
	return JSON.stringify(
		{
			query,
			count: results.length,
			results: results.map((r) => ({
				title: r.title,
				url: r.url,
				feedName: r.feed_name,
				publishedAt: r.published_at,
				summary: r.summary,
				score: r.score,
				tags: safeParseTags(r.tags),
				feedback: r.feedback,
			})),
		},
		null,
		2,
	);
}

export function runSearch(dbPath, query, limit = 20) {
	const db = openDb(dbPath);
	try {
		const results = searchArticles(db, query, limit);
		return formatSearchResults(results, query);
	} finally {
		db.close();
	}
}
