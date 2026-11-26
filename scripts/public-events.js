/* Build-time generated handlers come only from versioned page source.
 * DOM attributes contain identifiers, never JavaScript to evaluate. */
(function () {
  'use strict';
  const compiled = __LOVE_EVENT_HANDLERS__;
  const index = element => {
    const value = Number(element.dataset.leIndex);
    return Number.isInteger(value) && value >= 0 && value <= 10000 ? value : null;
  };
  const handlers = Object.assign(Object.create(null), compiled, {
    'route-home': { event: 'click', handle() { showPage('home'); return false; } },
    'route-shop': { event: 'click', handle() { showPage('shop'); return false; } },
    'shop-category': { event: 'click', handle() { openShopCategory(this.dataset.leCategory); return false; } },
    'soap-fragrance': { event: 'click', handle() { selectSoapFlowerFragrance(this.dataset.fragrance); } },
    'gallery-image-error': { event: 'error', handle() { const slide = this.closest('.pd-gallery-slide'); if (slide) slide.remove(); } },
    'gallery-prev': { event: 'click', handle() { changeProductGallery(-1, true); } },
    'gallery-next': { event: 'click', handle() { changeProductGallery(1, true); } },
    'gallery-slide': { event: 'click', handle() { const value = index(this); if (value !== null) setProductGallerySlide(value, true); } },
    'cart-quantity': { event: 'click', handle() {
      const value = index(this), delta = Number(this.dataset.leDelta);
      if (value !== null && (delta === -1 || delta === 1)) updateCartLineQty(value, delta);
    } },
    'cart-remove': { event: 'click', handle() { const value = index(this); if (value !== null) removeCartLine(value); } },
  });
  const events = [...new Set(Object.values(handlers).map(handler => handler.event))];
  const bound = new WeakMap();
  function run(element, eventName, event) {
    const key = element.getAttribute('data-le-on' + eventName);
    const handler = Object.hasOwn(handlers, key) ? handlers[key] : null;
    if (handler && handler.event === eventName && handler.handle.call(element, event) === false) event.preventDefault();
  }
  function bind(element) {
    if (!element || element.nodeType !== 1) return;
    let seen = bound.get(element);
    if (!seen) { seen = new Set(); bound.set(element, seen); }
    for (const eventName of events) {
      if (eventName === 'error' || seen.has(eventName) || !element.hasAttribute('data-le-on' + eventName)) continue;
      seen.add(eventName);
      element.addEventListener(eventName, event => run(element, eventName, event));
    }
  }
  const selector = events.map(name => '[data-le-on' + name + ']').join(',');
  function hydrate(root) {
    bind(root);
    if (root.querySelectorAll) root.querySelectorAll(selector).forEach(bind);
  }
  // Resource errors do not bubble and can occur before a new image is hydrated.
  document.addEventListener('error', event => {
    if (event.target && event.target.nodeType === 1) run(event.target, 'error', event);
  }, true);
  hydrate(document);
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) hydrate(node);
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
