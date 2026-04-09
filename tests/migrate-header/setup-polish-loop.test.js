import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  loadRowFiles,
  buildHeaderDescription,
  countNavItems,
  buildNavStructure,
  synthesizeStyles,
} from '../../skills/migrate-header/scripts/setup-polish-loop.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

function loadFixtures() {
  return [
    JSON.parse(readFileSync(join(FIXTURES, 'row-0.json'), 'utf-8')),
    JSON.parse(readFileSync(join(FIXTURES, 'row-1.json'), 'utf-8')),
  ];
}

describe('loadRowFiles', () => {
  it('loads and sorts row files by index', () => {
    const rows = loadRowFiles(FIXTURES);
    expect(rows).toHaveLength(2);
    expect(rows[0].index).toBe(0);
    expect(rows[1].index).toBe(1);
  });

  it('ignores non-row files', () => {
    const rows = loadRowFiles(FIXTURES);
    expect(rows.every(r => typeof r.index === 'number')).toBe(true);
  });
});

describe('buildHeaderDescription', () => {
  it('builds description from row data', () => {
    const rows = loadFixtures();
    const desc = buildHeaderDescription(rows);
    expect(desc).toContain('brand');
    expect(desc).toContain('~44px');
    expect(desc).toContain('main-nav');
    expect(desc).toContain('~50px');
    expect(desc).toContain('logo');
    expect(desc).toContain('nav-link');
  });

  it('includes background color when present', () => {
    const rows = loadFixtures();
    const desc = buildHeaderDescription(rows);
    expect(desc).toContain('rgb(255, 255, 255) background');
  });

  it('omits background for transparent rows', () => {
    const rows = loadFixtures();
    const desc = buildHeaderDescription(rows);
    const line1 = desc.split('\n')[0];
    expect(line1).not.toContain('background');
  });
});

describe('countNavItems', () => {
  it('counts nav-link and utility-link elements', () => {
    const rows = loadFixtures();
    expect(countNavItems(rows)).toBe(6);
  });

  it('excludes non-nav roles', () => {
    const rows = loadFixtures();
    const total = rows.reduce((s, r) => s + r.elements.length, 0);
    expect(countNavItems(rows)).toBeLessThan(total);
  });
});

describe('buildNavStructure', () => {
  it('extracts nav and utility links', () => {
    const rows = loadFixtures();
    const nav = buildNavStructure(rows);
    expect(nav.topNav).toHaveLength(6);
    expect(nav.topNav[0]).toEqual({ text: 'Global Sites', href: '/global' });
    expect(nav.topNav[2]).toEqual({ text: 'Products', href: '/products' });
  });

  it('skips non-link elements', () => {
    const rows = loadFixtures();
    const nav = buildNavStructure(rows);
    const texts = nav.topNav.map(n => n.text);
    expect(texts).not.toContain('TestCorp logo');
    expect(texts).not.toContain('Get Started');
  });
});

describe('synthesizeStyles', () => {
  it('builds header-level styles from rows', () => {
    const rows = loadFixtures();
    const styles = synthesizeStyles(rows);
    expect(styles.header['background-color'].value).toBe('rgba(0, 0, 0, 0)');
    expect(styles.header.height.value).toBe('94px');
    expect(styles.header['font-family'].value).toContain('Helvetica Neue');
  });

  it('builds per-row background colors', () => {
    const rows = loadFixtures();
    const styles = synthesizeStyles(rows);
    expect(styles.rows).toHaveLength(2);
    expect(styles.rows[0]['background-color'].value).toBe('rgba(0, 0, 0, 0)');
    expect(styles.rows[1]['background-color'].value).toBe('rgb(255, 255, 255)');
  });

  it('extracts nav link styles from first nav-link element', () => {
    const rows = loadFixtures();
    const styles = synthesizeStyles(rows);
    expect(styles.navLinks['font-size'].value).toBe('15px');
    expect(styles.navLinks['font-weight'].value).toBe('400');
    expect(styles.navLinks.color.value).toBe('rgb(60, 66, 66)');
  });

  it('extracts CTA styles when present', () => {
    const rows = loadFixtures();
    const styles = synthesizeStyles(rows);
    expect(styles.cta['background-color'].value).toBe('rgb(0, 120, 212)');
    expect(styles.cta.color.value).toBe('rgb(255, 255, 255)');
    expect(styles.cta['border-radius'].value).toBe('4px');
  });
});
