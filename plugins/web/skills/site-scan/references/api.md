# site-scan API Reference

## Options Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `strategy` | `'sitemaps'` \| `'http'` | `'sitemaps'` | Crawl strategy |
| `timeout` | `number` | `10000` | Fetch timeout per request (ms) |
| `workers` | `number` | `1` | Concurrent queue workers |
| `sameDomain` | `boolean` | `true` | Only keep URLs from the same origin |
| `inclusionPatterns` | `string[]` | `[]` | Glob patterns — only matching URLs are kept |
| `exclusionPatterns` | `string[]` | `[]` | Glob patterns — matching URLs are rejected |
| `limit` | `number` | `-1` | Max valid URLs to collect (`-1` = unlimited) |
| `keepHash` | `boolean` | `true` | Preserve URL hash fragments |
| `userAgent` | `string` | `null` | Custom User-Agent header |
| `httpHeaders` | `Record<string, string>` | `null` | Additional HTTP headers |
| `urlStreamFn` | `(urls: URLExtended[]) => Promise<void>` | no-op | Callback invoked with each batch of qualified URLs |

## URLExtended Shape

Each entry passed to `urlStreamFn` has this shape:

```ts
{
  url: string,       // the qualified URL
  origin: string,    // the page/sitemap it was found in
  status: string,    // 'valid' | 'excluded' | 'error'
  level1: string,    // first path segment (e.g. 'blog')
  level2: string,    // second path segment
  level3: string,    // third path segment
  filename: string,  // last path segment
  search: string,    // query string
  lang: string,      // IETF language tag detected from URL path (e.g. 'fr-FR')
  message: string,   // reason when status is 'excluded' or 'error'
}
```

## CrawlResult Shape

`crawl()` resolves with:

```ts
{
  originURL: string,
  errors: { url: string, message: string }[],
  urls: { total: number, valid: number },
  robotstxt: string | null,   // raw robots.txt content if found
  sitemaps: string[],          // sitemap URLs discovered
  languages: string[],
}
```
