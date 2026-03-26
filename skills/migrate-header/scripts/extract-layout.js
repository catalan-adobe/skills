import { readFileSync } from 'node:fs';

const snapshot = JSON.parse(readFileSync(process.argv[2], 'utf-8'));
const header = snapshot.header;
const navItemsRaw = snapshot.navItems || [];

const headerHeight = header.boundingRect?.height || 0;
const rows = identifyRows(header);
const navItems = classifyNavItems(navItemsRaw, rows);

console.log(JSON.stringify({ headerHeight, rows, navItems }, null, 2));

function identifyRows(headerNode) {
  const directChildren = (headerNode.children || []).filter(
    (c) => (c.boundingRect?.height || 0) > 15,
  );

  let rowNodes;
  if (directChildren.length === 1) {
    rowNodes = findVisualRows(directChildren[0]);
  } else {
    rowNodes = directChildren;
  }

  return rowNodes.map((node) => ({
    role: classifyRowRole(node),
    height: node.boundingRect?.height || 0,
    elements: identifyElements(node),
  }));
}

function findVisualRows(node) {
  const children = (node.children || []).filter(
    (c) => (c.boundingRect?.height || 0) > 15,
  );
  if (children.length === 0) return [node];
  if (children.length === 1) return findVisualRows(children[0]);

  if (areVerticallyStacked(children)) {
    return children;
  }
  return [node];
}

function areVerticallyStacked(nodes) {
  if (nodes.length < 2) return false;
  const sorted = [...nodes].sort(
    (a, b) => (a.boundingRect?.y || 0) - (b.boundingRect?.y || 0),
  );
  for (let i = 1; i < sorted.length; i++) {
    const prevBottom =
      (sorted[i - 1].boundingRect?.y || 0) +
      (sorted[i - 1].boundingRect?.height || 0);
    const currTop = sorted[i].boundingRect?.y || 0;
    if (currTop < prevBottom - 5) return false;
  }
  return true;
}

function classifyRowRole(node) {
  const cls = allClasses(node);
  const height = node.boundingRect?.height || 0;
  const bg = node.computedStyles?.backgroundColor || '';

  if (cls.includes('navigation') || cls.includes('nav-bar')) {
    return 'nav-bar';
  }

  if (cls.includes('brand') || cls.includes('logo-section')) {
    return 'brand-bar';
  }

  const isDarkBg =
    bg === 'rgb(0, 0, 0)' ||
    bg === 'rgba(0, 0, 0, 1)' ||
    bg.match(/^rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)$/);
  if (isDarkBg && height <= 45) {
    return 'brand-bar';
  }

  const elements = identifyElements(node);
  const elSet = new Set(elements);

  if (
    elSet.has('nav-links') &&
    !elSet.has('logo') &&
    !elSet.has('search')
  ) {
    return 'nav-bar';
  }

  return 'main-bar';
}

function identifyElements(node) {
  const elements = [];
  const isBrandRow = isBrandBarNode(node);
  const iconNodes = new Set();

  walkTree(node, (n, depth) => {
    if (depth > 6) return;
    const cls = (n.classes || []).join(' ').toLowerCase();
    const id = (n.id || '').toLowerCase();
    const tag = (n.tag || '').toUpperCase();

    if (isBrandRow) {
      if (hasMultipleLogos(node) && !elements.includes('brand-logos')) {
        elements.push('brand-logos');
      }
    } else if (isLogoElement(n) && !elements.includes('logo')) {
      elements.push('logo');
    }

    if (isSearchElement(n, cls, id, tag) && !elements.includes('search')) {
      elements.push('search');
    }

    if (isIconElement(cls, id, 'cart') || isIconElement(cls, id, 'minicart')) {
      iconNodes.add(n);
    }
    if (isIconElement(cls, id, 'account') || isIconElement(cls, id, 'user-profile') || isIconElement(cls, id, 'signin')) {
      iconNodes.add(n);
    }
    if (cls.includes('find-') && cls.includes('icon')) {
      iconNodes.add(n);
    }
    if (
      (tag === 'A' || tag === 'BUTTON') &&
      hasSvgChild(n) &&
      !hasImgChild(n) &&
      n.boundingRect?.width < 60 &&
      n.boundingRect?.height < 60
    ) {
      iconNodes.add(n);
    }

    if (hasNavLinkList(n, tag) && !elements.includes('nav-links')) {
      elements.push('nav-links');
    }
  });

  walkTree(node, (n, depth) => {
    if (depth > 6) return;
    const cls = (n.classes || []).join(' ').toLowerCase();
    const tag = (n.tag || '').toUpperCase();
    const text = (n.textContent || '').trim().toLowerCase();
    const bg = n.computedStyles?.backgroundColor || '';
    const br = n.computedStyles?.borderRadius || '';

    if (tag === 'A' && isCtaStyle(bg, br) && !elements.includes('cta-button')) {
      elements.push('cta-button');
    }

    if (tag === 'A' && isLoginText(text) && !elements.includes('login-link')) {
      elements.push('login-link');
    }

    if (tag === 'A' && isHelpText(text) && !elements.includes('help-link')) {
      elements.push('help-link');
    }
  });

  if (iconNodes.size >= 3 && !elements.includes('utility-icons')) {
    elements.push('utility-icons');
  } else if (iconNodes.size > 0) {
    const svgIcons = [];
    walkTree(node, (n) => {
      const cls = (n.classes || []).join(' ').toLowerCase();
      const id = (n.id || '').toLowerCase();
      const tag = (n.tag || '').toUpperCase();
      if (
        (isIconElement(cls, id, 'cart') || isIconElement(cls, id, 'minicart')) &&
        !elements.includes('cart-icon')
      ) {
        elements.push('cart-icon');
      }
      if (
        (isIconElement(cls, id, 'account') || isIconElement(cls, id, 'user-profile')) &&
        !elements.includes('account-icon')
      ) {
        elements.push('account-icon');
      }
      if (
        (tag === 'A' || tag === 'BUTTON') &&
        hasSvgChild(n) &&
        !hasImgChild(n) &&
        n.boundingRect?.width < 60
      ) {
        svgIcons.push({ tag, node: n });
      }
    });
    if (!elements.includes('account-icon') && !elements.includes('cart-icon') && svgIcons.length >= 2) {
      elements.push('account-icon');
      elements.push('cart-icon');
    }
  }

  if (isBrandRow && hasBrandLinks(node)) {
    if (!elements.includes('brand-links')) elements.push('brand-links');
  }

  if (elements.length === 0) {
    const cls = allClasses(node);
    const text = (node.textContent || '').trim();
    if (
      (cls.includes('navigation') || cls.includes('nav-bar') || cls.includes('nav')) &&
      text.length > 0
    ) {
      elements.push('nav-links');
      elements.push('secondary-nav-links');
    }
  }

  return elements;
}

function hasMultipleLogos(node) {
  let count = 0;
  walkTree(node, (n) => {
    const cls = (n.classes || []).join(' ').toLowerCase();
    if (cls.includes('logo') && (n.tag === 'A' || n.tag === 'IMG')) {
      count++;
    }
  });
  return count >= 2;
}

function hasBrandLinks(node) {
  let linkCount = 0;
  walkTree(node, (n) => {
    if (n.tag === 'A' && n.textContent?.trim()) linkCount++;
    if (n.tag === 'A' && !n.textContent?.trim()) {
      const cls = (n.classes || []).join(' ').toLowerCase();
      if (cls.includes('logo')) linkCount++;
    }
  });
  return linkCount >= 2;
}

function isLogoElement(n) {
  const cls = (n.classes || []).join(' ').toLowerCase();
  const tag = (n.tag || '').toUpperCase();
  if (cls.includes('logo') && !cls.includes('brand')) {
    if (tag === 'A' || tag === 'IMG' || tag === 'DIV' || tag === 'LI' || tag === 'SPAN') {
      return true;
    }
  }
  if (tag === 'A' && hasImgChild(n)) {
    const rect = n.boundingRect;
    if (rect && rect.x < 200 && rect.width < 300) return true;
  }
  return false;
}

function hasImgChild(node) {
  for (const c of node.children || []) {
    if (c.tag === 'IMG' || c.tag === 'PICTURE') return true;
    if (hasImgChild(c)) return true;
  }
  return false;
}

function hasSvgChild(node) {
  for (const c of node.children || []) {
    if (c.tag === 'svg' || c.tag === 'SVG') return true;
  }
  return false;
}

function isSearchElement(n, cls, id, tag) {
  return (
    tag === 'SEARCH' ||
    tag === 'FORM' ||
    cls.includes('search') ||
    id.includes('search')
  );
}

function isIconElement(cls, id, keyword) {
  return cls.includes(keyword) || id.includes(keyword);
}

function isCtaStyle(bg, br) {
  const hasBg =
    bg &&
    bg !== 'rgba(0, 0, 0, 0)' &&
    bg !== 'rgb(255, 255, 255)' &&
    bg !== 'rgb(0, 0, 0)';
  const hasBr = br && br !== '0px';
  return hasBg && hasBr;
}

function isLoginText(text) {
  return /^(log\s*in|sign\s*in)$/i.test(text);
}

function isHelpText(text) {
  return text.includes('help') || text.includes('support');
}

function hasNavLinkList(n, tag) {
  if (tag === 'UL') {
    const navChildren = (n.children || []).filter(
      (c) => c.tag === 'LI' || c.tag === 'A',
    );
    return navChildren.length >= 3;
  }
  if (tag === 'DIV' || tag === 'NAV') {
    const liChildren = (n.children || []).filter((c) => c.tag === 'LI');
    if (liChildren.length >= 3) return true;
  }
  return false;
}

function classifyNavItems(rawItems, rows) {
  const level1 = rawItems.filter((n) => n.level === 1);
  const seen = new Map();
  const unique = [];
  for (const item of level1) {
    const text = cleanNavText(item.text);
    if (!text) continue;
    const key = normalizeForDedup(text);
    if (seen.has(key)) {
      const existingIdx = seen.get(key);
      if (text.length > unique[existingIdx].text.length) {
        unique[existingIdx] = { ...item, text };
      }
      continue;
    }
    seen.set(key, unique.length);
    unique.push({ ...item, text });
  }

  const ctaPattern =
    /^(shop|buy|book|sign up|log in|login|open app|explore|get started|try|download|docs)\b/i;
  const utilityPattern = /^(find a |find |explore more)/i;
  const filtered = unique.filter(
    (item) =>
      !ctaPattern.test(item.text) &&
      !utilityPattern.test(item.text) &&
      item.href !== 'javascript:void(0);' &&
      item.href !== '#',
  );

  const hasBrandBar = rows.some((r) => r.role === 'brand-bar');
  const navBarHasHelpLink = rows.some(
    (r) => r.role === 'nav-bar' && r.elements.includes('help-link'),
  );

  const secondaryPattern =
    /^(our company|about|investors|careers|contact|press|media|legal|privacy)/i;
  const helpPattern = /help|support/i;

  const secondary = [];
  const primary = [];

  for (const item of filtered) {
    if (hasBrandBar && secondaryPattern.test(item.text)) {
      secondary.push(item.text);
    } else if (navBarHasHelpLink && helpPattern.test(item.text)) {
      secondary.push(item.text);
    } else {
      primary.push(item.text);
    }
  }

  return { primary, secondary };
}

function cleanNavText(text) {
  if (!text) return '';
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s*new$/i, '')
    .trim();
}

function normalizeForDedup(text) {
  return text.toLowerCase().replace(/\.+$/, '').trim();
}

function isBrandBarNode(node) {
  const cls = allClasses(node);
  const bg = node.computedStyles?.backgroundColor || '';
  const height = node.boundingRect?.height || 0;
  if (cls.includes('brand') || cls.includes('logo-section')) return true;
  let childHasLogoSection = false;
  for (const c of node.children || []) {
    if (allClasses(c).includes('logo-section')) childHasLogoSection = true;
  }
  if (childHasLogoSection) return true;
  const isDarkBg =
    bg === 'rgb(0, 0, 0)' ||
    bg === 'rgba(0, 0, 0, 1)';
  return isDarkBg && height <= 45;
}

function allClasses(node) {
  return (node.classes || []).join(' ').toLowerCase();
}

function walkTree(node, fn, depth = 0) {
  fn(node, depth);
  for (const child of node.children || []) {
    walkTree(child, fn, depth + 1);
  }
}
