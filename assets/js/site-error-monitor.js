/* Love Essences - minimal error monitoring, without PII or cookies.
 * Only enabled after analytics consent; never transmits messages, URLs, contacts or order data.
 */
(function () {
  'use strict';

  var categories = ['form_submit', 'checkout', 'upload', 'script_error', 'promise_rejection'];
  var areas = ['contact', 'cart', 'checkout', 'shop', 'other'];
  var seen = Object.create(null);
  var total = 0;

  function consented() {
    try {
      var state = window.LoveAnalytics && window.LoveAnalytics.getState();
      return !!(state && state.consent && state.consent.analytics === true);
    } catch (_) { return false; }
  }

  function currentArea() {
    var path = window.location.pathname || '/';
    if (/^\/contactos\/?/.test(path) ||
        document.getElementById('page-contact')?.classList.contains('active')) return 'contact';
    if (/^\/checkout\/?/.test(path)) return 'checkout';
    if (document.getElementById('cart-drawer')?.classList.contains('open')) return 'cart';
    if (/^\/categorias\//.test(path) || /^\/loja\/?/.test(path)) return 'shop';
    return 'other';
  }

  function report(category, area) {
    try {
      if (!consented() || categories.indexOf(category) === -1) return false;
      area = areas.indexOf(area) === -1 ? currentArea() : area;
      var key = category + ':' + area;
      if (seen[key] || total >= 5) return false;
      var conf = window.LOVE_COMMERCE_CONFIG;
      if (!conf || !conf.enabled || !conf.supabaseUrl || !conf.supabaseAnonKey) return false;
      seen[key] = true;
      total += 1;
      fetch(String(conf.supabaseUrl).replace(/\/$/, '') + '/functions/v1/client-error-report', {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'apikey': conf.supabaseAnonKey },
        body: JSON.stringify({ category: category, area: area })
      }).catch(function () {});
      return true;
    } catch (_) { return false; }
  }

  window.LoveSiteMonitor = Object.freeze({ report: report });

  window.addEventListener('error', function (event) {
    if (event.target === window) report('script_error', currentArea());
  }, true);
  window.addEventListener('unhandledrejection', function () {
    report('promise_rejection', currentArea());
  });

  var formStarted = false;
  document.addEventListener('focusin', function (event) {
    if (formStarted || !event.target || !event.target.closest ||
        !event.target.closest('#contact-form')) return;
    formStarted = true;
    if (window.LoveAnalytics) {
      window.LoveAnalytics.track('form_start', { form_name: 'custom_project' });
    }
  }, true);
})();
