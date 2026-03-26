#!/usr/bin/env node
import { parseHTML } from 'linkedom';
import Defuddle from 'defuddle';

const ARTICLE_TIMEOUT_MS = 60_000;

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
