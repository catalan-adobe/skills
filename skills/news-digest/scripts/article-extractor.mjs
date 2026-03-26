#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const PLAYWRIGHT_CLI = 'playwright-cli';
const SESSION_NAME = 'news-digest';
const GOOGLE_NEWS_HOST = 'news.google.com';

const PAYWALL_MARKERS = [
  'subscribe to read', 'subscription required', 'premium content',
  'paywall', 'sign in to read', 'create an account to read',
  'free trial', 'become a member', 'for subscribers only',
];

function detectPaywall(text) {
  if (text && text.length >= 200) return false;
  const lower = (text || '').toLowerCase();
  return PAYWALL_MARKERS.some((marker) => lower.includes(marker));
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
  const match = output.match(/### Result\n"(.+)"/s);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

function extractJsonResult(output) {
  const match = output.match(/### Result\n(.+)/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch {
    return null;
  }
}

const IMAGES_EVAL = [
  'JSON.stringify([...document.querySelectorAll("img[src]")]',
  '.filter(i => {',
  '  const w = parseInt(i.width||0); const h = parseInt(i.height||0);',
  '  return !i.src.match(/doubleclick|googlesyndication|adnxs|taboola|outbrain|pixel|tracking/i)',
  '    && !(w > 0 && w < 200) && !(h > 0 && h < 200);',
  '}).slice(0, 5).map(i => ({src: i.src, alt: i.alt||""})))',
].join(' ');

const VIDEOS_EVAL = [
  'JSON.stringify([...document.querySelectorAll("iframe[src]")]',
  '.filter(i => i.src.match(/youtube|vimeo|dailymotion/i))',
  '.map(i => ({src: i.src, domain: i.src.match(/(youtube|vimeo|dailymotion)[^/]*/i)?.[0]||""})))',
].join(' ');

/**
 * Fetches all articles using a single playwright-cli browser session.
 * Navigates to each Google News URL, waits for redirect, then extracts
 * content directly from the rendered page.
 *
 * @param {Array<{url: string}>} stories - Stories to process
 * @returns {Promise<Array>} Stories with resolvedUrl, content, images, videos, paywall, error
 */
export async function fetchAllArticles(stories) {
  const googleStories = stories.filter((s) => {
    try {
      return new URL(s.url).hostname === GOOGLE_NEWS_HOST;
    } catch {
      return false;
    }
  });

  // Non-Google stories get their URL passed through
  for (const story of stories) {
    try {
      if (new URL(story.url).hostname !== GOOGLE_NEWS_HOST) {
        story.resolvedUrl = story.url;
        story.content = null;
        story.paywall = false;
        story.images = [];
        story.videos = [];
        story.error = 'Non-Google News URL: browser extraction skipped';
      }
    } catch {
      story.resolvedUrl = null;
      story.content = null;
      story.paywall = false;
      story.images = [];
      story.videos = [];
      story.error = 'Invalid URL';
    }
  }

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

    if (!href || href.includes(GOOGLE_NEWS_HOST)) {
      story.resolvedUrl = null;
      story.content = null;
      story.paywall = false;
      story.images = [];
      story.videos = [];
      story.error = 'Redirect failed: still on Google News';
      if (i < googleStories.length - 1) await sleep(2_000);
      continue;
    }

    story.resolvedUrl = href;

    // Wait for article content to fully render
    await sleep(2_000);

    // Extract plain text content (smaller payload, no HTML parsing needed)
    const textOutput = pwcli('eval', 'document.body.innerText');
    const text = extractResult(textOutput);
    story.content = text ? text.trim() || null : null;

    // Extract images
    const imagesOutput = pwcli('eval', IMAGES_EVAL);
    story.images = extractJsonResult(imagesOutput) || [];

    // Extract videos
    const videosOutput = pwcli('eval', VIDEOS_EVAL);
    story.videos = extractJsonResult(videosOutput) || [];

    story.paywall = detectPaywall(story.content);
    story.error = null;

    if (i < googleStories.length - 1) {
      await sleep(2_000);
    }
  }

  pwcli('close');

  return stories;
}
