/**
 * Header Block
 * Supports multiple sections via Section Metadata Style property
 * and advanced mega menus with auto-detection.
 */

const SECTION_CLASSES = {
  MAIN_NAV: 'main-nav',
  BRAND: 'brand',
};

/**
 * Get section style from section metadata
 * @param {Element} section - The section element
 * @returns {string|null} - The style value or null
 */
function getSectionStyle(section) {
  const sectionMeta = section.querySelector('.section-metadata');
  if (!sectionMeta) return null;

  const rows = sectionMeta.querySelectorAll(':scope > div');
  for (const row of rows) {
    const key = row.children[0]?.textContent?.trim().toLowerCase();
    const value = row.children[1]?.textContent?.trim();
    if (key === 'style') return value;
  }
  return null;
}

/**
 * Get mobile style from section metadata
 * @param {Element} section - The section element
 * @returns {string} - The mobile style (accordion|slide-in|fullscreen)
 */
function getMobileStyle(section) {
  const sectionMeta = section.querySelector('.section-metadata');
  if (!sectionMeta) return 'accordion';

  const rows = sectionMeta.querySelectorAll(':scope > div');
  for (const row of rows) {
    const key = row.children[0]?.textContent?.trim().toLowerCase();
    const value = row.children[1]?.textContent?.trim().toLowerCase();
    if (key === 'mobile style') return value;
  }
  return 'accordion';
}

/**
 * Check if viewport is desktop
 * @returns {boolean}
 */
function isDesktop() {
  return window.matchMedia('(min-width: 1024px)').matches;
}

/**
 * Detect if dropdown content is rich (mega) or simple (links only)
 * @param {Element} ul - The nested ul element
 * @returns {boolean} - True if mega menu content
 */
function isMegaContent(ul) {
  const hasImages = ul.querySelector('img, picture') !== null;
  const hasHeadings = ul.querySelector('h1, h2, h3, h4, h5, h6') !== null;
  const hasParagraphs = ul.querySelector('p') !== null;
  const hasBlocks = ul.querySelector('[class*="block"]') !== null;

  return hasImages || hasHeadings || hasParagraphs || hasBlocks;
}

/**
 * Build navigation structure from content
 * @param {Element} content - The nav section content
 * @returns {Element} - The decorated nav element
 */
function buildNavigation(content) {
  const nav = document.createElement('nav');
  nav.className = 'header-nav';
  nav.setAttribute('aria-label', 'Main navigation');

  const ul = content.querySelector('ul');
  if (!ul) return nav;

  ul.className = 'header-nav-list';

  ul.querySelectorAll(':scope > li').forEach((li) => {
    li.className = 'header-nav-item';

    const nestedUl = li.querySelector(':scope > ul');

    if (nestedUl) {
      li.classList.add('has-dropdown');
      li.setAttribute('aria-haspopup', 'true');

      const dropdown = document.createElement('div');
      const isMega = isMegaContent(nestedUl);
      dropdown.className = `header-dropdown header-dropdown--${isMega ? 'mega' : 'simple'}`;

      dropdown.appendChild(nestedUl);
      li.appendChild(dropdown);
    }
  });

  nav.appendChild(ul);
  return nav;
}

/**
 * Build mobile menu toggle button
 * @returns {Element}
 */
function buildMenuToggle() {
  const button = document.createElement('button');
  button.className = 'header-menu-toggle';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', 'Menu');
  button.innerHTML = '<span class="header-menu-icon"></span>';
  return button;
}

/**
 * Build header section wrapper
 * @param {Element} section - The original section
 * @param {string} style - The section style
 * @returns {Element} - The wrapped section
 */
function buildSection(section, style) {
  const wrapper = document.createElement('div');
  wrapper.className = `header-section header-${style}`;

  if (style === SECTION_CLASSES.MAIN_NAV) {
    const content = document.createElement('div');
    content.className = 'header-section-content';

    const children = [...section.children].filter(
      (child) => !child.classList.contains('section-metadata'),
    );

    const firstChild = children[0];
    if (firstChild?.tagName === 'P' && firstChild.querySelector('picture, img')) {
      const brand = document.createElement('div');
      brand.className = 'header-brand-inline';
      brand.appendChild(firstChild.cloneNode(true));
      content.appendChild(brand);
      children.shift();
    }

    const tempContainer = document.createElement('div');
    const remainingElements = [];
    children.forEach((child) => {
      if (child.tagName === 'UL') {
        tempContainer.appendChild(child.cloneNode(true));
      } else {
        remainingElements.push(child);
      }
    });

    const nav = buildNavigation(tempContainer);
    content.appendChild(nav);

    if (remainingElements.length > 0) {
      const tools = document.createElement('div');
      tools.className = 'header-tools-inline';
      remainingElements.forEach((el) => {
        tools.appendChild(el.cloneNode(true));
      });
      content.appendChild(tools);
    }

    const toggle = buildMenuToggle();
    content.appendChild(toggle);

    wrapper.appendChild(content);
    return wrapper;
  }

  const content = document.createElement('div');
  content.className = 'header-section-content';

  const children = [...section.children];
  children.forEach((child) => {
    if (!child.classList.contains('section-metadata')) {
      content.appendChild(child.cloneNode(true));
    }
  });

  wrapper.appendChild(content);
  return wrapper;
}

/**
 * Setup desktop hover interactions
 * @param {Element} nav - The navigation element
 */
function setupDesktopInteractions(nav) {
  const items = nav.querySelectorAll('.header-nav-item.has-dropdown');

  items.forEach((item) => {
    let hoverTimeout;

    item.addEventListener('mouseenter', () => {
      hoverTimeout = setTimeout(() => {
        item.classList.add('is-open');
        item.setAttribute('aria-expanded', 'true');
      }, 100);
    });

    item.addEventListener('mouseleave', () => {
      clearTimeout(hoverTimeout);
      item.classList.remove('is-open');
      item.setAttribute('aria-expanded', 'false');
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      items.forEach((item) => {
        item.classList.remove('is-open');
        item.setAttribute('aria-expanded', 'false');
      });
    }
  });
}

/**
 * Setup mobile menu toggle
 * @param {Element} section - The main-nav section
 */
function setupMobileToggle(section) {
  const toggle = section.querySelector('.header-menu-toggle');
  const nav = section.querySelector('.header-nav');

  if (!toggle || !nav) return;

  toggle.addEventListener('click', () => {
    const isOpen = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    document.body.style.overflow = isOpen ? 'hidden' : '';
  });
}

/**
 * Setup mobile dropdown behavior
 * @param {Element} nav - The navigation element
 * @param {string} mobileStyle - The mobile style (accordion|slide-in|fullscreen)
 */
function setupMobileDropdowns(nav, mobileStyle) {
  const items = nav.querySelectorAll('.header-nav-item.has-dropdown');

  items.forEach((item) => {
    const link = item.querySelector(':scope > a');
    if (!link) return;

    link.addEventListener('click', (e) => {
      if (!isDesktop()) {
        e.preventDefault();

        if (mobileStyle === 'accordion') {
          item.classList.toggle('is-expanded');
        } else {
          item.classList.add('is-expanded');
          nav.classList.add('has-expanded-item');
        }
      }
    });
  });

  if (mobileStyle !== 'accordion') {
    items.forEach((item) => {
      const dropdown = item.querySelector('.header-dropdown');
      if (dropdown) {
        const backBtn = document.createElement('button');
        backBtn.className = 'header-dropdown-back';
        backBtn.textContent = 'Back';
        backBtn.addEventListener('click', () => {
          item.classList.remove('is-expanded');
          nav.classList.remove('has-expanded-item');
        });
        dropdown.prepend(backBtn);
      }
    });
  }
}

/**
 * Setup keyboard navigation
 * @param {Element} nav - The navigation element
 */
function setupKeyboardNavigation(nav) {
  const items = [...nav.querySelectorAll('.header-nav-item')];

  items.forEach((item, index) => {
    const link = item.querySelector(':scope > a');
    if (!link) return;

    link.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowRight': {
          e.preventDefault();
          const nextItem = items[index + 1] || items[0];
          nextItem.querySelector(':scope > a')?.focus();
          break;
        }

        case 'ArrowLeft': {
          e.preventDefault();
          const prevItem = items[index - 1] || items[items.length - 1];
          prevItem.querySelector(':scope > a')?.focus();
          break;
        }

        case 'ArrowDown':
          if (item.classList.contains('has-dropdown')) {
            e.preventDefault();
            item.classList.add('is-open');
            item.setAttribute('aria-expanded', 'true');
            const firstDropdownLink = item.querySelector('.header-dropdown a');
            firstDropdownLink?.focus();
          }
          break;

        case 'Enter':
        case ' ':
          if (item.classList.contains('has-dropdown') && isDesktop()) {
            e.preventDefault();
            const isOpen = item.classList.toggle('is-open');
            item.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
          }
          break;

        default:
          break;
      }
    });
  });

  nav.querySelectorAll('.header-dropdown').forEach((dropdown) => {
    const links = [...dropdown.querySelectorAll('a')];

    links.forEach((link, i) => {
      link.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const next = links[i + 1] || links[0];
          next.focus();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          const prev = links[i - 1] || links[links.length - 1];
          prev.focus();
        } else if (e.key === 'Escape') {
          const navItem = dropdown.closest('.header-nav-item');
          navItem.classList.remove('is-open');
          navItem.setAttribute('aria-expanded', 'false');
          navItem.querySelector(':scope > a')?.focus();
        }
      });
    });
  });
}

/**
 * Decorates the header block
 * @param {Element} block - The header block element
 */
export default async function decorate(block) {
  const navMeta = document.querySelector('meta[name="nav"]');
  const navPath = navMeta?.content || '/nav';

  const resp = await fetch(`${navPath}.plain.html`);
  if (!resp.ok) return;

  const html = await resp.text();

  const parser = new DOMParser();
  const navDoc = parser.parseFromString(html, 'text/html');

  block.textContent = '';
  block.classList.add('header-block');

  const sections = navDoc.querySelectorAll('body > div');
  sections.forEach((section) => {
    const style = getSectionStyle(section);
    if (!style) return;

    const sectionWrapper = buildSection(section, style);

    if (style === SECTION_CLASSES.MAIN_NAV) {
      const mobileStyle = getMobileStyle(section);
      sectionWrapper.dataset.mobileStyle = mobileStyle;
    }

    block.appendChild(sectionWrapper);
  });

  const mainNav = block.querySelector('.header-main-nav');
  if (mainNav) {
    const nav = mainNav.querySelector('.header-nav');
    const mobileStyle = mainNav.dataset.mobileStyle || 'accordion';

    if (nav) {
      setupDesktopInteractions(nav);
      setupMobileDropdowns(nav, mobileStyle);
      setupKeyboardNavigation(nav);
    }

    setupMobileToggle(mainNav);
  }
}
