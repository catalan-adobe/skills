import { readFileSync } from 'node:fs';

const snapshot = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
const header = snapshot.header;
const navItems = snapshot.navItems || [];

function rgbToHex(rgb) {
  if (!rgb) return null;
  const m = rgb.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  const [, r, g, b] = m.map(Number);
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}

function isTransparent(bg) {
  if (!bg) return true;
  if (bg === 'rgba(0, 0, 0, 0)') return true;
  const m = bg.match(/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*([\d.]+)\)/);
  return m && parseFloat(m[1]) === 0;
}

function parsePx(val) {
  if (!val) return 0;
  const m = String(val).match(/([\d.]+)px/);
  return m ? parseFloat(m[1]) : 0;
}

function flattenNodes(node) {
  const result = [node];
  if (node.children) {
    for (const child of node.children) {
      result.push(...flattenNodes(child));
    }
  }
  return result;
}

function colorLuminance(hex) {
  if (!hex) return 0;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function colorSaturation(hex) {
  if (!hex) return 0;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
}

function extractFirstNonTransparentColor(str) {
  if (!str) return null;
  const re = /rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const alpha = m[4] !== undefined ? parseFloat(m[4]) : 1;
    if (alpha > 0) return rgbToHex(m[0]);
  }
  return null;
}

function extractGrayColors(str) {
  const results = [];
  const re = /rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const hex = rgbToHex(m[0]);
    if (hex && hex !== '#000000' && hex !== '#ffffff') {
      results.push(hex);
    }
  }
  return results;
}

const allNodes = flattenNodes(header);

// --- ROWS ---
const topChildren = (header.children || []).filter(c => {
  const rect = c.boundingRect;
  return rect && rect.width > 100 && rect.height > 5;
});

function getRowBg(node) {
  const bg = node.computedStyles?.backgroundColor;
  if (!isTransparent(bg)) return rgbToHex(bg);
  const bgFull = node.computedStyles?.background;
  if (bgFull && bgFull.includes('gradient')) {
    const color = extractFirstNonTransparentColor(bgFull);
    if (color) return color;
  }
  if (node.children) {
    for (const child of node.children) {
      const childBg = child.computedStyles?.backgroundColor;
      if (!isTransparent(childBg)) return rgbToHex(childBg);
    }
  }
  return null;
}

function getHeaderBg() {
  const bg = header.computedStyles?.backgroundColor;
  if (!isTransparent(bg)) return rgbToHex(bg);
  const bgFull = header.computedStyles?.background;
  if (bgFull && bgFull.includes('gradient')) {
    return extractFirstNonTransparentColor(bgFull);
  }
  return null;
}

const rowColors = {};

if (topChildren.length >= 3) {
  rowColors['brand-bar-bg'] = getRowBg(topChildren[0]);
  const midRows = topChildren.slice(1, -1);
  const mainRow = midRows.find(r => !isTransparent(r.computedStyles?.backgroundColor));
  rowColors['main-bar-bg'] = mainRow ? getRowBg(mainRow) : getRowBg(topChildren[1]);
  rowColors['nav-bar-bg'] = getRowBg(topChildren[topChildren.length - 1]);
} else if (topChildren.length === 2) {
  rowColors['main-bar-bg'] = getRowBg(topChildren[0]);
  rowColors['nav-bar-bg'] = getRowBg(topChildren[1]);
} else if (topChildren.length === 1) {
  const child = topChildren[0];
  rowColors['main-bar-bg'] = getRowBg(child);
  const subRows = (child.children || []).filter(c =>
    c.boundingRect && c.boundingRect.width > 100 && c.boundingRect.height > 5,
  );
  if (subRows.length >= 2) {
    rowColors['nav-bar-bg'] = getRowBg(child);
  }
}

if (!rowColors['main-bar-bg']) {
  rowColors['main-bar-bg'] = getHeaderBg() || '#ffffff';
}

// --- NAV LINKS ---
const level1Items = navItems.filter(n => n.level === 1);
const level1Texts = new Set(level1Items.map(n => n.text.trim()));

const navLinkNodes = allNodes.filter(n => {
  if (n.tag !== 'A' || !n.textContent || !level1Texts.has(n.textContent.trim())) return false;
  const classes = (n.classes || []).join(' ').toLowerCase();
  const bg = n.computedStyles?.backgroundColor;
  const hasSolidColorBg = !isTransparent(bg) &&
    rgbToHex(bg) !== '#ffffff' && rgbToHex(bg) !== '#000000';
  if (hasSolidColorBg || classes.includes('cta') || classes.includes('btn')) return false;
  return true;
});

// --- TEXT PRIMARY ---
const textPrimary = rgbToHex(header.computedStyles?.color) || '#000000';

// --- FONTS ---
let fontFamily = 'sans-serif';
let navSize = '16px';
let navWeight = '400';

if (navLinkNodes.length > 0) {
  const first = navLinkNodes[0];
  const ff = first.computedStyles?.fontFamily || '';
  fontFamily = ff.replace(/^["']|["']$/g, '').split(',')[0].trim().replace(/^["']|["']$/g, '');
  navSize = first.computedStyles?.fontSize || '16px';
  navWeight = first.computedStyles?.fontWeight || '400';
} else {
  const ff = header.computedStyles?.fontFamily || '';
  fontFamily = ff.replace(/^["']|["']$/g, '').split(',')[0].trim().replace(/^["']|["']$/g, '');
  navSize = header.computedStyles?.fontSize || '16px';
  navWeight = header.computedStyles?.fontWeight || '400';
}

// --- TEXT LIGHT (muted gray color) ---
const grayColorCandidates = {};

for (const node of allNodes) {
  const color = rgbToHex(node.computedStyles?.color);
  if (color && color !== textPrimary && color !== '#000000' && color !== '#ffffff') {
    const sat = colorSaturation(color);
    if (sat < 0.3) {
      grayColorCandidates[color] = (grayColorCandidates[color] || 0) + 1;
    }
  }
  for (const prop of ['border', 'borderBottom', 'borderTop']) {
    const val = node.computedStyles?.[prop] || '';
    for (const hex of extractGrayColors(val)) {
      const sat = colorSaturation(hex);
      if (sat < 0.3) {
        grayColorCandidates[hex] = (grayColorCandidates[hex] || 0) + 0.5;
      }
    }
  }
}

const bgSet = new Set(Object.values(rowColors).filter(Boolean));
const sortedGrays = Object.entries(grayColorCandidates)
  .filter(([hex]) => !bgSet.has(hex) && hex !== textPrimary)
  .sort((a, b) => b[1] - a[1]);

let textLight = sortedGrays[0]?.[0] || (colorLuminance(textPrimary) > 0.5 ? '#888888' : '#aaaaaa');

// --- ACCENT (distinctive color) ---
let accent = textLight;

const allColorHexes = [];
for (const node of allNodes) {
  const color = rgbToHex(node.computedStyles?.color);
  if (color) allColorHexes.push({ hex: color, type: 'text' });
  const bg = node.computedStyles?.backgroundColor;
  if (bg && !isTransparent(bg)) {
    const hex = rgbToHex(bg);
    if (hex) allColorHexes.push({ hex, type: 'bg' });
  }
}

const skipColors = new Set([textPrimary, '#000000', '#ffffff']);
for (const c of bgSet) skipColors.add(c);

const accentCandidates = {};
for (const { hex, type } of allColorHexes) {
  if (skipColors.has(hex)) continue;
  const sat = colorSaturation(hex);
  const lum = colorLuminance(hex);
  if (lum > 0.02 && lum < 0.98) {
    const score = sat * 10 + (type === 'text' ? 2 : 1);
    accentCandidates[hex] = (accentCandidates[hex] || 0) + score;
  }
}

const sortedAccents = Object.entries(accentCandidates).sort((a, b) => b[1] - a[1]);
if (sortedAccents.length > 0) {
  accent = sortedAccents[0][0];
} else {
  accent = textLight;
}

// --- CTA BUTTON ---
function resolveBackground(node) {
  const bg = node.computedStyles?.backgroundColor;
  if (!isTransparent(bg)) return rgbToHex(bg);
  function findAncestor(root, target, path) {
    if (root === target) return [...path];
    if (root.children) {
      for (const child of root.children) {
        const result = findAncestor(child, target, [...path, root]);
        if (result) return result;
      }
    }
    return null;
  }
  const ancestors = findAncestor(header, node, []) || [];
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const aBg = ancestors[i].computedStyles?.backgroundColor;
    if (!isTransparent(aBg)) return rgbToHex(aBg);
  }
  return rowColors['main-bar-bg'] || '#ffffff';
}

const ctaCandidates = allNodes.filter(n => {
  if (!['A', 'BUTTON'].includes(n.tag) || !n.textContent?.trim()) return false;
  const classes = (n.classes || []).join(' ').toLowerCase();
  const text = n.textContent.trim().toLowerCase();
  const bg = n.computedStyles?.backgroundColor;
  const hasSolidBg = !isTransparent(bg) &&
    rgbToHex(bg) !== '#ffffff' && rgbToHex(bg) !== '#000000';
  const isCtaLike = classes.includes('cta') || classes.includes('btn') ||
    classes.includes('button') || classes.includes('sign') ||
    text.includes('sign up') || text.includes('get started') ||
    text.includes('book') || text.includes('try') ||
    text.includes('search') || text.includes('start');
  return hasSolidBg || isCtaLike;
});

let ctaBg = '#000000';
let ctaText = '#ffffff';
let ctaBorderRadius = '0px';

if (ctaCandidates.length > 0) {
  const scored = ctaCandidates.map(n => {
    const classes = (n.classes || []).join(' ').toLowerCase();
    const bg = n.computedStyles?.backgroundColor;
    let score = 0;
    if (classes.includes('cta')) score += 10;
    if (classes.includes('button') || classes.includes('btn')) score += 5;
    if (!isTransparent(bg)) score += 3;
    const bgHex = rgbToHex(bg);
    if (bgHex && bgHex !== '#ffffff' && bgHex !== '#000000') score += 5;
    return { node: n, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const cta = scored[0].node;
  ctaBg = resolveBackground(cta);
  ctaText = rgbToHex(cta.computedStyles?.color) || '#ffffff';
  ctaBorderRadius = cta.computedStyles?.borderRadius || '0px';
}

// --- SPACING ---
let navGap = 0;

function countDescendantNavLinks(node) {
  let count = 0;
  if (node.tag === 'A' && node.textContent && level1Texts.has(node.textContent.trim())) {
    return 1;
  }
  if (node.children) {
    for (const child of node.children) {
      count += countDescendantNavLinks(child);
    }
  }
  return count;
}

const navGapCandidates = allNodes
  .filter(n => {
    const gap = n.computedStyles?.gap;
    if (!gap || gap === 'normal') return false;
    return countDescendantNavLinks(n) >= 2;
  })
  .map(n => ({ node: n, linkCount: countDescendantNavLinks(n) }))
  .sort((a, b) => b.linkCount - a.linkCount);

if (navGapCandidates.length > 0) {
  navGap = parsePx(navGapCandidates[0].node.computedStyles.gap);
} else if (navLinkNodes.length === 0) {
  const fallbackGapNodes = allNodes
    .filter(n => {
      const gap = n.computedStyles?.gap;
      if (!gap || gap === 'normal') return false;
      const display = n.computedStyles?.display;
      return display === 'flex' || display === 'inline-flex';
    })
    .map(n => {
      const gapStr = n.computedStyles.gap;
      const pxValues = [...gapStr.matchAll(/([\d.]+)px/g)]
        .map(m => parseFloat(m[1]));
      const columnGap = pxValues.length >= 2 ? pxValues[1] : pxValues[0] || 0;
      return { node: n, columnGap };
    })
    .filter(({ columnGap }) => columnGap >= 10)
    .sort((a, b) => b.columnGap - a.columnGap);
  if (fallbackGapNodes.length > 0) {
    navGap = fallbackGapNodes[0].columnGap;
  }
}

let headerPaddingX = 0;
const paddedContainers = allNodes
  .filter(n => {
    const rect = n.boundingRect;
    if (!rect) return false;
    const padR = parsePx(n.computedStyles?.paddingRight);
    const padL = parsePx(n.computedStyles?.paddingLeft);
    return (padR > 0 || padL > 0) && rect.width > 500;
  })
  .sort((a, b) => b.boundingRect.width - a.boundingRect.width);

if (paddedContainers.length > 0) {
  headerPaddingX = parsePx(paddedContainers[0].computedStyles?.paddingLeft) ||
    parsePx(paddedContainers[0].computedStyles?.paddingRight);
}

// --- DECORATIONS ---
let gradientUnderline = false;
for (const node of allNodes) {
  const bg = node.computedStyles?.background || '';
  const bgImage = node.computedStyles?.backgroundImage || '';
  if (bg.includes('gradient') || bgImage.includes('gradient')) {
    const rect = node.boundingRect;
    if (rect && rect.height < 20 && rect.width > 10) {
      gradientUnderline = true;
      break;
    }
    if (rect && rect.width < header.boundingRect.width * 0.8) {
      gradientUnderline = true;
      break;
    }
  }
  const border = node.computedStyles?.border;
  if (border === '' && node.boundingRect) {
    const bb = node.computedStyles?.borderBottom || '';
    const isWide = node.boundingRect.width >= header.boundingRect.width * 0.8;
    if (isWide && bb.startsWith('0px')) {
      gradientUnderline = true;
      break;
    }
  }
}

// --- ASSEMBLE ---
const colors = { ...rowColors };
colors['text-primary'] = textPrimary;
colors['text-light'] = textLight;
colors['accent'] = accent;
colors['cta-bg'] = ctaBg;
colors['cta-text'] = ctaText;

const result = {
  colors,
  fonts: {
    family: fontFamily,
    'nav-size': navSize,
    'nav-weight': navWeight,
  },
  spacing: {
    'nav-gap': `${navGap}px`,
    'header-padding-x': `${headerPaddingX}px`,
  },
  decorations: {
    'gradient-underline': gradientUnderline,
    'cta-border-radius': ctaBorderRadius,
  },
};

console.log(JSON.stringify(result, null, 2));
