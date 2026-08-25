(function () {
  'use strict';

  var config = window.LOVE_COMMERCE_CONFIG || {};
  var DB_NAME = 'love-essences-commerce';
  var STORE_NAME = 'reference-files';
  var pendingProductFiles = [];
  var pendingFileWrites = [];
  var activeQuote = null;

  function assertConfigured() {
    if (!config.enabled || !/^https:\/\/.+\.supabase\.co$/.test(config.supabaseUrl || '') || !config.supabaseAnonKey || config.supabaseAnonKey.indexOf('YOUR_') === 0) {
      throw new Error('O checkout está preparado em modo de desenvolvimento, mas ainda falta ligar o projeto Supabase e as chaves de teste Stripe.');
    }
  }

  function functionUrl(name) {
    return String(config.supabaseUrl).replace(/\/$/, '') + '/functions/v1/' + name;
  }

  async function api(name, options) {
    assertConfigured();
    options = options || {};
    var response = await fetch(functionUrl(name) + (options.query || ''), {
      method: options.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': config.supabaseAnonKey,
        'Authorization': 'Bearer ' + config.supabaseAnonKey
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.message || 'Não foi possível concluir a operação.');
    return data;
  }

  function openDatabase() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  async function putFiles(lineKey, files) {
    var database = await openDatabase();
    return new Promise(function (resolve, reject) {
      var transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(Array.prototype.slice.call(files), lineKey);
      transaction.oncomplete = function () { database.close(); resolve(); };
      transaction.onerror = function () { database.close(); reject(transaction.error); };
    });
  }

  async function getFiles(lineKey) {
    var database = await openDatabase();
    return new Promise(function (resolve, reject) {
      var transaction = database.transaction(STORE_NAME, 'readonly');
      var request = transaction.objectStore(STORE_NAME).get(lineKey);
      request.onsuccess = function () { database.close(); resolve(request.result || []); };
      request.onerror = function () { database.close(); reject(request.error); };
    });
  }

  async function deleteFiles(lineKey) {
    var database = await openDatabase();
    return new Promise(function (resolve, reject) {
      var transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(lineKey);
      transaction.oncomplete = function () { database.close(); resolve(); };
      transaction.onerror = function () { database.close(); reject(transaction.error); };
    });
  }

  function validateFiles(fileList, maximum) {
    var files = Array.prototype.slice.call(fileList || []);
    var allowed = ['image/jpeg', 'image/png', 'application/pdf'];
    if (files.length > maximum) throw new Error('Podes enviar até ' + maximum + ' ficheiros.');
    files.forEach(function (file) {
      if (allowed.indexOf(file.type) === -1) throw new Error('Apenas são aceites ficheiros JPG, PNG e PDF.');
      if (file.size < 1 || file.size > 10 * 1024 * 1024) throw new Error('Cada ficheiro pode ter no máximo 10 MB.');
    });
    return files;
  }

  function setProductFiles(fileList) {
    pendingProductFiles = validateFiles(fileList, 3);
    var status = document.getElementById('pd-reference-status');
    if (status) status.textContent = pendingProductFiles.length ? pendingProductFiles.length + ' ficheiro(s) selecionado(s)' : 'Nenhum ficheiro selecionado';
  }

  async function attachProductFiles(lineKey) {
    if (!pendingProductFiles.length) return;
    var write = putFiles(lineKey, pendingProductFiles);
    pendingFileWrites.push(write);
    try { await write; }
    finally { pendingFileWrites = pendingFileWrites.filter(function (pending) { return pending !== write; }); }
    pendingProductFiles = [];
    var input = document.getElementById('pd-reference-files');
    var status = document.getElementById('pd-reference-status');
    if (input) input.value = '';
    if (status) status.textContent = 'Nenhum ficheiro selecionado';
  }

  async function uploadSigned(file, target) {
    var fullPath = ['private-references'].concat(target.path.split('/')).map(encodeURIComponent).join('/');
    var url = String(config.supabaseUrl).replace(/\/$/, '') + '/storage/v1/object/upload/sign/' + fullPath + '?token=' + encodeURIComponent(target.token);
    var uploadBody = new FormData();
    uploadBody.append('cacheControl', '3600');
    uploadBody.append('', file);
    var response = await fetch(url, {
      method: 'PUT',
      headers: { 'apikey': config.supabaseAnonKey, 'Authorization': 'Bearer ' + config.supabaseAnonKey, 'x-upsert': 'false' },
      body: uploadBody
    });
    if (!response.ok) throw new Error('Não foi possível enviar o ficheiro ' + file.name + '.');
  }

  function inferProductCode(name) {
    var map = window.LOVE_PRODUCT_CODE_BY_NAME || {};
    var base = typeof window.getCartBaseName === 'function' ? window.getCartBaseName(name) : String(name || '').split(',')[0].replace(/\s*\([^)]*\)\s*$/, '').trim();
    return map[base] || '';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character];
    });
  }

  function formatMoney(cents, currency) {
    return new Intl.NumberFormat('pt-PT', { style: 'currency', currency: String(currency || 'eur').toUpperCase() }).format((Number(cents) || 0) / 100);
  }

  async function startCatalogCheckout(button) {
    if (button) { button.disabled = true; button.textContent = 'A preparar pagamento…'; }
    try {
      assertConfigured();
      await Promise.all(pendingFileWrites.slice());
      if (!Array.isArray(window.cart) || !window.cart.length) throw new Error('O carrinho está vazio.');
      if (window.shippingDestination !== 'mainland') throw new Error('O checkout direto está disponível para Portugal Continental. Para outros destinos, fala connosco através de “Cria algo só teu”.');
      var flatFiles = [];
      var items = [];
      for (var index = 0; index < window.cart.length; index += 1) {
        var item = window.cart[index];
        var lineKey = item.lineKey || ('legacy-' + index);
        var files = await getFiles(lineKey);
        var productCode = item.productCode || inferProductCode(item.name);
        if (!productCode) throw new Error('Volta a adicionar “' + item.name + '” ao carrinho para atualizar os dados do produto.');
        var variantCode = item.variantCode || (productCode + ':default');
        var descriptors = files.map(function (file) { return { name: file.name, type: file.type, size: file.size }; });
        files.forEach(function (file) { flatFiles.push(file); });
        items.push({
          lineKey: lineKey, productCode: productCode, variantCode: variantCode, quantity: Number(item.qty) || 1,
          personalization: item.personalization || {}, addonCodes: item.addonCodes || [], attachments: descriptors
        });
      }
      var prepared = await api('checkout-prepare', { body: { items: items, shippingDestination: window.shippingDestination, turnstileToken: window.LoveTurnstileToken || null } });
      for (var fileIndex = 0; fileIndex < flatFiles.length; fileIndex += 1) {
        await uploadSigned(flatFiles[fileIndex], prepared.uploads[fileIndex]);
        await api('attachment-confirm', { body: { attachmentId: prepared.uploads[fileIndex].attachmentId, ownerToken: prepared.orderToken } });
      }
      var session = await api('checkout-session', { body: { orderId: prepared.orderId, orderToken: prepared.orderToken } });
      localStorage.setItem('le_pending_checkout', JSON.stringify({ orderNumber: prepared.orderNumber, cartSignature: typeof window.getCartSignature === 'function' ? window.getCartSignature() : '' }));
      window.location.assign(session.checkoutUrl);
    } catch (error) {
      alert(error.message || 'Não foi possível iniciar o pagamento.');
      if (button) { button.disabled = false; button.textContent = 'Avançar para pagamento seguro'; }
      if (window.LoveAnalytics) window.LoveAnalytics.trackCheckoutError('stripe_checkout', 'prepare_error');
    }
  }

  async function submitProject(form) {
    var data = new FormData(form);
    var files = validateFiles(data.getAll('inspiracoes').filter(function (value) { return value instanceof File && value.size; }), 5);
    var payload = {
      action: 'prepare', name: data.get('nome'), email: data.get('email'), phone: data.get('telefone'),
      occasion: data.get('ocasiao'), projectType: data.get('tipo_projeto'), approximateQuantity: data.get('quantidade'),
      eventDate: data.get('data_evento'), approximateBudget: data.get('orcamento'), idea: data.get('ideia'),
      privacyAccepted: data.get('privacidade') === 'on', turnstileToken: window.LoveTurnstileToken || null,
      attachments: files.map(function (file) { return { name: file.name, type: file.type, size: file.size }; })
    };
    var prepared = await api('project-submit', { body: payload });
    for (var index = 0; index < files.length; index += 1) {
      await uploadSigned(files[index], prepared.uploads[index]);
      await api('attachment-confirm', { body: { attachmentId: prepared.uploads[index].attachmentId, ownerToken: prepared.projectToken } });
    }
    if (files.length) await api('project-submit', { body: { action: 'finalize', projectId: prepared.projectId, projectToken: prepared.projectToken } });
    return prepared;
  }

  async function loadConfirmation() {
    var page = document.getElementById('page-confirmation');
    if (!page || !page.classList.contains('active')) return;
    var sessionId = new URLSearchParams(window.location.search).get('session_id');
    var status = document.getElementById('confirmation-status');
    if (!sessionId) { if (status) status.textContent = 'Não encontrámos a referência do pagamento.'; return; }
    try {
      var result = await api('order-status', { method: 'GET', query: '?session_id=' + encodeURIComponent(sessionId) });
      document.getElementById('confirmation-number').textContent = result.orderNumber || '';
      if (result.paid) {
        if (status) status.textContent = 'Pagamento confirmado. A tua encomenda vai agora seguir para preparação.';
        var pending = JSON.parse(localStorage.getItem('le_pending_checkout') || '{}');
        if (typeof window.completeCartCheckout === 'function') window.completeCartCheckout(pending.cartSignature || '');
        localStorage.removeItem('le_pending_checkout');
      } else if (status) status.textContent = 'O pagamento está a ser confirmado. Atualiza esta página dentro de alguns instantes.';
    } catch (error) { if (status) status.textContent = error.message; }
  }

  async function loadQuote() {
    var page = document.getElementById('page-quote');
    if (!page || !page.classList.contains('active')) return;
    var params = new URLSearchParams(window.location.search);
    var quoteId = params.get('quote');
    var token = params.get('token');
    var content = document.getElementById('quote-content');
    var errorEl = document.getElementById('quote-error');
    if (!quoteId || !token) { if (content) content.innerHTML = '<p>Esta ligação não contém uma proposta válida.</p>'; return; }
    try {
      var quote = await api('quote-details', { method: 'GET', query: '?quote=' + encodeURIComponent(quoteId) + '&token=' + encodeURIComponent(token) });
      activeQuote = { id: quoteId, token: token, status: quote.status };
      document.getElementById('quote-reference').textContent = quote.projectNumber + ' · proposta v' + quote.version;
      var lines = (quote.items || []).map(function (item) {
        return '<div class="quote-line"><span>' + escapeHtml(item.quantity) + ' × ' + escapeHtml(item.description) + '</span><span>' + formatMoney(item.line_amount, quote.currency) + '</span></div>';
      }).join('');
      var totals = '<div class="quote-totals">' +
        '<div class="quote-total-row"><span>Subtotal</span><span>' + formatMoney(quote.subtotalAmount, quote.currency) + '</span></div>' +
        (quote.discountAmount ? '<div class="quote-total-row"><span>Desconto</span><span>−' + formatMoney(quote.discountAmount, quote.currency) + '</span></div>' : '') +
        '<div class="quote-total-row"><span>Envio</span><span>' + formatMoney(quote.shippingAmount, quote.currency) + '</span></div>' +
        '<div class="quote-total-row quote-total-row--grand"><span>Total</span><span>' + formatMoney(quote.totalAmount, quote.currency) + '</span></div></div>';
      content.innerHTML = lines + totals + (quote.notes ? '<p><strong>Notas:</strong> ' + escapeHtml(quote.notes) + '</p>' : '') + (quote.validUntil ? '<p>Proposta válida até ' + escapeHtml(quote.validUntil) + '.</p>' : '');
      if (quote.status === 'paid') {
        document.getElementById('quote-pay-button').disabled = true;
        document.getElementById('quote-pay-button').textContent = 'Proposta já paga';
        document.getElementById('quote-approval').disabled = true;
      }
    } catch (error) {
      if (content) content.innerHTML = '<p>Não foi possível apresentar esta proposta.</p>';
      if (errorEl) errorEl.textContent = error.message;
    }
  }

  async function approveQuote(button) {
    var errorEl = document.getElementById('quote-error');
    if (errorEl) errorEl.textContent = '';
    if (!activeQuote) { if (errorEl) errorEl.textContent = 'A proposta ainda não está disponível.'; return; }
    if (!document.getElementById('quote-approval').checked) { if (errorEl) errorEl.textContent = 'Confirma primeiro que aprovas a proposta.'; return; }
    button.disabled = true;
    button.textContent = 'A preparar pagamento…';
    try {
      var result = await api('quote-checkout', { body: { quoteId: activeQuote.id, quoteToken: activeQuote.token, approve: true } });
      window.location.assign(result.checkoutUrl);
    } catch (error) {
      if (errorEl) errorEl.textContent = error.message;
      button.disabled = false;
      button.textContent = 'Aprovar e avançar para pagamento';
    }
  }

  window.LoveCommerce = {
    api: api,
    configured: function () { try { assertConfigured(); return true; } catch (_) { return false; } },
    setProductFiles: setProductFiles,
    attachProductFiles: attachProductFiles,
    deleteFiles: deleteFiles,
    startCatalogCheckout: startCatalogCheckout,
    submitProject: submitProject,
    loadConfirmation: loadConfirmation,
    loadQuote: loadQuote,
    approveQuote: approveQuote
  };

  document.addEventListener('DOMContentLoaded', function () { loadConfirmation(); loadQuote(); });
  window.addEventListener('popstate', function () { setTimeout(function () { loadConfirmation(); loadQuote(); }, 0); });
})();
