export const version = '1.0.0';

export function match(url) {
  const { pathname } = new URL(url);
  return pathname === '/' || pathname === '/about.html';
}

export function generateDocumentPath({ url }) {
  const { pathname } = new URL(url);
  return pathname === '/' ? '/index' : pathname.replace(/\.html$/, '');
}

export function transformDOM({ document }) {
  const warnings = [];
  const main = document.createElement('main');
  const section = document.createElement('div');
  const source = document.querySelector('#maincontent');
  if (!source) {
    warnings.push('Missing #maincontent');
  } else {
    section.append(...source.children);
  }
  main.append(section);
  return { element: main, warnings };
}
