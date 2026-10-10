// The in-page dump of a rendered page: every visible content leaf with its box, text,
// media, decoration and landmarks, every wide decorated box, the floating layers set aside,
// the side rails stretched to their block, shadow roots walked, boxes clipped to overflow.
// Ported whole from the site census's bands-probe.mjs, where it was measured on a dozen
// sites and three thousand pages; the comments are its own. One expression for
// `playwright-cli eval`, run after the page is prepared and at the top.
const RAW_PATH = `(el) => {
  const out = [];
  for (let n = el; n && n.tagName && n.tagName !== 'BODY' && n.tagName !== 'HTML';
    n = n.parentElement) out.push([n.tagName.toLowerCase(), ...n.classList].join(' '));
  if (el.getRootNode && el.getRootNode() !== el.ownerDocument && el.getRootNode().host)
    out.push('#shadow');
  return out.reverse().join(' > ');
}`;

const CONSENT = `
  const consentLayers = [];
  {
    const BUTTONS = 'button, [role=button], input[type=button], input[type=submit]';
    const named = (n) => /cookie|consent/i.test(n.id + ' ' + (n.getAttribute('class') ?? '') + ' ' +
      (n.getAttribute('aria-label') ?? ''));
    const regions = new Set();
    for (const b of document.querySelectorAll(BUTTONS)) {
      let region = null;
      for (let n = b.parentElement; n && n !== document.body && n.textContent.length <= 3000;
        n = n.parentElement) {
        if (named(n) && n.querySelectorAll(BUTTONS).length >= 2) region = n;
        else if (region) break;
      }
      if (region) regions.add(region);
    }
    for (const n of regions) {
      const r = n.getBoundingClientRect();
      if ([...regions].some((m) => m !== n && m.contains(n)) || r.width < 2 || r.height < 2)
        continue;
      consentLayers.push({ t: n.innerText.replace(/\\s+/g, ' ').trim().slice(0, 80),
        x: Math.round(r.left), y: Math.round(r.top + window.scrollY), w: Math.round(r.width),
        h: Math.round(r.height), flow: true });
      n.style.setProperty('display', 'none', 'important');
    }
  }
`;

export const DUMP = `(() => {
  ${CONSENT}
  const W = document.documentElement.clientWidth;
  let H = document.documentElement.scrollHeight;
  const sy = window.scrollY, sx = window.scrollX;
  const pageBg = getComputedStyle(document.body).backgroundColor;
  const leaves = [], bgs = [];
  const skip = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','HEAD','META','LINK','BR']);
  // Walk into open shadow roots too (search widgets, web components render there).
  const all = [];
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el);
    if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(document.body);
  // Parents in the rendered (flat) tree: web components render header, footer and collapsed
  // panels in shadow roots, around light-DOM content slotted into them (slot, parent, host).
  const parentOf = (n) => n.assignedSlot ?? n.parentElement ?? n.getRootNode().host ?? null;
  const up = (el, sel) => { for (let n = el; n; n = parentOf(n)) if (n.matches(sel)) return n;
    return null; };
  // Each distinct path once per page; a leaf keeps its index (p).
  const rawPath = ${RAW_PATH}, paths = [], pathIndex = new Map();
  const pathOf = (el) => { const r = rawPath(el); if (!pathIndex.has(r)) { pathIndex.set(r,
    paths.length); paths.push(r); } return pathIndex.get(r); };
  const layers = new Map();
  const fixedLayer = (el) => {
    const trail = [];
    let found = null;
    for (let n = parentOf(el); n && n !== document.body && n !== document.documentElement;
      n = parentOf(n)) {
      if (layers.has(n)) { found = layers.get(n); break; }
      trail.push(n);
      if (getComputedStyle(n).position === 'fixed') { found = n; break; }
    }
    for (const n of trail) layers.set(n, found);
    return found;
  };
  const screenH = window.innerHeight;
  const bodyText = document.body.innerText.length;
  // A layer's box: its own, or its contents' when it is 0 px high (a fixed container whose frame
  // or dialog is positioned inside it).
  const layerBox = (layer) => {
    const own = layer.getBoundingClientRect();
    if (own.width >= 2 && own.height >= 2) return own;
    let [l, t, rt, bt] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const d of layer.querySelectorAll('*')) {
      const q = d.getBoundingClientRect();
      if (q.width < 2 || q.height < 2) continue;
      [l, t, rt, bt] = [Math.min(l, q.left), Math.min(t, q.top), Math.max(rt, q.right), Math.max(bt,
        q.bottom)];
    }
    return l === Infinity ? own : { left: l, top: t, right: rt, bottom: bt, width: rt - l,
      height: bt - t };
  };
  // A frame in a layer is another document (a consent or chat tool): that layer floats over the
  // page.
  const framed = (layer) => layer.tagName === 'IFRAME' || Boolean(layer.querySelector('iframe'));
  const keepLayer = (layer) => {
    const lr = layerBox(layer);
    const topBar = lr.top <= 1 && lr.width >= 0.8 * W && lr.height <= 0.3 * screenH &&
      !framed(layer);
    // An app shell holds the page, most of its text; a backdrop or a dialog frame holds none.
    const shell = lr.width >= 0.9 * W && lr.height >= 0.9 * screenH &&
      layer.innerText.length >= 0.5 * bodyText;
    return topBar || shell;
  };
  const layerLabel = (layer) => {
    const t = layer.innerText.replace(/\\s+/g, ' ').trim().slice(0, 80);
    if (t) return t;
    const frame = layer.tagName === 'IFRAME' ? layer : layer.querySelector('iframe');
    if (!frame) return '[empty layer]';
    let host = 'inline';
    try { host = new URL(frame.src).host || host; } catch { /* srcdoc or about:blank */ }
    return '[iframe ' + host + ']';
  };
  const overlays = new Map(consentLayers.map((o, i) => ['consent' + i, o]));
  const addOverlay = (layer) => {
    if (overlays.has(layer)) return;
    const lr = layerBox(layer);
    overlays.set(layer, { t: layerLabel(layer), x: Math.round(lr.left), y: Math.round(lr.top),
      w: Math.round(lr.width), h: Math.round(lr.height) });
  };
  const withLeaf = new Set();
  // A sticky side rail (a TOC) follows the reader down its containing block: give it, and
  // everything inside it, that block's vertical extent. The block is its nearest ancestor with a
  // box (a parent with display: contents has none), and a stretch only grows a box. Sticky
  // horizontal bars (navs) are left alone or they would sit on every row.
  const stretchSticky = (el, r) => {
    for (let s = el; s && s !== document.body; s = parentOf(s)) {
      if (getComputedStyle(s).position !== 'sticky') continue;
      if (s.getBoundingClientRect().width >= 0.5 * W || !parentOf(s)) break;
      let host = parentOf(s);
      while (host && host !== document.body && host.getBoundingClientRect().height < 2)
        host = parentOf(host);
      const p = (host ?? document.body).getBoundingClientRect();
      const top = Math.min(r.top, p.top), bottom = Math.max(r.bottom, p.bottom);
      return [{ left: r.left, right: r.right, width: r.width, top, bottom, height: bottom - top },
        true];
    }
    return [r, false];
  };
  const nested = [];
  for (const el of all) {
    if (skip.has(el.tagName)) continue;
    // What the browser does not paint: hidden ancestors, the closed part of a <details>,
    // content-visibility: hidden. Off-screen lazy content (content-visibility: auto) stays.
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
    if (cs.position === 'fixed' && !keepLayer(el)) {
      // A fixed element is a floating layer itself unless it is the site header bar or an app
      // shell — those are read like the page, their own background with them.
      const fr = layerBox(el);
      if (fr.width >= 2 && fr.height >= 2) addOverlay(el);
      continue;
    }
    // An open modal (a consent dialog, a newsletter popup) sits over the page and is not page
    // content: its own markup says so (aria-modal, an alert dialog, an open <dialog>), whatever
    // positions its children. A OneTrust consent banner is an alertdialog without aria-modal.
    if (up(el, '[aria-modal="true"], [role="alertdialog"], dialog[open]')) continue;
    // Content in a fixed layer floats over the page (a cookie bar, a feedback badge, a chat
    // window), unless the layer is the site header (a full-width bar at the top) or holds the whole
    // page (an app shell). Left out, and listed so the log shows what was.
    const layer = fixedLayer(el);
    if (layer && !keepLayer(layer)) {
      addOverlay(layer);
      continue;
    }
    let r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    let stretched = false;
    [r, stretched] = stretchSticky(el, r);
    // Visible box: clip to ancestors that hide overflow (a 375px image in a 263px tile, a
    // collapsed panel inside a web component) and to clip-path insets, the element's own
    // included (a mega menu's panel closed with inset(0 0 100%) is laid out and never painted).
    const clipTo = (c) => {
      const l = Math.max(r.left, c.left), t = Math.max(r.top, c.top);
      const rt = Math.min(r.right, c.right), bt = Math.min(r.bottom, c.bottom);
      r = { left: l, top: t, right: rt, bottom: bt, width: Math.max(0, rt - l),
        height: Math.max(0, bt - t) };
    };
    const insetOf = (a, o) => {
      const m = o.clipPath?.match(/^inset\\(([^)]*)\\)/);
      if (/^circle\\(0(px|%)?[\\s)]/.test(o.clipPath ?? '')) return { left: 0, top: 0, right: 0,
        bottom: 0 };
      if (!m) return null;
      const p = m[1].trim().split(/\\s+/).slice(0, 4);
      const [t, rr = t, b = t, ll = rr] = p;
      const c = a.getBoundingClientRect();
      const px = (v, size) => v.endsWith('%') ? size * parseFloat(v) / 100 : parseFloat(v) || 0;
      return { left: c.left + px(ll, c.width), top: c.top + px(t, c.height),
        right: c.right - px(rr, c.width), bottom: c.bottom - px(b, c.height) };
    };
    for (let a = el; a && a !== document.body; a = parentOf(a)) {
      const o = a === el ? cs : getComputedStyle(a);
      if (a !== el && /hidden|clip|auto|scroll/.test(o.overflowX + o.overflowY)) {
        clipTo(a.getBoundingClientRect());
      }
      const inset = insetOf(a, o);
      if (inset) clipTo(inset);
    }
    if (r.width < 2 || r.height < 2) continue;
    const x = r.left + sx, y = r.top + sy;
    if (x + r.width <= 0 || x >= W || y + r.height <= 0) continue;
    const box = { x: Math.round(Math.max(0, x)), y: Math.round(y), w: Math.round(Math.min(W, x +
      r.width) - Math.max(0, x)), h: Math.round(r.height) };
    const tag = el.tagName;
    // An iframe (video, map, third-party form) is content: without it an embed is a hole between
    // bands.
    const media = tag === 'IMG' || tag === 'VIDEO' || tag === 'svg' || tag === 'PICTURE' ||
      tag === 'CANVAS' || tag === 'IFRAME';
    const paintOf = (s) => {
      const i = s.backgroundImage, c = s.backgroundColor;
      if (i && i !== 'none') return i.includes('gradient(') ? 'gradient' : 'image';
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent' && c !== pageBg) return 'color:' + c;
      return null;
    };
    let bg = paintOf(cs) ?? (media ? 'media' : null);
    // A ::before or ::after with content and a background, as large as the element, paints
    // over its box (a hero's artwork, a tinted veil): the element's own background as far as
    // a reader sees. A thin one (a rule, a menu's underline) is not.
    if (!bg && el.children.length) {
      for (const which of ['::before', '::after']) {
        const ps = getComputedStyle(el, which);
        if (ps.content === 'none' || ps.display === 'none') continue;
        const pw = parseFloat(ps.width), ph = parseFloat(ps.height);
        if (!(pw >= 0.8 * r.width && ph >= 0.8 * r.height)) continue;
        const paint = paintOf(ps);
        if (paint) { bg = paint; break; }
      }
    }
    if (bg && box.w >= 0.8 * W && box.h >= 40) bgs.push({ ...box, bg });
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent)
      .join(' ').replace(/\\s+/g, ' ').trim();
    // A dropdown is one control: its <option> children are never boxes of their own.
    const leaf = el.children.length === 0 || media || tag === 'SELECT';
    const dec = bg && !media && box.w < 0.8 * W ? bg : undefined;
    // A block-level link or paragraph is as wide as its container; its ink is not. For text
    // leaves without a decorated background, use the tight text rectangle horizontally.
    if (own && !media && !dec) {
      const rg = document.createRange(); rg.selectNodeContents(el);
      const tr = rg.getBoundingClientRect();
      if (tr.width > 0 && tr.width < r.width) {
        const tl = Math.max(0, tr.left + sx), trr = Math.min(W, tr.right + sx);
        box.x = Math.round(tl); box.w = Math.round(trr - tl);
      }
    }
    // For blocks.mjs: the heading or link a text sits in (e), the nearest landmark (l), an
    // iframe's host, and on EDS sites the block that rendered the node (eds): ground truth for
    // evaluation only, never part of a Jev state.
    const e = media ? tag : (up(el, 'h1,h2,h3,h4,h5,h6') ?? up(el, 'a,button') ?? el).tagName;
    const lm = up(el,
      'header,footer,nav,aside,form,table,blockquote,details,dialog,[role=tablist]');
    const l = lm ? (lm.matches('[role=tablist]') ? 'tablist' : lm.tagName.toLowerCase()) :
      undefined;
    const src = tag === 'IFRAME' ? el.src.split('/')[2] || undefined : undefined;
    // An image laid out and not loaded: a broken image, named by its host — an asset the
    // offline cache does not have, or a refusal.
    const b = tag === 'IMG' && el.complete && el.naturalWidth === 0 && el.currentSrc
      ? (new URL(el.currentSrc, location.href).host || 'unknown') : undefined;
    // The page-level landmark around the node (l is only the innermost one): a header or footer
    // that is not part of an article or main content is the site's banner or contentinfo.
    const hd = up(el, 'header,[role=banner]'), ft = up(el, 'footer,[role=contentinfo]');
    const c = hd && !up(hd, 'main,article') ? 'header' : ft && !up(ft, 'main,article') ? 'footer' :
      undefined;
    const eds = el.closest('[data-block-name]')?.dataset.blockName
      ?? (el.closest('.default-content-wrapper') ? 'default' : undefined);
    // AEM Sites: the Experience Fragment around the node, by name. Ground truth for fragment
    // detection on AEM sites, evaluation only like eds.
    const xfEl = el.closest('.cmp-experiencefragment');
    const xf = xfEl ? ([...xfEl.classList].find((c) => c.startsWith('cmp-experiencefragment--'))
      ?? 'x--unnamed').split('--').slice(1).join('--') : undefined;
    if (!(leaf || own || dec)) continue;
    leaves.push({ ...box, t: own.slice(0, 80) || undefined, m: media || undefined, d: dec,
      s: stretched || undefined, e, l, c, src, b, eds, xf, p: pathOf(el) });
    withLeaf.add(el);
    if (!c && (hd || ft)) nested.push([leaves.length - 1, hd, ft]);
  }
  // Markup that nests the site's header and footer inside <main>: when no header (footer) sits
  // outside main content, a page-wide one within the first (last) screen is the banner
  // (contentinfo). One inside an <article> is the article's own; a header with content above
  // it (a hero's own <header> under the site's navigation) is not the page's.
  const vh = window.innerHeight;
  const above = (r) => leaves.some((l) => l.y + l.h <= r.top + sy);
  // The page ends where its content does: a root held at the screen's height (a scroll lock) must
  // not cut the page, and the footer is found from the real end.
  H = Math.max(H, document.body.scrollHeight, leaves.reduce((m, l) => Math.max(m, l.y + l.h), 0));
  const edges = [['header', 1, (r) => r.top + sy < vh && !above(r)], ['footer', 2, (r) => r.bottom +
    sy > H - vh]];
  for (const [name, at, near] of edges) {
    if (leaves.some((l) => l.c === name)) continue;
    for (const n of nested) {
      const lm = n[at];
      if (!lm || leaves[n[0]].c || up(lm, 'article')) continue;
      const r = lm.getBoundingClientRect();
      if (r.width >= 0.8 * W && near(r)) leaves[n[0]].c = name;
    }
  }
  // A landmark column painted on the page that gave no leaf (a side rail lost to clipping, to a
  // layer rule, or past the page edge) is the worst silent loss: recorded with the first reason.
  const hasLeaf = new Set();
  for (const e of withLeaf) for (let n = e; n && !hasLeaf.has(n); n = parentOf(n)) hasLeaf.add(n);
  const whyDropped = (lm) => {
    const walker = document.createTreeWalker(lm, NodeFilter.SHOW_TEXT);
    let t = walker.nextNode();
    while (t && !t.data.trim()) t = walker.nextNode();
    const el = t?.parentElement ?? lm;
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
      return 'not painted (hidden or transparent)';
    if (fixedLayer(el)) return 'in a floating layer';
    let [r] = stretchSticky(el, el.getBoundingClientRect());
    for (let a = parentOf(el); a && a !== document.body; a = parentOf(a)) {
      const o = getComputedStyle(a);
      if (!/hidden|clip|auto|scroll/.test(o.overflowX + o.overflowY)) continue;
      const c = a.getBoundingClientRect();
      const w = Math.min(r.right, c.right) - Math.max(r.left, c.left), h = Math.min(r.bottom,
        c.bottom) - Math.max(r.top, c.top);
      if (w < 2 || h < 2) return 'clipped to nothing by ' + rawPath(a).split(' > ').pop();
      r = { left: Math.max(r.left, c.left), right: Math.min(r.right, c.right), top: Math.max(r.top,
        c.top), bottom: Math.min(r.bottom, c.bottom) };
    }
    if (r.left + sx >= W || r.right + sx <= 0) return 'past the page edge (x ' + Math.round(r.left +
      sx) + ')';
    return 'reason not found';
  };
  const dropped = [];
  for (const lm of document.querySelectorAll('aside, nav, section, [role=complementary]')) {
    if (hasLeaf.has(lm) || dropped.some((d) => d.el.contains(lm)) || !lm.innerText.trim()) continue;
    if (!lm.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    if (up(lm, '[aria-modal="true"], [role="alertdialog"], dialog[open]') || (fixedLayer(lm) &&
      !keepLayer(fixedLayer(lm)))) continue;
    // Off-canvas menus sit outside the page's width by design: only columns on the page count.
    const r = lm.getBoundingClientRect();
    if (r.width < 0.1 * W || r.height < 2 || r.right <= 0 || r.left >= W) continue;
    dropped.push({ el: lm, path: rawPath(lm), x: Math.round(r.left + sx), y: Math.round(r.top + sy),
      w: Math.round(r.width), h: Math.round(r.height), why: whyDropped(lm) });
  }
  // The page's own HTTP status (0 or missing when the browser does not tell).
  const status = performance.getEntriesByType('navigation')[0]?.responseStatus || undefined;
  // The floating layers left out are hidden for the screenshot too, so it shows what the record
  // holds: display none (a fixed layer takes no space, so nothing moves, and no descendant's own
  // visibility can undo it). A hidden consent region is already out of the page.
  for (const layer of overlays.keys()) if (layer instanceof Element)
    layer.style.setProperty('display', 'none', 'important');
  return JSON.stringify({ W, H, pageBg, leaves, bgs, paths, status, sy,
    overlays: [...overlays.values()], dropped: dropped.map(({ el, ...d }) => d),
    unpainted: typeof unpainted === 'number' ? unpainted : 0,
    scrollLock: typeof scrollLock === 'boolean' ? scrollLock : false });
})()`;


/** The dump as one expression returning JSON text. */
export const dumpExpression = () => DUMP;
