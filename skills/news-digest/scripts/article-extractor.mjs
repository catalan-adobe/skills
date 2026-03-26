#!/usr/bin/env node
import { parseHTML } from 'linkedom';
import Defuddle from 'defuddle';

const ARTICLE_TIMEOUT_MS = 60_000;
const GOOGLE_NEWS_HOST = 'news.google.com';
const BATCHEXECUTE_URL = 'https://news.google.com/_/DotsSplashUi/data/batchexecute';

const VIDEO_DOMAINS = [
  'youtube.com', 'youtube-nocookie.com', 'youtu.be',
  'vimeo.com', 'dailymotion.com', 'dai.ly',
];

const AD_TRACKER_PATTERNS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'facebook.net', 'amazon-adsystem.com', 'adnxs.com',
  'taboola.com', 'outbrain.com', 'pixel.', 'tracking.',
];

const PAYWALL_MARKERS = [
  'subscribe to read', 'subscription required', 'premium content',
  'paywall', 'sign in to read', 'create an account to read',
  'free trial', 'become a member', 'for subscribers only',
];

function isAdImage(src) {
  const lower = src.toLowerCase();
  return AD_TRACKER_PATTERNS.some((p) => lower.includes(p));
}

function isVideoEmbed(src) {
  const lower = src.toLowerCase();
  return VIDEO_DOMAINS.some((d) => lower.includes(d));
}

function extractImages(document) {
  const imgs = [...document.querySelectorAll('img[src]')];
  return imgs
    .filter((img) => {
      const src = img.getAttribute('src') || '';
      if (isAdImage(src)) return false;
      const width = parseInt(img.getAttribute('width') || '0', 10);
      const height = parseInt(img.getAttribute('height') || '0', 10);
      if (width > 0 && width < 200) return false;
      if (height > 0 && height < 200) return false;
      return true;
    })
    .map((img) => ({
      src: img.getAttribute('src'),
      alt: img.getAttribute('alt') || '',
    }));
}

function extractVideos(document) {
  const iframes = [...document.querySelectorAll('iframe[src]')];
  return iframes
    .filter((iframe) => isVideoEmbed(iframe.getAttribute('src') || ''))
    .map((iframe) => {
      const src = iframe.getAttribute('src');
      const domain = VIDEO_DOMAINS.find((d) => src.toLowerCase().includes(d));
      return { src, domain };
    });
}

function detectPaywall(document, content) {
  if (content && content.length >= 200) return false;
  const text = document.body?.textContent?.toLowerCase() || '';
  return PAYWALL_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Resolves a Google News RSS/article URL to the real article URL by calling
 * the batchexecute RPC endpoint (reverse-engineered from google-news-decoder).
 *
 * @param {string} url - A news.google.com URL (rss/articles or articles path)
 * @returns {Promise<string>} The decoded article URL
 * @throws {Error} If decoding fails at any step
 */
async function decodeGoogleNewsUrl(url) {
  const parsed = new URL(url);

  // Extract the article ID — the last non-empty path segment
  const articleId = parsed.pathname.split('/').filter(Boolean).at(-1);
  if (!articleId) throw new Error(`Cannot extract article ID from path: ${parsed.pathname}`);

  // Fetch the interstitial page to get signature and timestamp
  const interstitialUrl = `https://${GOOGLE_NEWS_HOST}/articles/${articleId}`;
  const interstitialRes = await fetch(interstitialUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        + 'AppleWebKit/537.36 (KHTML, like Gecko) '
        + 'Chrome/124.0.0.0 Safari/537.36',
    },
  });

  if (!interstitialRes.ok) {
    throw new Error(`Interstitial fetch returned HTTP ${interstitialRes.status}`);
  }

  const interstitialHtml = await interstitialRes.text();
  const { document: interstitialDoc } = parseHTML(interstitialHtml);

  // data-n-a-sg (signature) and data-n-a-ts (timestamp) live on a c-wiz > div[jscontroller]
  const dataEl = interstitialDoc.querySelector('c-wiz > div[jscontroller]');
  const signature = dataEl?.getAttribute('data-n-a-sg');
  const timestamp = dataEl?.getAttribute('data-n-a-ts');

  if (!signature || !timestamp) {
    throw new Error(
      `data-n-a-sg / data-n-a-ts not found in interstitial page for ${articleId}`,
    );
  }

  // Build batchexecute RPC payload
  const payload = [
    'Fbv4je',
    `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${articleId}",${timestamp},"${signature}"]`,
  ];
  const body = `f.req=${encodeURIComponent(JSON.stringify([[payload]]))}`;

  const rpcRes = await fetch(BATCHEXECUTE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        + 'AppleWebKit/537.36 (KHTML, like Gecko) '
        + 'Chrome/124.0.0.0 Safari/537.36',
    },
    body,
  });

  if (!rpcRes.ok) {
    throw new Error(`batchexecute returned HTTP ${rpcRes.status}`);
  }

  const responseText = await rpcRes.text();

  // Response is XSSI-protected: first line is `)]}'`, real JSON starts after first blank line
  const jsonPart = responseText.split('\n\n')[1];
  if (!jsonPart) throw new Error('Unexpected batchexecute response format (no double-newline)');

  const decodedUrl = JSON.parse(JSON.parse(jsonPart)[0][2])[1];
  if (typeof decodedUrl !== 'string' || !decodedUrl.startsWith('http')) {
    throw new Error(`Decoded URL looks invalid: ${String(decodedUrl).slice(0, 80)}`);
  }

  return decodedUrl;
}

export async function extractArticle(url) {
  const result = {
    resolvedUrl: null,
    content: null,
    paywall: false,
    images: [],
    videos: [],
    error: null,
  };

  // Decode Google News interstitial URLs before fetching the real article
  let fetchUrl = url;
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname === GOOGLE_NEWS_HOST) {
      fetchUrl = await decodeGoogleNewsUrl(url);
    }
  } catch (err) {
    result.error = `Google News URL decoding failed for ${url}: ${err.message}`;
    return result;
  }

  let res;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      ARTICLE_TIMEOUT_MS,
    );
    res = await fetch(fetchUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
          + 'AppleWebKit/537.36 (KHTML, like Gecko) '
          + 'Chrome/124.0.0.0 Safari/537.36',
      },
    });
    clearTimeout(timeout);
  } catch (err) {
    if (err.name === 'AbortError') {
      result.error = `Timeout after ${ARTICLE_TIMEOUT_MS / 1000}s fetching ${fetchUrl}`;
    } else {
      result.error = `Fetch failed for ${fetchUrl}: ${err.message}`;
    }
    return result;
  }

  result.resolvedUrl = res.url;

  if (res.status === 402 || res.status === 403) {
    result.paywall = true;
    result.error = `HTTP ${res.status} from ${res.url}`;
    return result;
  }

  if (!res.ok) {
    result.error = `HTTP ${res.status} from ${res.url}`;
    return result;
  }

  let html;
  try {
    html = await res.text();
  } catch (err) {
    result.error = `Failed to read response body from ${res.url}: ${err.message}`;
    return result;
  }

  try {
    const { document } = parseHTML(html);
    const extracted = new Defuddle(document).parse();

    result.content = extracted?.content || null;
    result.images = extractImages(document);
    result.videos = extractVideos(document);
    result.paywall = detectPaywall(document, result.content);
  } catch (err) {
    result.error = `Extraction failed for ${res.url}: ${err.message}`;
  }

  return result;
}
