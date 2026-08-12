/* Love Essences — consentimento, GA4, Clarity e eventos de loja (v1.0) */
(function () {
  'use strict';

  var config = window.LOVE_ANALYTICS_CONFIG || {};
  var debugFromUrl = false;
  try {
    debugFromUrl = new URLSearchParams(window.location.search).get('analytics_debug') === '1';
  } catch (error) {}

  var state = {
    consent: null,
    gaLoaded: false,
    clarityLoaded: false,
    lastPageKey: '',
    lastPageAt: 0,
    scrollMilestones: {},
    lastListSignature: '',
    suppressRemoveEvent: false,
    checkoutStarted: false,
    cartAbandonmentSent: false,
    debug: Boolean(config.debug || debugFromUrl)
  };

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };

  // Consent Mode v2: o estado inicial é sempre negado, antes de qualquer tag.
  window.gtag('consent', 'default', {
    ad_storage: 'denied',
    analytics_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    wait_for_update: 500
  });
  window.gtag('set', 'ads_data_redaction', true);
  window.gtag('set', 'url_passthrough', false);

  var debugEvents = window.__LOVE_ANALYTICS_DEBUG_EVENTS__ = window.__LOVE_ANALYTICS_DEBUG_EVENTS__ || [];

  function safeStorageGet(storage, key) {
    try { return storage.getItem(key); } catch (error) { return null; }
  }

  function safeStorageSet(storage, key, value) {
    try { storage.setItem(key, value); return true; } catch (error) { return false; }
  }

  function safeStorageRemove(storage, key) {
    try { storage.removeItem(key); } catch (error) {}
  }

  function parseJSON(value, fallback) {
    if (!value) return fallback;
    try { return JSON.parse(value); } catch (error) { return fallback; }
  }

  function roundMoney(value) {
    var number = Number(value);
    return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
  }

  function cleanText(value, maxLength) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength || 100);
  }

  function containsLikelyPII(value) {
    var text = String(value || '');
    return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text) ||
      /(?:\+?\d[\s().-]*){8,}/.test(text);
  }

  function safeFreeText(value, maxLength) {
    var text = cleanText(value, maxLength || 80);
    return containsLikelyPII(text) ? '[redacted]' : text;
  }

  function currentPageName() {
    var active = document.querySelector('.page.active');
    if (active && active.id) return active.id.replace(/^page-/, '');
    var hash = String(window.location.hash || '').replace(/^#page-?/, '').split(/[?&]/)[0];
    return hash || 'home';
  }

  function virtualPath(pageName) {
    return pageName === 'home' ? '/' : '/#page-' + pageName;
  }

  function isValidGA4Id() {
    return config.enableGA4 !== false && /^G-[A-Z0-9]{4,}$/i.test(config.ga4MeasurementId || '') && config.ga4MeasurementId !== 'G-XXXXXXXXXX';
  }

  function isValidClarityId() {
    return config.enableClarity !== false && /^[a-z0-9]{6,}$/i.test(config.clarityProjectId || '');
  }

  function getConsent() {
    var saved = parseJSON(safeStorageGet(window.localStorage, config.consentStorageKey), null);
    if (!saved || Number(saved.version) !== Number(config.consentVersion || 1)) return null;
    return {
      necessary: true,
      analytics: Boolean(saved.analytics),
      marketing: Boolean(saved.marketing),
      version: Number(config.consentVersion || 1),
      updatedAt: saved.updatedAt || ''
    };
  }

  function saveConsent(analytics, marketing) {
    var value = {
      necessary: true,
      analytics: Boolean(analytics),
      marketing: Boolean(marketing),
      version: Number(config.consentVersion || 1),
      updatedAt: new Date().toISOString()
    };
    safeStorageSet(window.localStorage, config.consentStorageKey, JSON.stringify(value));
    return value;
  }

  function getAttribution() {
    return parseJSON(safeStorageGet(window.localStorage, config.attributionStorageKey), {}) || {};
  }

  function captureAttribution() {
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (error) { return; }
    var fields = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    var current = {};
    fields.forEach(function (field) {
      var value = safeFreeText(params.get(field), 100);
      if (value && value !== '[redacted]') current[field] = value;
    });
    if (!Object.keys(current).length) return;

    var previous = getAttribution();
    var record = {
      first: previous.first || current,
      last: current,
      updatedAt: new Date().toISOString()
    };
    safeStorageSet(window.localStorage, config.attributionStorageKey, JSON.stringify(record));
  }

  function attributionParams() {
    var attribution = getAttribution();
    var last = attribution.last || attribution.first || {};
    var output = {};
    var map = {
      utm_source: 'campaign_source',
      utm_medium: 'campaign_medium',
      utm_campaign: 'campaign_name',
      utm_content: 'campaign_content',
      utm_term: 'campaign_term'
    };
    Object.keys(map).forEach(function (source) {
      if (last[source]) output[map[source]] = last[source];
    });
    return output;
  }

  function removeAnalyticsCookies() {
    var names = document.cookie.split(';').map(function (entry) { return entry.split('=')[0].trim(); });
    names.forEach(function (name) {
      if (!/^(_ga|_gid|_gat|_clck|_clsk)/.test(name)) return;
      var expire = name + '=; Max-Age=0; path=/; SameSite=Lax';
      document.cookie = expire;
      var host = window.location.hostname;
      if (host && host.indexOf('.') !== -1) document.cookie = expire + '; domain=.' + host.replace(/^www\./, '');
    });
  }

  function loadGA4() {
    if (state.gaLoaded || !state.consent || !state.consent.analytics || !isValidGA4Id()) return;
    state.gaLoaded = true;
    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(config.ga4MeasurementId);
    script.dataset.loveAnalytics = 'ga4';
    document.head.appendChild(script);
    window.gtag('js', new Date());
    window.gtag('config', config.ga4MeasurementId, {
      send_page_view: false,
      anonymize_ip: true,
      allow_google_signals: Boolean(state.consent.marketing),
      allow_ad_personalization_signals: Boolean(state.consent.marketing),
      debug_mode: state.debug
    });
  }

  function loadClarity() {
    if (state.clarityLoaded || !state.consent || !state.consent.analytics || !isValidClarityId()) return;
    state.clarityLoaded = true;
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r);
      t.async = 1;
      t.src = 'https://www.clarity.ms/tag/' + i;
      t.dataset.loveAnalytics = 'clarity';
      y = l.getElementsByTagName(r)[0];
      y.parentNode.insertBefore(t, y);
    })(window, document, 'clarity', 'script', config.clarityProjectId);
    updateClarityConsent();
  }

  function updateClarityConsent() {
    if (typeof window.clarity !== 'function') return;
    window.clarity('consentv2', {
      ad_Storage: state.consent && state.consent.marketing ? 'granted' : 'denied',
      analytics_Storage: state.consent && state.consent.analytics ? 'granted' : 'denied'
    });
  }

  function applyConsent(consent, options) {
    state.consent = consent;
    window.gtag('consent', 'update', {
      analytics_storage: consent.analytics ? 'granted' : 'denied',
      ad_storage: consent.marketing ? 'granted' : 'denied',
      ad_user_data: consent.marketing ? 'granted' : 'denied',
      ad_personalization: consent.marketing ? 'granted' : 'denied'
    });
    updateClarityConsent();

    if (consent.analytics) {
      captureAttribution();
      loadGA4();
      loadClarity();
      setTimeout(function () {
        trackPageView(currentPageName(), { force: Boolean(options && options.forcePageView) });
        if (currentPageName() === 'shop') scheduleViewItemList();
      }, 0);
    } else {
      removeAnalyticsCookies();
    }
  }

  function track(eventName, parameters) {
    if (!state.consent || !state.consent.analytics) return false;
    var event = Object.assign({}, parameters || {}, attributionParams());
    event.page_name = event.page_name || currentPageName();

    debugEvents.push({
      event: cleanText(eventName, 40),
      parameters: JSON.parse(JSON.stringify(event)),
      timestamp: new Date().toISOString()
    });
    if (debugEvents.length > 250) debugEvents.splice(0, debugEvents.length - 250);

    if (isValidGA4Id()) window.gtag('event', eventName, event);
    if (state.clarityLoaded && typeof window.clarity === 'function') window.clarity('event', eventName);
    if (state.debug && window.console) console.info('[Love Analytics]', eventName, JSON.stringify(event));
    return true;
  }

  function trackPageView(pageName, options) {
    pageName = cleanText(pageName || currentPageName(), 40) || 'home';
    var path = virtualPath(pageName);
    var now = Date.now();
    var key = pageName + '|' + path;
    if (!(options && options.force) && state.lastPageKey === key && now - state.lastPageAt < 1200) return;
    state.lastPageKey = key;
    state.lastPageAt = now;
    state.scrollMilestones = {};
    state.lastListSignature = '';
    track('page_view', {
      page_title: document.title,
      page_location: window.location.origin + path,
      page_path: path,
      page_name: pageName
    });
  }

  function productIdByName(name) {
    var cleanName = cleanText(name, 100);
    if (typeof window.getCartBaseName === 'function') cleanName = window.getCartBaseName(cleanName);
    cleanName = cleanName.replace(/\s+—.*$/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    var catalog = window.PRODUCT_CATALOG || {};
    var ids = Object.keys(catalog);
    for (var i = 0; i < ids.length; i += 1) {
      if (cleanText(catalog[ids[i]].name, 100).toLocaleLowerCase('pt-PT') === cleanName.toLocaleLowerCase('pt-PT')) return ids[i];
    }
    return cleanName.toLocaleLowerCase('pt-PT').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  }

  function catalogProduct(productId) {
    return (window.PRODUCT_CATALOG || {})[productId] || null;
  }

  function catalogPrice(product) {
    if (!product) return 0;
    if (Array.isArray(product.sizes) && product.sizes.length) return roundMoney(product.sizes[0].price);
    return roundMoney(product.basePrice);
  }

  function selectedVariant(productId, product) {
    if (!product) return '';
    if (window.currentProduct === productId && Array.isArray(product.sizes) && product.sizes.length) {
      var selectedSize = product.sizes.find(function (size) { return size.id === window.currentSizeId; });
      if (selectedSize) return cleanText(selectedSize.label || selectedSize.id, 60);
      var active = document.querySelector('#pd-sizes .pd-size.active');
      var activeLabel = active && active.querySelector('.pd-size-label');
      if (active) return cleanText((activeLabel && activeLabel.textContent) || active.dataset.sizeId || '', 60);
    }
    return '';
  }

  function itemFromCatalog(productId, overrides) {
    var product = catalogProduct(productId) || {};
    var variant = overrides && overrides.item_variant != null ? overrides.item_variant : selectedVariant(productId, product);
    var item = {
      item_id: cleanText(productId, 80),
      item_name: cleanText(product.name || productId, 100),
      item_category: cleanText(product.category || '', 100),
      price: roundMoney(overrides && overrides.price != null ? overrides.price : catalogPrice(product)),
      quantity: Math.max(1, parseInt(overrides && overrides.quantity, 10) || 1)
    };
    if (variant) item.item_variant = cleanText(variant, 60);
    if (overrides && overrides.item_list_id) item.item_list_id = cleanText(overrides.item_list_id, 60);
    if (overrides && overrides.item_list_name) item.item_list_name = cleanText(overrides.item_list_name, 80);
    if (overrides && Number.isFinite(Number(overrides.index))) item.index = Number(overrides.index);
    return item;
  }

  function itemFromCart(cartItem) {
    var baseName = typeof window.getCartBaseName === 'function' ? window.getCartBaseName(cartItem.name) : cartItem.name;
    var productId = productIdByName(baseName);
    var product = catalogProduct(productId) || {};
    var variant = '';
    var sizeMatch = String(cartItem.name || '').match(/\s—\s([^,(]+)/);
    if (!sizeMatch) sizeMatch = String(cartItem.name || '').match(/\(([^)]+)\)\s*$/);
    if (sizeMatch) variant = cleanText(sizeMatch[1], 60);
    return {
      item_id: cleanText(productId, 80),
      item_name: cleanText(product.name || baseName, 100),
      item_category: cleanText(product.category || '', 100),
      item_variant: variant,
      price: roundMoney(cartItem.price),
      quantity: Math.max(1, parseInt(cartItem.qty, 10) || 1)
    };
  }

  function cartItems() {
    return (Array.isArray(window.cart) ? window.cart : []).map(itemFromCart);
  }

  function cartValue() {
    if (typeof window.getTotal === 'function') return roundMoney(window.getTotal());
    return cartItems().reduce(function (sum, item) { return sum + item.price * item.quantity; }, 0);
  }

  function ecommerceParams(items, value) {
    return {
      currency: config.currency || 'EUR',
      value: roundMoney(value),
      items: items
    };
  }

  function cardProductId(card) {
    if (!card) return '';
    var title = card.querySelector('.product-name');
    return productIdByName(title ? title.textContent : '');
  }

  function visibleShopItems() {
    return Array.prototype.slice.call(document.querySelectorAll('#shop-products-grid .product-card'))
      .filter(function (card) { return card.style.display !== 'none' && !card.hidden; })
      .map(function (card, index) {
        return itemFromCatalog(cardProductId(card), {
          item_list_id: 'shop_' + cleanText(window.currentCategory || 'todos', 40) + '_' + cleanText(window.currentOccasion || 'todos', 40),
          item_list_name: 'Loja — ' + cleanText(window.currentCategory || 'todos', 40) + ' — ' + cleanText(window.currentOccasion || 'todos', 40),
          index: index
        });
      });
  }

  function trackViewItemList() {
    if (currentPageName() !== 'shop') return;
    var items = visibleShopItems();
    var signature = items.map(function (item) { return item.item_id; }).join('|') + '|' + cleanText(window.currentCategory || '', 30) + '|' + cleanText(window.currentOccasion || '', 30);
    if (signature === state.lastListSignature) return;
    state.lastListSignature = signature;
    track('view_item_list', {
      item_list_id: items[0] ? items[0].item_list_id : 'shop_empty',
      item_list_name: items[0] ? items[0].item_list_name : 'Loja — sem resultados',
      items: items
    });
  }

  function scheduleViewItemList() {
    window.setTimeout(trackViewItemList, 80);
  }

  function trackCurrentProductView(productId) {
    var product = catalogProduct(productId);
    if (!product) return;
    var item = itemFromCatalog(productId);
    track('view_item', ecommerceParams([item], item.price));
  }

  function trackWhatsApp(source) {
    var productId = currentPageName() === 'product' ? cleanText(window.currentProduct || '', 80) : '';
    var product = catalogProduct(productId);
    track('whatsapp_click', {
      click_source: cleanText(source || 'link', 60),
      destination: 'whatsapp',
      product_id: productId,
      product_name: product ? cleanText(product.name, 100) : ''
    });
  }

  function wrapGlobal(name, wrapperFactory) {
    if (typeof window[name] !== 'function' || window[name].__loveAnalyticsWrapped) return;
    var original = window[name];
    var wrapped = wrapperFactory(original);
    wrapped.__loveAnalyticsWrapped = true;
    window[name] = wrapped;
  }

  function installFunctionTracking() {
    wrapGlobal('showPage', function (original) {
      return function (name, options) {
        var result = original.apply(this, arguments);
        window.setTimeout(function () { trackPageView(name); }, 0);
        return result;
      };
    });

    wrapGlobal('openProduct', function (original) {
      return function (productId) {
        var result = original.apply(this, arguments);
        window.setTimeout(function () { trackCurrentProductView(productId); }, 0);
        return result;
      };
    });

    wrapGlobal('applyShopFilters', function (original) {
      return function () {
        var result = original.apply(this, arguments);
        scheduleViewItemList();
        return result;
      };
    });

    ['filterCategory', 'filterOccasion', 'filterOccasionFromSelect'].forEach(function (functionName) {
      wrapGlobal(functionName, function (original) {
        return function () {
          var selected = functionName === 'filterCategory' ? arguments[1] : (functionName === 'filterOccasion' ? arguments[1] : arguments[0]);
          var result = original.apply(this, arguments);
          window.setTimeout(function () {
            track('filter_use', {
              filter_type: functionName === 'filterCategory' ? 'category' : 'occasion',
              filter_value: cleanText(selected || 'todos', 60),
              results_count: visibleShopItems().length
            });
          }, 0);
          return result;
        };
      });
    });

    wrapGlobal('clearOccasionFilter', function (original) {
      return function () {
        var result = original.apply(this, arguments);
        track('filter_use', { filter_type: 'occasion', filter_value: 'todos', results_count: visibleShopItems().length });
        return result;
      };
    });

    wrapGlobal('addCartLine', function (original) {
      return function (name, price, emoji, image, quantity) {
        var qty = Math.max(1, parseInt(quantity, 10) || 1);
        var item = itemFromCart({ name: name, price: price, qty: qty });
        state.checkoutStarted = false;
        state.cartAbandonmentSent = false;
        track('add_to_cart', ecommerceParams([item], item.price * item.quantity));
        return original.apply(this, arguments);
      };
    });

    wrapGlobal('removeFromCart', function (original) {
      return function (name) {
        var before = (Array.isArray(window.cart) ? window.cart : []).find(function (item) { return item.name === name; });
        var result = original.apply(this, arguments);
        if (before && !state.suppressRemoveEvent) {
          var item = itemFromCart(before);
          track('remove_from_cart', ecommerceParams([item], item.price * item.quantity));
        }
        return result;
      };
    });

    wrapGlobal('updateQty', function (original) {
      return function (name, delta) {
        var before = (Array.isArray(window.cart) ? window.cart : []).find(function (item) { return item.name === name; });
        state.suppressRemoveEvent = true;
        var result;
        try { result = original.apply(this, arguments); } finally { state.suppressRemoveEvent = false; }
        if (before && Number(delta) < 0) {
          var removedQty = Math.min(Math.abs(Number(delta)), Number(before.qty) || 1);
          var item = itemFromCart(Object.assign({}, before, { qty: removedQty }));
          track('remove_from_cart', ecommerceParams([item], item.price * item.quantity));
        }
        return result;
      };
    });

    wrapGlobal('clearCart', function (original) {
      return function () {
        var before = (Array.isArray(window.cart) ? window.cart : []).slice();
        var result = original.apply(this, arguments);
        if (before.length && Array.isArray(window.cart) && window.cart.length === 0) {
          var items = before.map(itemFromCart);
          var value = items.reduce(function (sum, item) { return sum + item.price * item.quantity; }, 0);
          track('remove_from_cart', ecommerceParams(items, value));
        }
        return result;
      };
    });

    wrapGlobal('openCart', function (original) {
      return function () {
        var drawer = document.getElementById('cart-drawer');
        var wasOpen = drawer && drawer.classList.contains('open');
        var result = original.apply(this, arguments);
        if (!wasOpen && cartItems().length) track('view_cart', ecommerceParams(cartItems(), cartValue()));
        return result;
      };
    });

    wrapGlobal('checkoutWhatsApp', function (original) {
      return function () {
        var items = cartItems();
        if (items.length) {
          state.checkoutStarted = true;
          track('begin_checkout', Object.assign(ecommerceParams(items, cartValue()), { checkout_method: 'whatsapp' }));
        }
        trackWhatsApp('cart_checkout');
        return original.apply(this, arguments);
      };
    });

    wrapGlobal('checkoutForm', function (original) {
      return function () {
        var items = cartItems();
        if (items.length) {
          state.checkoutStarted = true;
          track('begin_checkout', Object.assign(ecommerceParams(items, cartValue()), { checkout_method: 'contact_form' }));
        }
        return original.apply(this, arguments);
      };
    });

    wrapGlobal('openTrackingWhatsApp', function (original) {
      return function () {
        trackWhatsApp('tracking_help');
        return original.apply(this, arguments);
      };
    });
  }

  function installClickTracking() {
    document.addEventListener('click', function (event) {
      var whatsappLink = event.target.closest('a[href*="wa.me"], a[href*="whatsapp.com"]');
      if (whatsappLink && !event.target.closest('.cart-checkout-btn, .tracking-whatsapp-button')) trackWhatsApp('direct_link');

      var card = event.target.closest('#shop-products-grid .product-card');
      if (card) {
        var productId = cardProductId(card);
        var cards = visibleShopItems();
        var item = cards.find(function (candidate) { return candidate.item_id === productId; }) || itemFromCatalog(productId);
        track('select_item', {
          item_list_id: item.item_list_id || 'shop',
          item_list_name: item.item_list_name || 'Loja',
          items: [item],
          page_name: 'shop'
        });
      }

      var cta = event.target.closest('.btn-primary, .btn-outline, .product-btn, .pd-cta, .cart-checkout-btn, .form-submit, .tracking-whatsapp-button, .nav-cta, .mobile-cta');
      if (cta) {
        track('cta_click', {
          cta_text: safeFreeText(cta.textContent, 80),
          cta_location: currentPageName(),
          cta_type: cleanText(cta.tagName.toLowerCase(), 20)
        });
      }
    }, { capture: true, passive: true });
  }

  function installScrollTracking() {
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () {
        ticking = false;
        var max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        var percent = Math.min(100, Math.round((window.scrollY / max) * 100));
        [25, 50, 75, 90].forEach(function (milestone) {
          if (percent < milestone || state.scrollMilestones[milestone]) return;
          state.scrollMilestones[milestone] = true;
          track('scroll_depth', { percent_scrolled: milestone });
        });
      });
    }, { passive: true });
  }

  function installErrorTracking() {
    window.addEventListener('error', function (event) {
      var source = '';
      try { source = event.filename ? new URL(event.filename, document.baseURI).pathname.split('/').pop() : ''; } catch (error) {}
      track('site_error', { error_type: 'javascript', error_source: cleanText(source, 80) });
    });
    window.addEventListener('unhandledrejection', function () {
      track('site_error', { error_type: 'promise_rejection', error_source: 'browser' });
    });
  }

  function installAbandonmentTracking() {
    window.addEventListener('pagehide', function () {
      var items = cartItems();
      if (!items.length || state.checkoutStarted || state.cartAbandonmentSent) return;
      var signature = items.map(function (item) { return item.item_id + ':' + item.item_variant + ':' + item.quantity; }).join('|');
      var previous = parseJSON(safeStorageGet(window.localStorage, config.abandonmentStorageKey), {});
      if (previous.signature === signature && Date.now() - Number(previous.timestamp || 0) < 30 * 60 * 1000) return;
      state.cartAbandonmentSent = true;
      if (track('cart_abandonment', Object.assign(ecommerceParams(items, cartValue()), {
        abandonment_stage: 'cart',
        transport_type: 'beacon'
      }))) {
        safeStorageSet(window.localStorage, config.abandonmentStorageKey, JSON.stringify({ signature: signature, timestamp: Date.now() }));
      }
    });
  }

  function maskSensitiveAreas() {
    [
      '#contact-form', '#cart-drawer', '.newsletter-form', '#pd-custom-section',
      '#pd-event-section', 'input', 'textarea', 'select'
    ].forEach(function (selector) {
      document.querySelectorAll(selector).forEach(function (element) {
        element.setAttribute('data-clarity-mask', 'true');
      });
    });
  }

  function renderConsentUI() {
    if (document.getElementById('le-consent-banner')) return;
    var wrapper = document.createElement('div');
    wrapper.innerHTML =
      '<section class="le-consent-banner" id="le-consent-banner" role="dialog" aria-label="Preferências de cookies" hidden>' +
        '<div class="le-consent-copy"><strong>Privacidade à tua escolha</strong><p>Usamos cookies necessários para o carrinho. Com a tua autorização, usamos medição anónima para perceber como melhorar o site. Não enviamos nomes, contactos nem textos personalizados para analytics. <a href="#" data-le-privacy>Política de Privacidade</a></p></div>' +
        '<div class="le-consent-actions"><button class="le-consent-button" type="button" data-le-reject>Recusar opcionais</button><button class="le-consent-button" type="button" data-le-manage>Gerir</button><button class="le-consent-button le-consent-button--primary" type="button" data-le-accept>Aceitar todos</button></div>' +
      '</section>' +
      '<section class="le-consent-modal" id="le-consent-modal" role="dialog" aria-modal="true" aria-labelledby="le-consent-title" hidden>' +
        '<div class="le-consent-dialog">' +
          '<div class="le-consent-dialog-header"><div><h2 id="le-consent-title">Preferências de cookies</h2><p>Podes alterar esta escolha a qualquer momento no rodapé.</p></div><button class="le-consent-close" type="button" data-le-close aria-label="Fechar">×</button></div>' +
          '<div class="le-consent-category"><div><h3>Necessários</h3><p>Mantêm o carrinho, as preferências de idioma e a segurança básica do site. Não podem ser desligados.</p></div><span class="le-consent-status">Sempre ativos</span></div>' +
          '<div class="le-consent-category"><div><h3>Analytics</h3><p>Google Analytics 4 e Microsoft Clarity: métricas de utilização, funil, mapas de calor e gravações com campos sensíveis mascarados.</p></div><label class="le-consent-switch"><input id="le-consent-analytics" type="checkbox"/><span class="le-consent-switch-track" aria-hidden="true"></span><span class="sr-only">Ativar cookies de analytics</span></label></div>' +
          '<div class="le-consent-category"><div><h3>Marketing</h3><p>Reserva a tua preferência para futuras campanhas. Neste momento o site não instala plataformas de publicidade.</p></div><label class="le-consent-switch"><input id="le-consent-marketing" type="checkbox"/><span class="le-consent-switch-track" aria-hidden="true"></span><span class="sr-only">Ativar cookies de marketing</span></label></div>' +
          '<div class="le-consent-dialog-actions"><button class="le-consent-button" type="button" data-le-reject>Recusar opcionais</button><button class="le-consent-button le-consent-button--primary" type="button" data-le-save>Guardar preferências</button></div>' +
        '</div>' +
      '</section>';
    while (wrapper.firstChild) document.body.appendChild(wrapper.firstChild);

    var banner = document.getElementById('le-consent-banner');
    var modal = document.getElementById('le-consent-modal');
    var analyticsInput = document.getElementById('le-consent-analytics');
    var marketingInput = document.getElementById('le-consent-marketing');

    function closeModal() { modal.hidden = true; }
    function openModal() {
      var consent = state.consent || { analytics: false, marketing: false };
      analyticsInput.checked = Boolean(consent.analytics);
      marketingInput.checked = Boolean(consent.marketing);
      modal.hidden = false;
      document.querySelector('[data-le-close]').focus();
    }
    function choose(analytics, marketing) {
      var consent = saveConsent(analytics, marketing);
      applyConsent(consent, { forcePageView: true });
      banner.hidden = true;
      closeModal();
    }

    document.querySelectorAll('[data-le-accept]').forEach(function (button) { button.addEventListener('click', function () { choose(true, true); }); });
    document.querySelectorAll('[data-le-reject]').forEach(function (button) { button.addEventListener('click', function () { choose(false, false); }); });
    document.querySelectorAll('[data-le-manage]').forEach(function (button) { button.addEventListener('click', openModal); });
    document.querySelectorAll('[data-le-close]').forEach(function (button) { button.addEventListener('click', closeModal); });
    document.querySelectorAll('[data-le-save]').forEach(function (button) { button.addEventListener('click', function () { choose(analyticsInput.checked, marketingInput.checked); }); });
    document.querySelectorAll('[data-le-privacy]').forEach(function (link) {
      link.addEventListener('click', function (event) {
        event.preventDefault();
        closeModal();
        if (typeof window.showPage === 'function') window.showPage('privacy');
      });
    });
    modal.addEventListener('click', function (event) { if (event.target === modal) closeModal(); });
    document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && !modal.hidden) closeModal(); });

    window.LoveAnalytics.openPreferences = openModal;
    if (!state.consent) banner.hidden = false;
  }

  function safeProvidedItems(items) {
    return (Array.isArray(items) ? items : []).map(function (item) {
      return {
        item_id: cleanText(item.item_id || productIdByName(item.item_name), 80),
        item_name: safeFreeText(item.item_name, 100),
        item_category: cleanText(item.item_category || '', 100),
        item_variant: cleanText(item.item_variant || '', 60),
        price: roundMoney(item.price),
        quantity: Math.max(1, parseInt(item.quantity, 10) || 1)
      };
    }).filter(function (item) { return item.item_id && item.item_name !== '[redacted]'; });
  }

  function trackPurchase(order) {
    order = order || {};
    var transactionId = cleanText(order.transactionId || order.transaction_id, 64);
    if (!transactionId || containsLikelyPII(transactionId)) return false;
    var items = safeProvidedItems(order.items);
    if (!items.length) return false;
    var sent = parseJSON(safeStorageGet(window.localStorage, config.purchaseStorageKey), []);
    if (!Array.isArray(sent)) sent = [];
    if (sent.indexOf(transactionId) !== -1) return false;
    if (!track('purchase', {
      transaction_id: transactionId,
      currency: config.currency || 'EUR',
      value: roundMoney(order.value),
      tax: roundMoney(order.tax),
      shipping: roundMoney(order.shipping),
      coupon: cleanText(order.coupon || '', 60),
      items: items
    })) return false;
    sent.push(transactionId);
    safeStorageSet(window.localStorage, config.purchaseStorageKey, JSON.stringify(sent.slice(-100)));
    return true;
  }

  window.LoveAnalytics = {
    track: track,
    trackPageView: trackPageView,
    trackSearch: function (term, resultCount) {
      var safeTerm = safeFreeText(term, 80);
      if (!safeTerm || safeTerm === '[redacted]') return false;
      return track('search', { search_term: safeTerm, results_count: Math.max(0, parseInt(resultCount, 10) || 0) });
    },
    trackShippingInfo: function (shippingTier) {
      var items = cartItems();
      return items.length ? track('add_shipping_info', Object.assign(ecommerceParams(items, cartValue()), { shipping_tier: cleanText(shippingTier, 60) })) : false;
    },
    trackPaymentInfo: function (paymentType) {
      var items = cartItems();
      return items.length ? track('add_payment_info', Object.assign(ecommerceParams(items, cartValue()), { payment_type: cleanText(paymentType, 60) })) : false;
    },
    trackPurchase: trackPurchase,
    trackCheckoutError: function (step, code) { return track('checkout_error', { checkout_step: cleanText(step, 40), error_code: cleanText(code, 60) }); },
    openPreferences: function () {},
    getState: function () {
      return {
        configured: { ga4: isValidGA4Id(), clarity: isValidClarityId() },
        consent: state.consent,
        loaded: { ga4: state.gaLoaded, clarity: state.clarityLoaded },
        debug: state.debug,
        debugEventCount: debugEvents.length
      };
    },
    getDebugEvents: function () { return debugEvents.slice(); }
  };

  function init() {
    state.consent = getConsent();
    maskSensitiveAreas();
    renderConsentUI();
    installFunctionTracking();
    installClickTracking();
    installScrollTracking();
    installErrorTracking();
    installAbandonmentTracking();
    if (state.consent) applyConsent(state.consent, { forcePageView: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
