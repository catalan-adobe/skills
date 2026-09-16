// Screenshots for every chrome variant on its representative page, through the offline
// server: the full page with every member outlined, then one crop per member. A member
// whose selector resolves on no page is a defect recorded on the variant, not skipped.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { proxiedUrl } from './cache-server.mjs';

export const shotsDir = (project) => path.join(project.step('chrome'), 'screenshots');
export const OUTLINE = '4px solid #e00';

/** One eval: per known selector, how many elements with a visible box it matches here. */
export const resolveExpression = (selectors) => (
  `JSON.stringify(${JSON.stringify(selectors)}.map((s) => [...document.querySelectorAll(s)]`
  + '.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })'
  + '.length))'
);

/** One eval: outline every element the selectors match, scroll back to the top (the prep
 * expression scrolled down; a sticky nav would sit mid-page), return how many. */
export const outlineExpression = (selectors) => (
  `(() => { let n = 0; for (const s of ${JSON.stringify(selectors)}) {`
  + ' for (const e of document.querySelectorAll(s)) {'
  + ` e.style.outline = ${JSON.stringify(OUTLINE)}; e.style.outlineOffset = "-4px"; n += 1; } }`
  + ' window.scrollTo(0, 0); return n; })()'
);

const parse = (raw) => {
  let value = raw;
  for (let i = 0; i < 2 && typeof value === 'string'; i += 1) {
    try { value = JSON.parse(value); } catch { break; }
  }
  return value;
};

/** The first of a member's selectors matching exactly one element with a box on this page. */
export async function resolveMember(browser, member) {
  const selectors = [member.selector, ...member.selectors.filter((s) => s !== member.selector)];
  const counts = parse(await browser.eval(resolveExpression(selectors)));
  const i = Array.isArray(counts) ? counts.findIndex((c) => c === 1) : -1;
  if (i >= 0) return selectors[i];
  const any = Array.isArray(counts) ? counts.findIndex((c) => c > 0) : -1;
  return any >= 0 ? selectors[any] : null;
}

/**
 * Takes the screenshots for one role's variants and returns them with `screenshots` and,
 * where a member did not resolve, `screenshotError` filled in. Paths are relative to
 * `migration/chrome/`.
 */
export async function screenshotVariants(project, role, variants,
  { browser, origin, port, prepare = null }) {
  await mkdir(shotsDir(project), { recursive: true });
  const out = [];
  for (const variant of variants) {
    const id = `${role}-${variant.id}`;
    await browser.goto(proxiedUrl(origin, variant.representative, port));
    if (prepare) await browser.eval(prepare);
    const resolved = [];
    const errors = [];
    for (const member of variant.members) {
      const selector = await resolveMember(browser, member);
      if (selector) resolved.push({ member, selector });
      else errors.push(`${member.selector} resolves on ${variant.representative} to nothing`);
    }
    await browser.eval(outlineExpression(resolved.map((r) => r.selector)));
    const full = `screenshots/${id}.png`;
    await browser.screenshot(path.join(project.step('chrome'), full));
    const members = [];
    for (const [i, { member, selector }] of resolved.entries()) {
      const file = `screenshots/${id}-m${i + 1}.png`;
      try {
        await browser.screenshot(path.join(project.step('chrome'), file), selector);
        members.push({ selector: member.selector, file });
      } catch (err) {
        errors.push(`${member.selector}: ${String(err.message).split('\n')[0]}`);
      }
    }
    out.push({
      ...variant,
      members: variant.members.map((m) => ({
        ...m, selectorOnRepresentative: resolved.find((r) => r.member === m)?.selector ?? null,
      })),
      screenshots: { full, members },
      ...(errors.length ? { screenshotError: errors } : {}),
    });
  }
  return out;
}
