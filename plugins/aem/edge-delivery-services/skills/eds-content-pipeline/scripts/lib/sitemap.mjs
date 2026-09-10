const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'",
};
const decodeEntities = (text) => text.replace(/&(amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m]);

/**
 * Parses a sitemap index or urlset. Regex-based on purpose: sitemaps are flat and this avoids
 * an XML dependency.
 *
 * @param {string} xml
 * @returns {{kind: 'index' | 'urlset', entries: {loc: string, lastmod: string | null}[]}}
 */
export function parseSitemap(xml) {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const tag = isIndex ? 'sitemap' : 'url';
  const blockRe = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi');
  const entries = [];
  for (const match of xml.matchAll(blockRe)) {
    const block = match[1];
    const loc = /<loc>\s*([^<]+?)\s*<\/loc>/i.exec(block)?.[1];
    const lastmod = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i.exec(block)?.[1] ?? null;
    if (loc) entries.push({ loc: decodeEntities(loc.trim()), lastmod });
  }
  return { kind: isIndex ? 'index' : 'urlset', entries };
}

/**
 * Derives the Yoast-style content type from a sitemap file name.
 * Handles dotted enterprise names: corporate.sitemap-doctors.xml → doctors
 * @param {string} sitemapUrl e.g. https://x.test/post-sitemap.xml
 * @returns {string} e.g. "post"
 */
export function sitemapTypeFromUrl(sitemapUrl) {
  const file = new URL(sitemapUrl).pathname.split('/').pop() ?? '';
  // dotted enterprise: corporate.sitemap-doctors.xml → doctors
  const dotted =
    /^(?<prefix>[^.]+)\.sitemap(?:-(?<type>[a-z0-9-]+))?\.xml$/i.exec(
      file
    );
  if (dotted) return dotted.groups.type ?? dotted.groups.prefix;
  return file.replace(/-sitemap\d*\.xml$/i, '').replace(/\.xml$/i, '');
}

/**
 * Resolves a sitemap index of any depth to the set of urlset sitemaps.
 * Recursively follows sitemapindex entries, deduplicating visited URLs.
 * @param {{text: (url: string) => Promise<string>}} client HTTP client
 * @param {string} indexUrl root sitemapindex URL
 * @param {{maxDepth: number}} options depth limit (default 3)
 * @returns {Promise<string[]>} array of urlset sitemap URLs
 */
export async function collectSitemaps(
  client,
  indexUrl,
  { maxDepth = 3 } = {}
) {
  const urlsets = new Set();
  const seen = new Set();
  const visit = async (url, depth) => {
    if (seen.has(url) || depth > maxDepth) return;
    seen.add(url);
    const parsed = parseSitemap(await client.text(url));
    if (parsed.kind === 'urlset') {
      urlsets.add(url);
      return;
    }
    for (const entry of parsed.entries) await visit(entry.loc, depth + 1);
  };
  await visit(indexUrl, 0);
  return [...urlsets];
}
