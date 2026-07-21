import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const FETCH_MOD = path.resolve(
	import.meta.dirname,
	"../../skills/rss-curation/scripts/fetch.mjs",
);

async function loadFetch() {
	return import(`${FETCH_MOD}?t=${Date.now()}`);
}

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Blog</title>
    <item>
      <title>First Post</title>
      <link>https://blog.example.com/first</link>
      <pubDate>Mon, 21 Jul 2025 10:00:00 GMT</pubDate>
      <description>This is the first post summary.</description>
      <author>alice@example.com (Alice)</author>
    </item>
    <item>
      <title>Second Post</title>
      <link>https://blog.example.com/second</link>
      <pubDate>Mon, 21 Jul 2025 11:00:00 GMT</pubDate>
      <description>This is the second post summary.</description>
    </item>
  </channel>
</rss>`;

const RDF_SAMPLE = `<?xml version="1.0" encoding="ISO-8859-1"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
  xmlns="http://purl.org/rss/1.0/"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://slashdot.org/">
    <title>Slashdot</title>
  </channel>
  <item rdf:about="https://slashdot.org/story/1">
    <title>Linux 7.0 Released</title>
    <link>https://slashdot.org/story/1</link>
    <description>Linux 7.0 has been released.</description>
    <dc:creator>editor</dc:creator>
    <dc:date>2025-07-21T10:00:00+00:00</dc:date>
  </item>
</rdf:RDF>`;

const ATOM_TYPED_TITLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title type="html">Bombacat</title>
    <link href="https://octodex.github.com/bombacat"/>
    <summary>A cute octocat.</summary>
  </entry>
</feed>`;

const ATOM_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Blog</title>
  <entry>
    <title>Atom Post</title>
    <link href="https://atom.example.com/post-1"/>
    <published>2025-07-21T12:00:00Z</published>
    <summary>An atom post summary.</summary>
    <author><name>Bob</name></author>
  </entry>
</feed>`;

describe("parseFeed", () => {
	it("parses RSS 2.0 items", async () => {
		const { parseFeed } = await loadFetch();
		const articles = parseFeed(
			RSS_SAMPLE,
			"Test Blog",
			"https://blog.example.com/rss",
		);
		assert.equal(articles.length, 2);
		assert.equal(articles[0].title, "First Post");
		assert.equal(articles[0].url, "https://blog.example.com/first");
		assert.ok(articles[0].publishedAt);
		assert.equal(articles[0].summary, "This is the first post summary.");
		assert.equal(articles[0].feedName, "Test Blog");
	});

	it("parses Atom feeds", async () => {
		const { parseFeed } = await loadFetch();
		const articles = parseFeed(
			ATOM_SAMPLE,
			"Atom Blog",
			"https://atom.example.com/feed",
		);
		assert.equal(articles.length, 1);
		assert.equal(articles[0].title, "Atom Post");
		assert.equal(articles[0].url, "https://atom.example.com/post-1");
		assert.equal(articles[0].summary, "An atom post summary.");
	});

	it("returns empty array for invalid XML", async () => {
		const { parseFeed } = await loadFetch();
		const articles = parseFeed("not xml", "Bad", "https://bad.com/rss");
		assert.equal(articles.length, 0);
	});

	it("parses RSS 1.0 (RDF) feeds like Slashdot", async () => {
		const { parseFeed } = await loadFetch();
		const articles = parseFeed(RDF_SAMPLE, "Slashdot", "https://slashdot.org/rss");
		assert.equal(articles.length, 1);
		assert.equal(articles[0].title, "Linux 7.0 Released");
		assert.equal(articles[0].url, "https://slashdot.org/story/1");
		assert.equal(articles[0].author, "editor");
	});

	it("handles Atom entries with typed titles", async () => {
		const { parseFeed } = await loadFetch();
		const articles = parseFeed(ATOM_TYPED_TITLE, "Octocats", "https://octodex.github.com/atom.xml");
		assert.equal(articles.length, 1);
		assert.equal(articles[0].title, "Bombacat");
	});
});
