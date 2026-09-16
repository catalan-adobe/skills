// From recurring candidates to chrome: members placed by geometry into header or footer,
// variants as the pages' distinct sets of core members, optional members, what was rejected
// and why, and the pages carrying no chrome at all. Pure functions.
import { chromeCandidates } from './chrome.mjs';

export const BAND_RATIO = 0.15;
export const CORE_SHARE = 0.8;
export const MIN_SUPPORT = 0.5;
export const REPORT_REJECTED_FROM = 0.2;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** header when anchored at the top band, footer at the bottom band, else unplaced. */
export function place(candidate, pageHeight, bandRatio = BAND_RATIO) {
  const band = pageHeight * bandRatio;
  if (candidate.anchored === 'top' && candidate.bounds.y < band) return 'header';
  if (candidate.anchored === 'bottom' && candidate.bounds.bottomOffset < band) return 'footer';
  return 'unplaced';
}

/** A reason to reject a candidate regardless of support, or null. */
export function rejectionReason(candidate, consentSelectors = []) {
  const { sample, tags } = candidate;
  const cls = String(sample.node.className ?? '');
  const id = String(sample.node.id ?? '');
  const text = String(sample.text ?? '');
  const sel = sample.selector;
  if (tags.every((t) => t === 'A') && /skip/i.test(`${cls} ${id} ${text}`)) return 'skip link';
  if (/breadcrumb/i.test(`${cls} ${id} ${sel}`)) return 'breadcrumb: per-page content';
  if (consentSelectors.some((s) => sel === s || sel.includes(s) || (id && s === `#${id}`))) {
    return 'consent overlay (page-prep removes it)';
  }
  return null;
}

const jaccard = (a, b) => {
  const A = new Set(a);
  const inter = b.filter((x) => A.has(x)).length;
  return inter / (A.size + b.length - inter);
};

const sameSlot = (a, b, tol) => Math.abs(a.bounds.y - b.bounds.y) <= tol
  && Math.abs(a.bounds.height - b.bounds.height) <= tol
  && jaccard(a.pages, b.pages) < 0.1;

/** Drops members nested inside another member of the same set (the outermost stays). */
function outermost(members) {
  const fps = new Set(members.map((m) => m.fp));
  return members.filter((m) => !m.ancestors.some((fp) => fps.has(fp)));
}

/**
 * The members of one role and how they group into variants. Core members cover most of the
 * region's pages or share a slot with an alternative on disjoint pages; the rest are
 * optional. Every distinct set of core members a page carries is a variant.
 */
function role(members, allPages, groupOf, tolerance) {
  if (!members.length) return { variants: [], without: [...allPages] };
  const regionPages = new Set(members.flatMap((m) => m.pages));
  // ponytail: 80 % share and a same-slot test decide core vs optional; a site with three
  // stacked alternatives may need a real slot model.
  const core = members.filter((m) => m.pages.length / regionPages.size >= CORE_SHARE
    || members.some((o) => o !== m && sameSlot(m, o, tolerance)));
  const optional = members.filter((m) => !core.includes(m));
  const signatures = new Map();
  for (const url of regionPages) {
    const carried = core.filter((m) => m.pages.includes(url)).map((m) => m.fp).sort();
    if (!carried.length) continue;
    const key = carried.join('+');
    signatures.set(key, [...(signatures.get(key) ?? []), url]);
  }
  const variants = [...signatures.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([key, pages], i) => {
      const fps = new Set(key.split('+'));
      const own = core.filter((m) => fps.has(m.fp));
      const extras = optional
        .map((m) => ({ ...member(m), onPages: m.pages.filter((p) => pages.includes(p)).length }))
        .filter((m) => m.onPages > 0);
      return {
        id: `${i + 1}`, pages, support: pages.length / allPages.length,
        members: own.map(member), optional: extras,
        representative: representative(pages, own),
        ...groupLabel(pages, groupOf),
      };
    });
  const covered = new Set(variants.flatMap((v) => v.pages));
  return { variants, without: allPages.filter((p) => !covered.has(p)) };
}

const member = (m) => ({
  fp: m.fp, selector: m.sample.selector, selectors: m.selectors, tag: m.tags[0],
  bounds: m.bounds, support: m.support, pages: m.pages.length, sampleUrl: m.sample.url,
  text: String(m.sample.text ?? '').slice(0, 60),
});

/** The shortest URL among the pages that carry every core member. */
function representative(pages, own) {
  const full = pages.filter((p) => own.every((m) => m.pages.includes(p)));
  return [...(full.length ? full : pages)]
    .sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0];
}

/** The inventory group most of the variant's pages share, or `site-wide`; top three counts. */
function groupLabel(pages, groupOf) {
  const counts = {};
  for (const p of pages) counts[groupOf(p) || '/'] = (counts[groupOf(p) || '/'] ?? 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const group = top[0] && top[0][1] / pages.length >= 0.5 ? top[0][0] : 'site-wide';
  return { group, groups: Object.fromEntries(top) };
}

// A band under the header or above the footer that touches it belongs to it: a promo bar,
// a pre-footer call to action. Stacked chrome grows past the bands by adjacency.
function attachAdjacent(placed, tolerance) {
  const touches = (c, role) => placed[role].some((m) => {
    const edge = role === 'header'
      ? c.bounds.y - (m.bounds.y + m.bounds.height)
      : c.bounds.bottomOffset - (m.bounds.bottomOffset + m.bounds.height);
    return Math.abs(edge) <= tolerance;
  });
  let moved = true;
  while (moved) {
    moved = false;
    for (const c of [...placed.unplaced]) {
      const role = c.anchored === 'top' ? 'header' : 'footer';
      if (!touches(c, role)) continue;
      placed[role].push(c);
      placed.unplaced.splice(placed.unplaced.indexOf(c), 1);
      moved = true;
    }
  }
}

/**
 * The chrome of a site from its candidates.
 *
 * @param {object[]} all Every candidate (`candidates(captures)`).
 * @param {object} context `{ pages: string[], pageHeights: number[], groupOf(url),
 *   consentSelectors?: string[], minSupport?, tolerance? }`
 */
export function detectChrome(all, context) {
  const {
    pages, pageHeights, groupOf = () => null, consentSelectors = [],
    minSupport = MIN_SUPPORT, tolerance = 40,
  } = context;
  const pageHeight = median(pageHeights);
  const rejected = [];
  const placed = { header: [], footer: [], unplaced: [] };
  const kept = chromeCandidates(all, { minSupport });
  // An alternative in a kept member's slot (same place, disjoint pages) is chrome for its
  // own pages however few they are: the other header of a template or a locale.
  const alternatives = all.filter((c) => c.stable && !kept.includes(c)
    && kept.some((k) => place(k, pageHeight) === place(c, pageHeight)
      && place(c, pageHeight) !== 'unplaced' && sameSlot(c, k, tolerance)));
  for (const c of [...kept, ...alternatives]) {
    const reason = rejectionReason(c, consentSelectors);
    if (reason) rejected.push({ ...member(c), reason });
    else placed[place(c, pageHeight)].push(c);
  }
  attachAdjacent(placed, tolerance);
  for (const c of all) {
    if (c.stable && c.support < minSupport && c.support >= REPORT_REJECTED_FROM
      && !alternatives.includes(c)) {
      rejected.push({
        ...member(c), reason: `support ${Math.round(c.support * 100)} % is under the line`,
      });
    }
  }
  const header = role(outermost(placed.header), pages, groupOf, tolerance);
  const footer = role(outermost(placed.footer), pages, groupOf, tolerance);
  return {
    capturedPages: pages.length, minSupport, pageHeight,
    header: header.variants, footer: footer.variants,
    unplaced: outermost(placed.unplaced).map(member),
    rejected: rejected.sort((a, b) => b.support - a.support),
    without: { header: header.without, footer: footer.without },
    limits: [
      'hover- or click-only panels (mega-menus) are not in a plain render: the trigger is '
        + 'detected, the panel is not',
      'elements narrower than the capture\'s minimum width are folded into their parent',
      'a header drawn over a hero image can be folded into the hero by the capture: such '
        + 'pages show only the members found outside it',
    ],
  };
}
