import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS articles (
  id            INTEGER PRIMARY KEY,
  url           TEXT UNIQUE,
  title         TEXT,
  author        TEXT,
  feed_name     TEXT,
  feed_url      TEXT,
  published_at  TEXT,
  fetched_at    TEXT,
  summary       TEXT,
  content       TEXT,
  score         REAL,
  score_reason  TEXT,
  tags          TEXT,
  feedback      TEXT,
  starred       INTEGER DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  title, summary, content, tags,
  content=articles,
  content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts(rowid, title, summary, content, tags)
  VALUES (new.id, new.title, new.summary, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, summary, content, tags)
  VALUES ('delete', old.id, old.title, old.summary, old.content, old.tags);
  INSERT INTO articles_fts(rowid, title, summary, content, tags)
  VALUES (new.id, new.title, new.summary, new.content, new.tags);
END;
`;

function migrate(db) {
	const cols = db.pragma("table_info(articles)").map((c) => c.name);
	if (!cols.includes("starred")) {
		db.exec("ALTER TABLE articles ADD COLUMN starred INTEGER DEFAULT 0");
	}
}

export function openDb(dbPath) {
	const db = new Database(dbPath);
	db.pragma("journal_mode = WAL");
	db.exec(SCHEMA);
	migrate(db);
	return db;
}

export function insertArticle(db, article) {
	const stmt = db.prepare(`
    INSERT OR IGNORE INTO articles
      (url, title, author, feed_name, feed_url,
       published_at, fetched_at, summary)
    VALUES
      (@url, @title, @author, @feedName, @feedUrl,
       @publishedAt, @fetchedAt, @summary)
  `);
	const result = stmt.run({
		url: article.url,
		title: article.title,
		author: article.author || null,
		feedName: article.feedName,
		feedUrl: article.feedUrl,
		publishedAt: article.publishedAt,
		fetchedAt: new Date().toISOString(),
		summary: article.summary || null,
	});
	const isNew = result.changes > 0;
	const id = isNew
		? Number(result.lastInsertRowid)
		: db.prepare("SELECT id FROM articles WHERE url = ?").get(article.url).id;
	return { id, isNew };
}

export function getUnscored(db) {
	return db
		.prepare(
			"SELECT * FROM articles WHERE score IS NULL ORDER BY published_at DESC",
		)
		.all();
}

export function writeScores(db, scores) {
	const stmt = db.prepare(`
    UPDATE articles
    SET score = @score, score_reason = @scoreReason, tags = @tags
    WHERE url = @url
  `);
	const tx = db.transaction((items) => {
		for (const item of items) {
			stmt.run({
				url: item.url,
				score: item.score,
				scoreReason: item.scoreReason,
				tags: JSON.stringify(item.tags),
			});
		}
	});
	tx(scores);
}

function escapeFtsQuery(raw) {
	return '"' + raw.replace(/"/g, '""') + '"';
}

export function searchArticles(db, query, limit = 20) {
	return db
		.prepare(
			`SELECT a.*, rank
       FROM articles_fts f
       JOIN articles a ON a.id = f.rowid
       WHERE articles_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
		)
		.all(escapeFtsQuery(query), limit);
}

export function recordFeedback(db, url, signal) {
	const result = db.prepare("UPDATE articles SET feedback = ? WHERE url = ?").run(signal, url);
	return result.changes > 0;
}

export function setStarred(db, url, starred) {
	const result = db.prepare("UPDATE articles SET starred = ? WHERE url = ?").run(
		starred ? 1 : 0,
		url,
	);
	return result.changes > 0;
}

export function getStarred(db) {
	return db
		.prepare("SELECT * FROM articles WHERE starred = 1 ORDER BY score DESC")
		.all();
}

export function getFeedbackStats(db) {
	const ups = db
		.prepare(
			"SELECT * FROM articles WHERE feedback = 'up' ORDER BY published_at DESC",
		)
		.all();
	const downs = db
		.prepare(
			"SELECT * FROM articles WHERE feedback = 'down' ORDER BY published_at DESC",
		)
		.all();
	return { ups, downs };
}

export function getArticlesByDate(db, date, minScore) {
	if (minScore != null) {
		return db
			.prepare(
				`SELECT * FROM articles
         WHERE fetched_at LIKE ? AND score >= ?
         ORDER BY score DESC`,
			)
			.all(`${date}%`, minScore);
	}
	return db
		.prepare(
			`SELECT * FROM articles
       WHERE fetched_at LIKE ?
       ORDER BY score DESC NULLS LAST`,
		)
		.all(`${date}%`);
}
