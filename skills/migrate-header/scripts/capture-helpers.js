/**
 * Browser-side helpers for capture-snapshot.js.
 *
 * Injected via playwright-cli initScript before navigation.
 * Creates window.__captureHelpers with two functions:
 *   - captureHeaderDOM(selector, styleProps) → JSON string
 *   - extractNavItems(selector) → JSON string
 *
 * Called from Node via pure expression evals:
 *   playwright-cli eval "window.__captureHelpers.captureHeaderDOM('header', ['backgroundColor'])"
 */
(function () {
  window.__captureHelpers = {
    captureHeaderDOM: function (selector, styleProps) {
      var header = document.querySelector(selector);
      if (!header) return JSON.stringify(null);

      var nextNodeId = 0;
      function traverse(node, depth) {
        if (depth > 10) return null;
        if (node.nodeType !== Node.ELEMENT_NODE) return null;

        var rect = node.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return null;

        var computed = getComputedStyle(node);
        var computedStyles = {};
        for (var i = 0; i < styleProps.length; i++) {
          computedStyles[styleProps[i]] = computed[styleProps[i]] || '';
        }

        var children = [];
        for (var j = 0; j < node.children.length; j++) {
          var result = traverse(node.children[j], depth + 1);
          if (result) children.push(result);
        }

        var isLeaf = children.length === 0;
        var textContent = isLeaf
          ? (node.textContent || '').trim().slice(0, 100)
          : undefined;

        var attrs = {};
        var tag = node.tagName;
        if (tag === 'IMG') {
          var src = node.getAttribute('src');
          if (src) attrs.src = src;
          var alt = node.getAttribute('alt');
          if (alt !== null) attrs.alt = alt || '';
        }
        if (tag === 'A') {
          var href = node.getAttribute('href');
          if (href) attrs.href = href;
        }
        var dataSrc = node.getAttribute('data-src');
        if (dataSrc) attrs['data-src'] = dataSrc;

        var obj = {
          nodeId: nextNodeId++,
          tag: tag,
          id: node.id || '',
          classes: Array.from(node.classList),
          attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
          boundingRect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          computedStyles: computedStyles,
          children: children,
        };

        if (textContent !== undefined) {
          obj.textContent = textContent;
        }

        return obj;
      }

      return JSON.stringify(traverse(header, 0));
    },

    extractNavItems: function (selector) {
      var header = document.querySelector(selector);
      if (!header) return JSON.stringify([]);

      function isVisible(el) {
        var node = el;
        while (node && node !== header) {
          var style = getComputedStyle(node);
          if (style.display === 'none') return false;
          if (style.visibility === 'hidden') return false;
          if (style.opacity === '0') return false;
          if (style.maxHeight === '0px' && style.overflow === 'hidden')
            return false;
          node = node.parentElement;
        }
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        return true;
      }

      var links = header.querySelectorAll('a');
      var items = [];

      for (var i = 0; i < links.length; i++) {
        var a = links[i];
        var text = (a.textContent || '').trim();
        if (!text) continue;

        var visible = isVisible(a);

        var level = 0;
        var ancestor = a.parentElement;
        while (ancestor && ancestor !== header) {
          var tag = ancestor.tagName;
          if (tag === 'UL' || tag === 'OL') level++;
          ancestor = ancestor.parentElement;
        }
        if (level === 0) level = 1;

        var parent = undefined;
        if (level > 1) {
          var li = a.closest('li');
          if (li) {
            var parentLi = li.parentElement
              ? li.parentElement.closest('li')
              : null;
            if (parentLi) {
              var parentA = parentLi.querySelector(':scope > a');
              if (parentA) {
                parent = (parentA.textContent || '').trim();
              }
            }
          }
        }

        var item = {
          text: text,
          href: a.getAttribute('href') || '',
          level: level,
          visible: visible,
        };
        if (parent) item.parent = parent;
        items.push(item);
      }

      return JSON.stringify(items);
    },
  };
})();
