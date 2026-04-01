#!/usr/bin/env node

/**
 * font-install — Resolve detected fonts and install them in an EDS project.
 *
 * 5-step resolution cascade per font:
 *   1. System font → skip (no delivery needed)
 *   2. Already in Typekit kit → use Typekit
 *   3. In Adobe Fonts library → add to kit, publish, use Typekit
 *   4. In Google Fonts → use Google Fonts delivery
 *   5. Not found → warn, no delivery
 *
 * Usage:
 *   node font-install.js --detected=fonts-detected.json --kit=<kitId> \
 *     --head-html=<path> [--token=<typekitToken>] [--dry-run]
 *
 * Outputs resolution summary as JSON to stdout.
 * Updates head.html in-place (unless --dry-run).
 */

import { readFileSync, writeFileSync } from 'node:fs';

const TYPEKIT_API = 'https://typekit.com/api/v1/json';
const GOOGLE_FONTS_CSS = 'https://fonts.googleapis.com/css2';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ── System font list (from vibemigration typekitClient.ts) ──────── */

const SYSTEM_FONTS = new Set([
  'arial', 'arial black', 'comic sans ms', 'courier new', 'georgia',
  'helvetica', 'helvetica neue', 'impact', 'lucida console',
  'lucida grande', 'lucida sans unicode', 'palatino linotype',
  'segoe ui', 'tahoma', 'times new roman', 'times', 'trebuchet ms',
  'verdana', 'system-ui', 'sans-serif', 'serif', 'monospace',
  'cursive', 'fantasy', 'ui-sans-serif', 'ui-serif', 'ui-monospace',
  'ui-rounded', '-apple-system', 'blinkmacsystemfont', 'sf pro',
  'sf pro display', 'sf pro text', 'sf mono', 'new york', 'roboto',
  'noto sans', 'open sans', 'segoe ui variable',
]);

function isSystemFont(name) {
  return SYSTEM_FONTS.has(name.toLowerCase().replace(/['"]/g, '').trim());
}

function toSlug(name) {
  return name.toLowerCase().replace(/['"]/g, '').trim().replace(/\s+/g, '-');
}

/* ── Typekit API ─────────────────────────────────────────────────── */

async function fetchKitFamilies(kitId) {
  const resp = await fetch(`${TYPEKIT_API}/kits/${kitId}/published`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!resp.ok) {
    process.stderr.write(`Typekit kit fetch failed: ${resp.status}\n`);
    return [];
  }
  const data = await resp.json();
  return (data.kit?.families ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    slug: f.slug,
    cssNames: f.css_names ?? [],
    cssStack: f.css_stack ?? '',
  }));
}

async function fetchFontMetadata(slug) {
  const resp = await fetch(`${TYPEKIT_API}/families/${slug}`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.family ?? null;
}

async function addFontToKit(kitId, familyId, token) {
  const resp = await fetch(
    `${TYPEKIT_API}/kits/${kitId}/families/${familyId}`,
    {
      method: 'POST',
      headers: { 'X-Typekit-Token': token },
    },
  );
  if (!resp.ok) {
    throw new Error(`Add font to kit failed: ${resp.status}`);
  }
  return resp.json();
}

async function publishKit(kitId, token) {
  const resp = await fetch(`${TYPEKIT_API}/kits/${kitId}/publish`, {
    method: 'POST',
    headers: { 'X-Typekit-Token': token },
  });
  if (!resp.ok) {
    throw new Error(`Kit publish failed: ${resp.status}`);
  }
  return resp.json();
}

/* ── Google Fonts check ──────────────────────────────────────────── */

async function checkGoogleFonts(family) {
  const encoded = family.replace(/['"]/g, '').trim();
  const url = `${GOOGLE_FONTS_CSS}?family=${encodeURIComponent(encoded)}:wght@400;700&display=swap`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!resp.ok) return null;
  const body = await resp.text();
  // Gotcha: 200 with no @font-face means weight not available
  if (!body.includes('@font-face')) return null;
  return { url, cssFamily: `"${encoded}", sans-serif` };
}

/* ── 5-Step Resolution Cascade ───────────────────────────────────── */

async function resolveFont(family, kitId, kitFamilies, token, dryRun) {
  const normalized = family.toLowerCase().replace(/['"]/g, '').trim();
  const slug = toSlug(family);

  // Step 1: System font
  if (isSystemFont(family)) {
    return { family, resolution: 'system', delivery: null };
  }

  // Step 2: Already in Typekit kit
  const kitMatch = kitFamilies.find(
    (f) => f.name.toLowerCase() === normalized || f.slug === slug,
  );
  if (kitMatch) {
    return {
      family,
      resolution: 'in-kit',
      delivery: 'typekit',
      kitFamily: kitMatch.name,
      cssStack: kitMatch.cssStack,
    };
  }

  // Step 3: Available in Adobe Fonts library
  const metadata = await fetchFontMetadata(slug);
  if (metadata) {
    if (token && !dryRun) {
      try {
        await addFontToKit(kitId, metadata.id, token);
        process.stderr.write(`Added "${family}" to kit ${kitId}\n`);
        return {
          family,
          resolution: 'added-to-kit',
          delivery: 'typekit',
          adobeFontsId: metadata.id,
          adobeFontsSlug: slug,
        };
      } catch (err) {
        process.stderr.write(
          `Failed to add "${family}" to kit: ${err.message}\n`,
        );
      }
    } else if (token && dryRun) {
      return {
        family,
        resolution: 'would-add-to-kit',
        delivery: 'typekit',
        adobeFontsId: metadata.id,
        adobeFontsSlug: slug,
      };
    } else {
      process.stderr.write(
        `"${family}" available in Adobe Fonts but no API token. ` +
        'Set ADOBE_FONTS_API_TOKEN to auto-add.\n',
      );
    }
  }

  // Step 4: Google Fonts
  try {
    const gf = await checkGoogleFonts(family);
    if (gf) {
      return {
        family,
        resolution: 'google-fonts',
        delivery: 'google-fonts',
        googleFontsUrl: gf.url,
        cssFamily: gf.cssFamily,
      };
    }
  } catch (err) {
    process.stderr.write(`Google Fonts check failed: ${err.message}\n`);
  }

  // Step 5: Not found
  return { family, resolution: 'not-found', delivery: null };
}

/* ── head.html update ────────────────────────────────────────────── */

function updateHeadHtml(headHtmlPath, kitId, resolutions) {
  let html = readFileSync(headHtmlPath, 'utf-8');

  const typekitUrl = `https://use.typekit.net/${kitId}.css`;
  const needsTypekit = resolutions.some(
    (r) => r.delivery === 'typekit',
  );
  const googleUrls = resolutions
    .filter((r) => r.delivery === 'google-fonts' && r.googleFontsUrl)
    .map((r) => r.googleFontsUrl);

  let additions = '';

  // Typekit embed
  if (needsTypekit && !html.includes(typekitUrl)) {
    additions += `<link rel="stylesheet" href="${typekitUrl}">\n`;
  }

  // Google Fonts embeds
  if (googleUrls.length > 0) {
    if (!html.includes('fonts.googleapis.com')) {
      additions += '<link rel="preconnect" href="https://fonts.googleapis.com">\n';
      additions += '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n';
    }
    for (const gfUrl of googleUrls) {
      if (!html.includes(gfUrl)) {
        additions += `<link href="${gfUrl}" rel="stylesheet">\n`;
      }
    }
  }

  if (!additions) return false;

  // Insert before first <script> or <link> tag
  const insertPoint = html.search(/<(script|link)\b/i);
  if (insertPoint !== -1) {
    html = html.slice(0, insertPoint) + additions + html.slice(insertPoint);
  } else {
    html += additions;
  }

  writeFileSync(headHtmlPath, html);
  return true;
}

/* ── CLI ─────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const result = { detected: null, kit: null, headHtml: null, token: null, dryRun: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--detected=')) result.detected = arg.split('=').slice(1).join('=');
    if (arg.startsWith('--kit=')) result.kit = arg.split('=')[1];
    if (arg.startsWith('--head-html=')) result.headHtml = arg.split('=').slice(1).join('=');
    if (arg.startsWith('--token=')) result.token = arg.split('=').slice(1).join('=');
    if (arg === '--dry-run') result.dryRun = true;
  }
  result.token = result.token || process.env.ADOBE_FONTS_API_TOKEN || null;
  return result;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.detected) {
    process.stderr.write(
      'Usage: node font-install.js --detected=fonts-detected.json ' +
      '--kit=<kitId> --head-html=<path> [--token=<token>] [--dry-run]\n',
    );
    process.exit(1);
  }

  let detected;
  try {
    detected = JSON.parse(readFileSync(args.detected, 'utf-8'));
  } catch (err) {
    process.stderr.write(`Failed to read ${args.detected}: ${err.message}\n`);
    process.exit(1);
  }

  // Determine kit ID: --kit flag > detected source > default
  const kitId = args.kit
    || detected.sources?.typekit?.kitId
    || 'cwm0xxe';

  process.stderr.write(`Using Typekit kit: ${kitId}\n`);
  if (args.dryRun) process.stderr.write('DRY RUN — no mutations\n');

  // Fetch current kit families
  const kitFamilies = await fetchKitFamilies(kitId);
  process.stderr.write(`Kit has ${kitFamilies.length} families\n`);

  // Resolve body + heading fonts
  const bodyResult = await resolveFont(
    detected.fonts?.body?.family || '',
    kitId, kitFamilies, args.token, args.dryRun,
  );
  process.stderr.write(
    `Body "${bodyResult.family}": ${bodyResult.resolution}\n`,
  );

  let headingResult;
  const headingFamily = detected.fonts?.heading?.family || '';
  if (
    headingFamily &&
    headingFamily.toLowerCase() !== (bodyResult.family || '').toLowerCase()
  ) {
    headingResult = await resolveFont(
      headingFamily, kitId, kitFamilies, args.token, args.dryRun,
    );
    process.stderr.write(
      `Heading "${headingResult.family}": ${headingResult.resolution}\n`,
    );
  } else {
    headingResult = { family: headingFamily, resolution: 'same-as-body' };
    process.stderr.write('Heading: same as body\n');
  }

  // Publish kit if any fonts were added
  const addedFonts = [bodyResult, headingResult].filter(
    (r) => r.resolution === 'added-to-kit',
  );
  let published = false;
  if (addedFonts.length > 0 && args.token && !args.dryRun) {
    try {
      await publishKit(kitId, args.token);
      published = true;
      process.stderr.write(`Published kit ${kitId}\n`);
    } catch (err) {
      process.stderr.write(`Kit publish failed: ${err.message}\n`);
    }
  }

  // Update head.html
  let headUpdated = false;
  if (args.headHtml && !args.dryRun) {
    headUpdated = updateHeadHtml(
      args.headHtml, kitId, [bodyResult, headingResult],
    );
    if (headUpdated) {
      process.stderr.write(`Updated ${args.headHtml}\n`);
    } else {
      process.stderr.write('head.html already up to date\n');
    }
  }

  // Output summary
  const summary = {
    kitId,
    body: bodyResult,
    heading: headingResult,
    headHtmlUpdated: headUpdated,
    typekitPublished: published,
    dryRun: args.dryRun,
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`Font installation failed: ${err.message}\n`);
  process.exit(1);
});
