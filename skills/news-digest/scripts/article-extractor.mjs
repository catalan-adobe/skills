#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { parseHTML } from 'linkedom';
import Defuddle from 'defuddle';

const ARTICLE_TIMEOUT_MS = 60_000;
const PLAYWRIGHT_CLI = 'playwright-cli';
const SESSION_NAME = 'news-digest';
const GOOGLE_NEWS_HOST = 'news.google.com';

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pwcli(...args) {
  try {
    const output = execFileSync(PLAYWRIGHT_CLI, [`-s=${SESSION_NAME}`, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    return output;
  } catch (err) {
    return err.stdout || '';
  }
}

function extractResult(output) {
  const match = output.match(/### Result\n"(.+)"/);
  return match ? match[1] : null;
}

/**
 * Batch-decodes Google News URLs using a playwright-cli browser session.
 * Sets `resolvedUrl` on each story object in-place.
 *
 * @param {Array<{url: string}>} stories - Stories whose URLs may be Google News links
 * @returns {Promise<Array>} The same stories array with `resolvedUrl` populated
 */
export async function decodeGoogleNewsUrls(stories) {
  const googleStories = stories.filter((s) => {
    try {
      return new URL(s.url).hostname === GOOGLE_NEWS_HOST;
    } catch {
      return false;
    }
  });

  if (googleStories.length === 0) return stories;

  pwcli('open');

  // Handle Google consent page on first navigation
  const firstUrl = googleStories[0].url;
  pwcli('goto', firstUrl);
  const locationAfterFirst = extractResult(pwcli('eval', 'window.location.href'));
  if (locationAfterFirst && locationAfterFirst.includes('consent.google.com')) {
    pwcli('eval', 'void(document.querySelector("form[action*=consent] button").click())');
    await sleep(2_000);
  }

  for (let i = 0; i < googleStories.length; i++) {
    const story = googleStories[i];

    // First story was already navigated to above; navigate others
    if (i > 0) {
      pwcli('goto', story.url);
    }

    await sleep(3_000);

    let href = extractResult(pwcli('eval', 'window.location.href'));

    if (href && href.includes(GOOGLE_NEWS_HOST)) {
      await sleep(3_000);
      href = extractResult(pwcli('eval', 'window.location.href'));
    }

    if (href && !href.includes(GOOGLE_NEWS_HOST)) {
      story.resolvedUrl = href;
    } else {
      story.resolvedUrl = null;
    }

    if (i < googleStories.length - 1) {
      await sleep(2_000);
    }
  }

  pwcli('close');

  // Pass through non-Google stories with their URL as resolvedUrl
  for (const story of stories) {
    if (!Object.prototype.hasOwnProperty.call(story, 'resolvedUrl')) {
      story.resolvedUrl = story.url;
    }
  }

  return stories;
}

/**
 * Fetches and extracts article content from a real (non-Google-News) URL.
 *
 * @param {string} url - A direct article URL (already decoded if from Google News)
 * @returns {Promise<object>} Extracted article data
 */
export async function extractArticle(url) {
  const result = {
    resolvedUrl: null,
    content: null,
    paywall: false,
    images: [],
    videos: [],
    error: null,
  };

  let res;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      ARTICLE_TIMEOUT_MS,
    );
    res = await fetch(url, {
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
      result.error = `Timeout after ${ARTICLE_TIMEOUT_MS / 1000}s fetching ${url}`;
    } else {
      result.error = `Fetch failed for ${url}: ${err.message}`;
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
