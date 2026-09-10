import { Blocks } from '#lib/importer';

export const version = '1.0.0';
export const needsBrowser = false;

export function match(url) {
  return /^\/product-[a-z]+\.html$/.test(new URL(url).pathname);
}

export function generateDocumentPath({ url }) {
  return new URL(url).pathname.replace(/\.html$/, '');
}

export function transformDOM({ document }) {
  const warnings = [];
  const main = document.createElement('main');
  const hero = document.createElement('div');
  const src = document.querySelector('.product-hero');
  if (!src) {
    warnings.push('Missing .product-hero section');
  } else {
    hero.append(
      src.querySelector('h1'),
      src.querySelector('img'),
      src.querySelector('.price'),
      src.querySelector('.lead'),
    );
  }
  main.append(hero);
  const specs = document.createElement('div');
  const specHead = document
    .querySelector('.product-specs h2');
  if (specHead) specs.append(specHead);
  const rows = [
    ...document.querySelectorAll('table.specs tr'),
  ].map((tr) => [
    tr.querySelector('th').textContent.trim(),
    tr.querySelector('td').textContent.trim(),
  ]);
  if (rows.length > 0) {
    specs.append(
      Blocks.createBlock(document, {
        name: 'specifications',
        cells: rows,
      }),
    );
  } else {
    warnings.push(
      'No specification rows found in table.specs',
    );
  }
  main.append(specs);
  return { element: main, metadata: {}, warnings };
}
