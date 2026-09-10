import { Blocks } from '#lib/importer.mjs';

export const version = '1.0.0';
export const needsBrowser = false;

export function match(url) {
  return /^\/product-[a-z]+\.html$/.test(new URL(url).pathname);
}

export function generateDocumentPath({ url }) {
  return new URL(url).pathname.replace(/\.html$/, '');
}

export function transformDOM({ document }) {
  const main = document.createElement('main');
  const hero = document.createElement('div');
  const src = document.querySelector('.product-hero');
  hero.append(
    src.querySelector('h1'),
    src.querySelector('img'),
    src.querySelector('.price'),
    src.querySelector('.lead'),
  );
  main.append(hero);
  const specs = document.createElement('div');
  specs.append(document.querySelector('.product-specs h2'));
  const rows = [
    ...document.querySelectorAll('table.specs tr'),
  ].map((tr) => [
    tr.querySelector('th').textContent.trim(),
    tr.querySelector('td').textContent.trim(),
  ]);
  specs.append(
    Blocks.createBlock(document, {
      name: 'specifications',
      cells: rows,
    }),
  );
  main.append(specs);
  return { element: main, metadata: {}, warnings: [] };
}
