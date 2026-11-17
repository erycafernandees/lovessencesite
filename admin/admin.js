import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const config = window.LOVE_COMMERCE_CONFIG || {};
const loginCard = document.getElementById('login-card');
const mfaCard = document.getElementById('mfa-card');
const authShell = document.getElementById('auth-shell');
const app = document.getElementById('admin-app');
const drawer = document.getElementById('detail-drawer');
let unifiedEditorController = null;
const backdrop = document.getElementById('drawer-backdrop');
let currentView = 'orders';
let searchTerm = '';
let statusFilter = '';
let channelFilter = '';
let testFilter = 'real';
const selectedTestOrders = new Set();
const selectedDraftOrders = new Set();
const ORDER_LABELS = {draft:'Rascunho',awaiting_payment:'A aguardar pagamento',confirmed:'Confirmada',review:'Em análise',awaiting_details:'A aguardar detalhes',production:'Em produção',ready_to_ship:'Pronta para enviar',shipped:'Enviada',completed:'Concluída',cancelled:'Cancelada'};
const QUOTE_LABELS = {draft:'Rascunho',sent:'Enviado',approved:'Aprovado',paid:'Pago',expired:'Expirado',cancelled:'Cancelado'};
const PROJECT_FULFILLMENT_STATES = ['confirmed','review','awaiting_details','production','ready_to_ship','shipped','completed','cancelled'];
const PROJECT_LABELS = {draft:'Rascunho',submitted:'Recebido',in_review:'Em análise',awaiting_details:'A aguardar detalhes',quoted:'Orçamentado',approved:'Aprovado',payment_pending:'A aguardar pagamento',paid:'Pago',production:'Em produção',completed:'Concluído',declined:'Recusado',archived:'Arquivado'};
function updateStatusOptions() {
  const labels = currentView === 'orders' ? ORDER_LABELS : Object.fromEntries(PROJECT_FULFILLMENT_STATES.map(value => [value, ORDER_LABELS[value]]));
  const select = document.getElementById('admin-status');
  select.innerHTML = '<option value="">Todos os estados</option>' + Object.entries(labels).map(([value,label]) => `<option value="${value}">${label}</option>`).join('');
  select.value = statusFilter;
}
document.getElementById('admin-status').addEventListener('change', event => { statusFilter = event.target.value; renderFilteredRows(); });
document.getElementById('admin-channel').addEventListener('change', event => { channelFilter = event.target.value; renderFilteredRows(); });
document.getElementById('admin-tests').addEventListener('change', event => { testFilter = event.target.value; loadView(); });
let currentRows = [];
function filterRows(rows) {
  const q = searchTerm.trim().toLocaleLowerCase('pt-PT');
  return rows.filter(row => (currentView !== 'orders' || ((testFilter === 'all' || Boolean(row.is_test) === (testFilter === 'test')) && (!channelFilter || row.sales_channel === channelFilter))) && (!statusFilter || (currentView === 'orders' ? row.order_status : row.fulfillment_status) === statusFilter) && (!q || [row.order_number,row.project_number,row.customer_name,row.customer_email].some(value => String(value || '').toLocaleLowerCase('pt-PT').includes(q))));
}
document.getElementById('admin-search').addEventListener('input', event => { searchTerm = event.target.value; renderFilteredRows(); });
function renderFilteredRows() { if (currentView === 'orders') renderOrderRows(currentRows); else renderProjectRows(currentRows); }

let pendingFactorId = null;
let pendingChallengeId = null;

if (!config.enabled || !config.supabaseUrl || !config.supabaseAnonKey) {
  document.getElementById('login-error').textContent = 'Configura primeiro o projeto Supabase de desenvolvimento em commerce-config.js.';
  document.querySelector('#login-form button').disabled = true;
}

const supabase = createClient(config.supabaseUrl || 'https://invalid.supabase.co', config.supabaseAnonKey || 'invalid', { auth: { persistSession: true, autoRefreshToken: true } });

function money(cents, currency = 'eur') { return new Intl.NumberFormat('pt-PT', { style: 'currency', currency: currency.toUpperCase() }).format((Number(cents) || 0) / 100); }
// Encomendas manuais não têm registo Stripe: quando estão pagas e não há taxas,
// o líquido recebido corresponde ao total da encomenda. Nunca assumir que
// um pagamento Stripe sem dados de taxas tem o mesmo líquido que o bruto.
function paymentAmounts(order) {
  const payment = order.payments?.[0] || {};
  const manualPaid = order.payment_provider === 'manual' && order.payment_status === 'paid';
  const manualPartial = order.payment_provider === 'manual' && order.payment_status === 'unpaid' && Number(order.manual_received_amount || 0) > 0;
  return {
    payment,
    grossAmount: payment.gross_amount ?? order.total_amount,
    feeAmount: payment.processing_fee_amount ?? (manualPaid || manualPartial ? 0 : null),
    netAmount: payment.net_amount ?? (manualPaid ? order.total_amount : manualPartial ? order.manual_received_amount : null)
  };
}
function isNewOrder(order) { return !order.admin_seen_at && order.order_status !== 'completed'; }
function isDeletableDraft(order) {
  return !order.is_test && order.order_status === 'draft' && order.payment_status === 'unpaid' && !order.paid_at && !Number(order.manual_received_amount || 0);
}
function isNewProject(project) { return !project.admin_seen_at && project.fulfillment_status !== 'completed'; }
function lastProjectQuote(project, paidOnly = false) {
  return [...(project.quotes || [])]
    .filter(quote => !['expired','cancelled'].includes(quote.status) &&
      (!paidOnly || quote.status === 'paid') &&
      Number.isFinite(Number(quote.total_amount)) && Number(quote.total_amount) >= 0)
    .sort((a, b) => Number(b.version || 0) - Number(a.version || 0) ||
      Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))[0] || null;
}
function projectReceivedAmount(project) {
  const linkedOrders = [...(project.orders || [])].sort((a,b) =>
    Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
  const paidOrder = linkedOrders.find(order =>
    ['paid','partially_refunded','refunded'].includes(order.payment_status));
  if (paidOrder) {
    if (paidOrder.payment_status === 'refunded') return 0;
    const refunded = (paidOrder.payments || []).reduce((sum,payment) =>
      sum + Number(payment.refunded_amount || 0), 0);
    return Math.max(0, Number(paidOrder.total_amount || 0) - refunded);
  }
  return Number(project.payment_received_amount || 0);
}
function projectPaymentStage(project) {
  const quote = lastProjectQuote(project);
  if (!quote) return 'no_quote';
  const total = Number(quote.total_amount || 0);
  const received = projectReceivedAmount(project);
  if (total === 0) return 'no_quote';
  if (received >= total) return 'paid';
  if (received === 0) return 'unpaid';
  if (Math.abs(received * 2 - total) <= 1) return 'half_paid';
  return 'partially_paid';
}
function projectPaymentBadge(project) {
  const stage = projectPaymentStage(project);
  return stage === 'no_quote'
    ? '<span class="badge no_quote">Sem orçamento</span>'
    : badge(stage);
}
function orderReceivedAmount(order) {
  return order.payment_provider === 'manual'
    ? (order.payment_status === 'paid' ? Number(order.total_amount || 0) : Number(order.manual_received_amount || 0))
    : (order.payment_status === 'paid' ? Number(order.payments?.[0]?.gross_amount ?? order.total_amount) : 0);
}
function orderPaymentBadge(order) {
  if (order.payment_provider === 'manual' && order.payment_status === 'unpaid') {
    const received = Number(order.manual_received_amount || 0);
    const total = Number(order.total_amount || 0);
    if (received > 0 && received < total) return badge(Math.abs(received * 2 - total) <= 1 ? 'half_paid' : 'partially_paid');
  }
  return badge(order.payment_status);
}
function date(value) { return value ? new Intl.DateTimeFormat('pt-PT', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—'; }
function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
function badge(value) { const labels = {...ORDER_LABELS,...PROJECT_LABELS,...QUOTE_LABELS,unpaid:'Por pagar',partially_paid:'Pagamento parcial',half_paid:'50% pago',deposit_paid:'Sinal recebido'}; return `<span class="badge ${esc(value)}">${esc(labels[value] || String(value || '').replaceAll('_', ' '))}</span>`; }

const CTT_TRACKING_PAGE = 'https://www.ctt.pt/feapl_2/app/open/objectSearch/objectSearch.jspx';
function deliverySummary(record) {
  if (record.delivery_method === 'ctt') {
    return '<span class="badge delivery-ctt">CTT</span>';
  }
  if (record.delivery_method === 'hand_delivery') {
    return '<span class="badge delivery-hand">Em mãos</span>';
  }
  return '—';
}
function localDeliveryDateInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function deliveryAddressHtml(record) {
  const shipping = record.shipping_address;
  const address = shipping?.address || shipping;
  if (!address || typeof address !== 'object') return '';
  const street = [address.line1, address.line2].filter(Boolean).map(value => String(value).trim()).filter(Boolean);
  const location = [address.postal_code, address.city].filter(Boolean).map(value => String(value).trim()).join(' ');
  const region = address.state && String(address.state).trim().toLowerCase() !== String(address.city || '').trim().toLowerCase() ? String(address.state).trim() : '';
  const country = address.country === 'PT' ? 'Portugal' : (address.country || '');
  const lines = [...street, location, region, country].filter(Boolean);
  if (!lines.length) return '';
  const recipient = shipping?.name && shipping.name !== record.customer_name
    ? `<p><strong>Destinatário</strong> ${esc(shipping.name)}</p>` : '';
  return `<div class="delivery-address"><strong>Morada de entrega</strong>${recipient}<p>${lines.map(esc).join('<br>')}</p></div>`;
}
function deliveryReadOnlyDetails(record) {
  const parts = [];
  if (record.delivery_method === 'ctt' && record.delivery_tracking_code) {
    parts.push('<p><strong>Código CTT</strong> <span class="delivery-code">' + esc(record.delivery_tracking_code) + '</span> · <a href="' + CTT_TRACKING_PAGE + '" target="_blank" rel="noopener noreferrer">Ver rastreio</a></p>');
  }
  if (record.delivery_method === 'hand_delivery') {
    if (record.delivery_meeting_place) parts.push('<p><strong>Local combinado</strong> ' + esc(record.delivery_meeting_place) + '</p>');
    if (record.delivery_meeting_at) {
      const d = new Date(record.delivery_meeting_at);
      if (Number.isFinite(d.getTime())) parts.push('<p><strong>Data combinada</strong> ' + esc(d.toLocaleString('pt-PT', {dateStyle:'medium',timeStyle:'short'})) + '</p>');
    }
  }
  if (record.delivery_notes) parts.push('<p><strong>Notas da entrega</strong> ' + esc(record.delivery_notes) + '</p>');
  return parts.length ? '<div class="delivery-readonly-details">' + parts.join('') + '</div>' : '';
}
function deliveryFormHtml(record) {
  const method = record.delivery_method || '';
  const tracking = String(record.delivery_tracking_code || '');
  return `<div class="detail-section delivery-section">
    <h3>Entrega</h3>
    <p class="order-current-status">${deliverySummary(record)}</p>
    ${deliveryAddressHtml(record)}
    ${deliveryReadOnlyDetails(record)}
    <form id="admin-delivery-form" class="order-payment-form">
      <label>Modalidade de entrega
        <select name="deliveryMethod">
          <option value="" ${!method ? 'selected' : ''}>Por definir</option>
          <option value="ctt" ${method === 'ctt' ? 'selected' : ''}>Envio pelos CTT</option>
          <option value="hand_delivery" ${method === 'hand_delivery' ? 'selected' : ''}>Entrega em mãos</option>
        </select>
      </label>
      <div class="delivery-method-fields" id="delivery-ctt-fields" ${method === 'ctt' ? '' : 'hidden'}>
        <label>Código de rastreio dos CTT
          <input type="text" name="trackingCode" maxlength="60" autocomplete="off"
            placeholder="Ex.: RR123456789PT" value="${esc(tracking)}">
        </label>
        ${tracking ? `<button class="secondary delivery-copy-button" type="button" id="delivery-copy-code">Copiar código</button>` : ''}
        <a class="delivery-tracking-link" href="${CTT_TRACKING_PAGE}" target="_blank" rel="noopener noreferrer">Abrir o rastreio oficial dos CTT</a>
        <small>Consulta o estado do envio introduzindo o código no site dos CTT.</small>
      </div>
      <div class="delivery-method-fields" id="delivery-hand-fields" ${method === 'hand_delivery' ? '' : 'hidden'}>
        <label>Local combinado
          <input name="meetingPlace" type="text" maxlength="250" placeholder="Ex.: Cascais, junto à estação"
            value="${esc(record.delivery_meeting_place || '')}">
        </label>
        <label>Data e hora combinadas
          <input name="meetingAt" type="datetime-local" value="${esc(localDeliveryDateInput(record.delivery_meeting_at))}">
        </label>
      </div>
      <label id="delivery-notes-label" ${method ? '' : 'hidden'}>Notas da entrega (internas)
        <textarea name="deliveryNotes" rows="2" maxlength="1000" placeholder="Ex.: Contactar antes de sair">${esc(record.delivery_notes || '')}</textarea>
      </label>
      <p class="order-payment-hint">Estas informações são privadas e não enviam notificações à cliente.</p>
      <p id="delivery-form-error" class="error" role="alert"></p>
      <button type="submit">Guardar entrega</button>
    </form>
  </div>`;
}
function bindDeliveryForm(record,kind,id) {
  const form = document.getElementById('admin-delivery-form');
  if (!form) return;
  const select = form.elements.deliveryMethod;
  const cttFields = document.getElementById('delivery-ctt-fields');
  const handFields = document.getElementById('delivery-hand-fields');
  const noteLabel = document.getElementById('delivery-notes-label');
  const errorElement = document.getElementById('delivery-form-error');
  const updateFields = () => {
    cttFields.hidden = select.value !== 'ctt';
    handFields.hidden = select.value !== 'hand_delivery';
    noteLabel.hidden = !select.value;
  };
  select.addEventListener('change',updateFields);
  updateFields();
  const copyButton = document.getElementById('delivery-copy-code');
  copyButton?.addEventListener('click',async () => {
    const input = form.elements.trackingCode;
    const code = input.value.trim();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      copyButton.textContent = 'Copiado!';
    } catch (error) {
      input.focus();
      input.select();
      window.alert('Seleciona o código e copia-o com Cmd + C.');
    }
  });
  form.addEventListener('submit',async event => {
    event.preventDefault();
    errorElement.textContent = '';
    const button = form.querySelector('button[type="submit"]');
    const method = select.value;
    let meetingAt = null;
    if (method === 'hand_delivery' && form.elements.meetingAt.value) {
      const d = new Date(form.elements.meetingAt.value);
      if (!Number.isFinite(d.getTime())) {
        errorElement.textContent = 'A data e hora não são válidas.';
        return;
      }
      meetingAt = d.toISOString();
    }
    button.disabled = true;
    try {
      await adminApi('set-delivery',{
        kind,id,deliveryMethod:method,
        trackingCode: method === 'ctt' ? form.elements.trackingCode.value : '',
        meetingPlace: method === 'hand_delivery' ? form.elements.meetingPlace.value : '',
        meetingAt,
        deliveryNotes:method ? form.elements.deliveryNotes.value : ''
      });
      if(kind === 'order') {
        await loadOrders();
        await openOrder(id);
      } else {
        await loadProjects();
        await openProject(id);
      }
    } catch(error) {
      errorElement.textContent = error.message || 'Não foi possível guardar a entrega.';
      button.disabled = false;
    }
  });
}
async function adminApi(action, body = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('A sessão terminou.');
  const response = await fetch(`${config.supabaseUrl}/functions/v1/admin-api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey, Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ action, ...body })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || 'Não foi possível carregar os dados.');
  return data;
}

async function ensureMfa() {
  const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (assuranceError) throw assuranceError;
  if (assurance?.currentLevel === 'aal2') return showApp();
  const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
  if (factorsError) throw factorsError;
  const existing = factors?.all?.filter(item => (item.factor_type || item.type) === 'totp') || [];
  let factor = existing.find(item => item.status === 'verified');
  const enrolment = document.getElementById('mfa-enrolment');
  enrolment.hidden = true;
  if (!factor) {
    // Incomplete enrolments must be explicitly replaced; a second factor
    // with the same friendly name would otherwise fail to enrol.
    for (const stale of existing.filter(item => item.status !== 'verified')) {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: stale.id });
      if (error) throw new Error('Não foi possível reiniciar o MFA. Contacta o suporte.');
    }
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Love Essences Admin ${Date.now()}` });
    if (error) throw error;
    factor = data;
    enrolment.hidden = false;
    document.getElementById('mfa-qr').src = data.totp.qr_code;
  }
  pendingFactorId = factor.id;
  pendingChallengeId = null;
  loginCard.hidden = true;
  mfaCard.hidden = false;
}

async function showApp() {
  // Show the admin area immediately after MFA succeeds; profile lookup must not block it.
  authShell.hidden = true;
  loginCard.hidden = true;
  mfaCard.hidden = true;
  app.hidden = false;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    document.getElementById('admin-email').textContent = user?.email || '';
  } catch (error) {
    console.warn('Admin profile lookup failed after MFA:', error);
  }
  await loadView();
}

document.getElementById('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  try {
    const { error } = await supabase.auth.signInWithPassword({ email: form.get('email'), password: form.get('password') });
    if (error) throw error;
    await ensureMfa();
  } catch (error) { errorEl.textContent = error.message; }
});

document.getElementById('mfa-form').addEventListener('submit', async event => {
  event.preventDefault();
  const code = new FormData(event.currentTarget).get('code');
  const errorEl = document.getElementById('mfa-error');
  try {
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: pendingFactorId, code: String(code).trim() });
    if (error) throw error;
    await showApp();
  } catch (error) { errorEl.textContent = error.message === 'Invalid TOTP code entered' ? 'Código inválido. Confirma que estás a usar a entrada mais recente da aplicação autenticadora e que a hora do telemóvel está automática.' : error.message; }
});


const manualModal = document.getElementById('manual-modal');
document.getElementById('new-order-button').addEventListener('click', () => { manualModal.hidden = false; document.getElementById('manual-error').textContent = ''; });
document.getElementById('manual-close').addEventListener('click', () => { manualModal.hidden = true; });
document.getElementById('manual-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const button = form.querySelector('button[type=submit]');
  const error = document.getElementById('manual-error');
  const euros = String(values.get('totalEuros') || '').replace(',', '.');
  const amount = Number(euros);
  if (!Number.isFinite(amount) || amount < 0 || !/^\d+(?:\.\d{1,2})?$/.test(euros)) { error.textContent = 'Introduz um valor válido com até duas casas decimais.'; return; }
  button.disabled = true;
  error.textContent = '';
  try {
    const photos = [...(form.querySelector('[name=referencePhotos]').files || [])];
    if (photos.length > 10 || photos.some(file => !['image/jpeg','image/png'].includes(file.type) || file.size > 10485760)) throw new Error('Escolhe até 10 fotografias JPG/PNG, com um máximo de 10 MB cada.');
    const created = await adminApi('create-manual-order', {
      channel: values.get('channel'), customerName: values.get('customerName'),
      customerEmail: values.get('customerEmail'), customerPhone: values.get('customerPhone'),
      description: values.get('description'), quantity: Number(values.get('quantity')),
      totalAmount: Math.round(amount * 100), paymentStatus: values.get('paymentStatus'),
      notes: values.get('notes'), isTest: values.has('isTest')
    });
    for (const file of photos) {
      const prepared = await adminApi('prepare-order-photo',{orderId:created.orderId,fileName:file.name,mimeType:file.type,sizeBytes:file.size});
      const { error: uploadError } = await supabase.storage.from('private-references').uploadToSignedUrl(prepared.path,prepared.token,file,{contentType:file.type});
      if (uploadError) throw uploadError;
      await adminApi('finish-order-photo',{attachmentId:prepared.attachmentId});
    }
    form.reset();
    manualModal.hidden = true;
    currentView = 'orders';
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === 'orders'));
    testFilter = 'real'; document.getElementById('admin-tests').value = 'real';
    channelFilter = ''; document.getElementById('admin-channel').value = '';
    statusFilter = '';
    await loadView();
  } catch (e) { error.textContent = e.message; }
  finally { button.disabled = false; }
});

document.getElementById('logout-button').addEventListener('click', async () => { await supabase.auth.signOut(); location.reload(); });
document.getElementById('refresh-button').addEventListener('click', loadView);
document.getElementById('select-draft-page').addEventListener('change', event => {
  const ids = filterRows(currentRows).filter(isDeletableDraft).map(order => order.id);
  for (const id of ids) {
    if (event.target.checked) selectedDraftOrders.add(id);
    else selectedDraftOrders.delete(id);
  }
  renderOrderRows(currentRows);
});
document.getElementById('bulk-delete-selected-drafts').addEventListener('click', () => deleteDraftOrdersInBulk([...selectedDraftOrders]));
document.getElementById('bulk-delete-all-drafts').addEventListener('click', () => deleteDraftOrdersInBulk());

async function deleteDraftOrdersInBulk(ids = null) {
  const buttons = ['bulk-delete-selected-drafts', 'bulk-delete-all-drafts'].map(id => document.getElementById(id));
  buttons.forEach(button => { button.disabled = true; });
  try {
    const preview = await adminApi('bulk-delete-draft-orders', { preview: true, ...(ids ? { ids } : {}) });
    if (!preview.eligibleCount) {
      window.alert('Não foram encontrados rascunhos elegíveis para eliminação. As encomendas com pagamentos ou sessões de checkout ficam protegidas.');
      return;
    }
    const protectedNote = preview.skippedCount
      ? '\n' + preview.skippedCount + ' encomenda(s) serão preservadas por estarem protegidas.'
      : '';
    if (!window.confirm('Eliminar definitivamente ' + preview.eligibleCount +
      ' rascunho(s) por pagar?\nEsta ação não pode ser anulada.' + protectedNote)) return;
    const result = await adminApi('bulk-delete-draft-orders', {
      ids: preview.eligibleIds, confirmation: 'ELIMINAR_RASCUNHOS'
    });
    window.alert(result.deletedCount + ' rascunho(s) eliminado(s).' +
      (result.skippedCount ? ' ' + result.skippedCount + ' encomenda(s) foram preservadas.' : ''));
    selectedDraftOrders.clear();
    await loadOrders();
  } catch (error) {
    window.alert(error.message || 'Não foi possível eliminar os rascunhos.');
  } finally {
    updateBulkDraftActions();
  }
}

function updateBulkDraftActions() {
  const area = document.getElementById('draft-bulk-actions');
  const visible = currentView === 'orders' && testFilter === 'real';
  area.hidden = !visible;
  if (!visible) return;
  const ids = filterRows(currentRows).filter(isDeletableDraft).map(row => row.id);
  const checkbox = document.getElementById('select-draft-page');
  const all = ids.length > 0 && ids.every(id => selectedDraftOrders.has(id));
  checkbox.checked = all;
  checkbox.indeterminate = !all && ids.some(id => selectedDraftOrders.has(id));
  checkbox.disabled = ids.length === 0;
  document.getElementById('selected-draft-count').textContent = selectedDraftOrders.size + ' selecionada(s)';
  document.getElementById('bulk-delete-selected-drafts').disabled = selectedDraftOrders.size === 0;
}

document.getElementById('select-test-page').addEventListener('change', event => {
  const ids = filterRows(currentRows).filter(order => order.is_test).map(order => order.id);
  for (const id of ids) {
    if (event.target.checked) selectedTestOrders.add(id);
    else selectedTestOrders.delete(id);
  }
  renderOrderRows(currentRows);
});
document.getElementById('bulk-delete-selected').addEventListener('click', () => deleteTestOrdersInBulk([...selectedTestOrders]));
document.getElementById('bulk-delete-all-tests').addEventListener('click', () => deleteTestOrdersInBulk());

async function deleteTestOrdersInBulk(ids = null) {
  const buttons = ['bulk-delete-selected', 'bulk-delete-all-tests'].map(id => document.getElementById(id));
  buttons.forEach(button => { button.disabled = true; });
  try {
    const preview = await adminApi('bulk-delete-test-orders', { preview: true, ...(ids ? { ids } : {}) });
    if (!preview.eligibleCount) {
      window.alert('Não existem encomendas de teste elegíveis para eliminar. Os testes pagos ou com processos de pagamento são preservados.');
      return;
    }
    const skipped = preview.skippedCount
      ? '\n' + preview.skippedCount + ' encomenda(s) serão preservadas por terem pagamentos associados ou estarem protegidas.'
      : '';
    if (!window.confirm('Eliminar definitivamente ' + preview.eligibleCount +
      ' encomenda(s) de teste?\nEsta ação não pode ser anulada.' + skipped)) return;
    const result = await adminApi('bulk-delete-test-orders', {
      ids: preview.eligibleIds, confirmation: 'ELIMINAR_TESTES'
    });
    window.alert(result.deletedCount + ' encomenda(s) de teste eliminadas.' +
      (result.skippedCount ? ' ' + result.skippedCount + ' foram preservadas.' : ''));
    selectedTestOrders.clear();
    await loadOrders();
  } catch (error) {
    window.alert(error.message || 'Não foi possível eliminar as encomendas de teste.');
  } finally {
    updateBulkTestActions();
  }
}
function updateBulkTestActions() {
  const area = document.getElementById('test-bulk-actions');
  const visible = currentView === 'orders' && testFilter === 'test';
  area.hidden = !visible;
  if (!visible) return;
  const ids = filterRows(currentRows).filter(order => order.is_test).map(order => order.id);
  const checkbox = document.getElementById('select-test-page');
  const all = ids.length > 0 && ids.every(id => selectedTestOrders.has(id));
  checkbox.checked = all;
  checkbox.indeterminate = !all && ids.some(id => selectedTestOrders.has(id));
  checkbox.disabled = ids.length === 0;
  document.getElementById('selected-test-count').textContent = selectedTestOrders.size + ' selecionada(s)';
  document.getElementById('bulk-delete-selected').disabled = selectedTestOrders.size === 0;
}
document.getElementById('cleanup-tools').addEventListener('toggle', () => {
  if (currentView === 'orders') renderOrderRows(currentRows);
});
document.querySelectorAll('.tabs button').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach(item => item.classList.remove('active'));
  button.classList.add('active'); currentView = button.dataset.view; statusFilter = ''; updateStatusOptions(); loadView();
}));

async function loadView() {
  const body = document.getElementById('table-body');
  body.innerHTML = '<tr><td colspan="10">A carregar…</td></tr>';
  try {
    if (currentView === 'orders') await loadOrders(); else await loadProjects();
  } catch (error) { body.innerHTML = `<tr><td colspan="10" class="error">${esc(error.message)}</td></tr>`; }
}

async function loadOrders() {
  document.getElementById('summary-grid').classList.remove('projects-summary');
  const result = await adminApi('list-orders');
  const rows = result.data || [];
  selectedTestOrders.clear();
  selectedDraftOrders.clear();
  currentRows = rows;
  updateStatusOptions();
  document.getElementById('view-title').textContent = 'Encomendas diretas';
  const visibleRows = rows.filter(row => (testFilter === 'all' || Boolean(row.is_test) === (testFilter === 'test')) && (!channelFilter || row.sales_channel === channelFilter));
  const paid = visibleRows.filter(row => ['paid','partially_refunded'].includes(row.payment_status));
  const partial = visibleRows.filter(row => row.payment_provider === 'manual' && row.payment_status === 'unpaid' && Number(row.manual_received_amount || 0) > 0);
  const net = [...paid, ...partial].reduce((sum, row) => sum + Number(paymentAmounts(row).netAmount ?? 0), 0);
  document.getElementById('summary-grid').innerHTML = [
    ['Novas', visibleRows.filter(isNewOrder).length], ['Pagas', paid.length], ['Em produção', visibleRows.filter(row => row.order_status === 'production').length], ['Líquido recebido', money(net)]
  ].map(item => `<div class="summary-card"><span>${item[0]}</span><strong>${item[1]}</strong></div>`).join('');
  document.getElementById('cleanup-tools').hidden = false;
  renderOrderRows(rows);
}

function renderOrderRows(allRows) {
  const showCleanup = document.getElementById('cleanup-tools').open;
  const showSelection = showCleanup && (testFilter === 'test' || testFilter === 'real');
  document.getElementById('table-head').innerHTML = '<tr>' +
    (showSelection ? '<th>Seleção</th>' : '') +
    '<th>Referência</th><th>Canal</th><th>Cliente</th><th>Encomenda</th><th>Pagamento</th><th>Bruto</th><th>Taxas</th><th>Líquido</th><th>Entrega</th><th>Data</th>' +
    (showCleanup ? '<th>Ações</th>' : '') + '</tr>';
  const rows = filterRows(allRows);
  document.getElementById('results-count').textContent = `${rows.length} resultados (página atual)`;
  document.getElementById('table-body').innerHTML = rows.map(row => {
    const { payment, grossAmount, feeAmount, netAmount } = paymentAmounts(row);
    const selector = !showSelection ? '' : testFilter === 'test'
      ? `<td class="test-selection-cell"><input type="checkbox" data-select-test="${esc(row.id)}" aria-label="Selecionar encomenda ${esc(row.order_number)}" ${selectedTestOrders.has(row.id) ? 'checked' : ''}></td>`
      : testFilter === 'real'
        ? `<td class="test-selection-cell">${isDeletableDraft(row) ? `<input type="checkbox" data-select-draft="${esc(row.id)}" aria-label="Selecionar rascunho ${esc(row.order_number)}" ${selectedDraftOrders.has(row.id) ? 'checked' : ''}>` : ''}</td>`
        : '';
    return `<tr data-order="${row.id}">${selector}<td><strong>${esc(row.order_number)}</strong>${isNewOrder(row) ? ' <span class="new-tag">Nova</span>' : ''}<br>${esc(payment.provider_payment_id || '—')}</td><td>${esc(({website:'Site',whatsapp:'WhatsApp',instagram:'Instagram',other:'Outro'})[row.sales_channel] || 'Site')}${row.is_test ? ' · Teste' : ''}</td><td>${esc(row.customer_name || '—')}<br>${esc(row.customer_email || '')}</td><td>${badge(row.order_status)}</td><td>${orderPaymentBadge(row)}</td><td>${money(grossAmount, row.currency)}</td><td>${feeAmount == null ? '—' : money(feeAmount,row.currency)}</td><td>${netAmount == null ? '—' : money(netAmount,row.currency)}</td><td>${deliverySummary(row)}</td><td>${date(row.created_at)}</td>${showCleanup ? `<td>${!['paid','processing','partially_refunded','refunded'].includes(row.payment_status) && !row.paid_at && !Number(row.manual_received_amount || 0) ? `<button type="button" class="delete-order-button" data-delete-order="${esc(row.id)}" data-order-number="${esc(row.order_number)}" aria-label="Eliminar encomenda ${esc(row.order_number)}">Eliminar</button>` : '—'}</td>` : ''}</tr>`;
  }).join('');
  document.querySelectorAll('[data-order]').forEach(row => row.addEventListener('click', () => openOrder(row.dataset.order)));
  document.querySelectorAll('[data-delete-order]').forEach(button => button.addEventListener('click', async event => {
    event.stopPropagation();
    const id = button.dataset.deleteOrder;
    const reference = button.dataset.orderNumber;
    if (!window.confirm(`Eliminar definitivamente a encomenda ${reference}? Esta ação não pode ser anulada. Só é possível eliminar encomendas sem pagamentos reais.`)) return;
    button.disabled = true;
    try { await adminApi('delete-order', { id }); await loadOrders(); }
    catch (error) { window.alert(error.message || 'Não foi possível eliminar esta encomenda.'); button.disabled = false; }
  }));
  document.querySelectorAll('[data-select-test]').forEach(checkbox => {
    checkbox.addEventListener('click', event => event.stopPropagation());
    checkbox.addEventListener('change', event => {
      if (event.target.checked) selectedTestOrders.add(checkbox.dataset.selectTest);
      else selectedTestOrders.delete(checkbox.dataset.selectTest);
      updateBulkTestActions();
    });
  });
  document.querySelectorAll('[data-select-draft]').forEach(checkbox => {
    checkbox.addEventListener('click', event => event.stopPropagation());
    checkbox.addEventListener('change', event => {
      if (event.target.checked) selectedDraftOrders.add(checkbox.dataset.selectDraft);
      else selectedDraftOrders.delete(checkbox.dataset.selectDraft);
      updateBulkDraftActions();
    });
  });
  updateBulkTestActions();
  updateBulkDraftActions();
}

async function loadProjects() {
  document.getElementById('cleanup-tools').open = false;
  document.getElementById('cleanup-tools').hidden = true;
  selectedTestOrders.clear();
  selectedDraftOrders.clear();
  document.getElementById('test-bulk-actions').hidden = true;
  document.getElementById('draft-bulk-actions').hidden = true;
  document.getElementById('summary-grid').classList.add('projects-summary');
  const result = await adminApi('list-projects');
  const rows = result.data || [];
  currentRows = rows;
  updateStatusOptions();
  document.getElementById('view-title').textContent = 'Encomendas personalizadas';
  // Mesmos quatro cartões que as encomendas diretas, mas todos com valores em euros.
  // Um orçamento por projeto: a versão mais recente. Não somar versões repetidas.
  const valued = rows.map(project => ({
    project,
    quote: lastProjectQuote(project)
  })).filter(item => item.quote);
  const totals = valued.reduce((sum, {project,quote}) => {
    const total = Number(quote.total_amount || 0);
    const received = Math.min(total, Math.max(0, projectReceivedAmount(project)));
    sum.quoted += total;
    sum.outstanding += total - received;
    if (received > 0 && received < total) sum.partial += received;
    if (total > 0 && received >= total) sum.fullyPaid += received;
    if (project.payment_needs_confirmation && received > 0) sum.legacy += 1;
    return sum;
  }, { quoted:0,partial:0,fullyPaid:0,outstanding:0,legacy:0 });
  const legacyNote = totals.legacy ? `${totals.legacy} valor(es) histórico(s) por confirmar` : '';
  document.getElementById('summary-grid').innerHTML = [
    ['Valor orçamentado', money(totals.quoted), 'Último orçamento de cada projeto'],
    ['Recebido parcialmente', money(totals.partial), 'Sinais e pagamentos parciais'],
    ['Recebido a 100%', money(totals.fullyPaid), legacyNote],
    ['Por receber', money(totals.outstanding), 'Montante ainda em falta']
  ].map(item => `<div class="summary-card"><span>${item[0]}</span><strong>${item[1]}</strong>${item[2] ? `<small class="summary-card-note">${esc(item[2])}</small>` : ''}</div>`).join('');
  document.getElementById('table-head').innerHTML = '<tr><th>Referência</th><th>Cliente</th><th>Encomenda</th><th>Pagamento</th><th>Bruto</th><th>Recebido</th><th>Por receber</th><th>Entrega</th><th>Evento</th><th>Data</th></tr>';
  renderProjectRows(rows);
}

function renderProjectRows(allRows) {
  const rows = filterRows(allRows);
  document.getElementById('results-count').textContent = `${rows.length} resultados (lista carregada)`;
  document.getElementById('table-body').innerHTML = rows.map(row => {
    const quote = lastProjectQuote(row);
    const gross = quote ? Number(quote.total_amount || 0) : 0;
    const received = Math.min(gross, Math.max(0, projectReceivedAmount(row)));
    return `<tr data-project="${row.id}">
      <td><strong>${esc(row.project_number)}</strong>${isNewProject(row) ? ' <span class="new-tag">Novo</span>' : ''}<small class="project-row-subtitle">${esc(row.project_type)}</small></td>
      <td>${esc(row.customer_name)}<br>${esc(row.customer_email||'')}</td>
      <td>${badge(row.fulfillment_status)}</td>
      <td>${projectPaymentBadge(row)}${row.payment_needs_confirmation && received > 0 ? '<small class="project-row-subtitle">Valor anterior por confirmar</small>' : ''}</td>
      <td>${quote ? money(gross) : '—'}</td>
      <td>${quote ? money(received) : '—'}</td>
      <td>${quote ? money(Math.max(0,gross-received)) : '—'}</td>
      <td>${deliverySummary(row)}</td>
      <td>${esc(row.event_date || '—')}</td>
      <td>${date(row.created_at)}</td>
    </tr>`;
  }).join('');
  document.querySelectorAll('[data-project]').forEach(row => row.addEventListener('click', () => openProject(row.dataset.project)));
}

function openDrawer(html) { drawer.classList.remove('is-editing'); if (unifiedEditorController) unifiedEditorController.abort(); drawer.querySelector('.unified-edit-bar')?.remove(); document.getElementById('drawer-content').innerHTML = html; backdrop.hidden = false; drawer.classList.add('open'); drawer.setAttribute('aria-hidden','false'); }
function closeDrawer() { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden','true'); setTimeout(() => { backdrop.hidden = true; }, 250); }
document.getElementById('drawer-close').addEventListener('click', closeDrawer); backdrop.addEventListener('click', closeDrawer);

function personalizationHtml(value) {
  if (!value || typeof value !== 'object') return '<p class="personalization-empty">Sem personalização indicada.</p>';
  const labels = {soap:'Sabonete',colors:'Cores',fragrance:'Fragrância',customText:'Texto personalizado',color:'Cor',scent:'Fragrância',message:'Mensagem',size:'Tamanho',name:'Nome',notes:'Observações'};
  const rows = [];
  function walk(obj, prefix = '') {
    for (const [key, val] of Object.entries(obj)) {
      if (val == null || val === '' || val === '||' || val === '[]') continue;
      const label = (labels[key] || key.replace(/([a-z])([A-Z])/g,'$1 $2')).trim();
      const fullLabel = prefix ? prefix + ' · ' + label : label;
      if (typeof val === 'object' && !Array.isArray(val)) walk(val,fullLabel);
      else {
        const display = Array.isArray(val) ? val.filter(Boolean).join(', ') : String(val).split('|').map(v=>v.trim()).filter(Boolean).join(', ');
        if (display) rows.push('<div class="personalization-field"><span>'+esc(fullLabel)+'</span><strong>'+esc(display)+'</strong></div>');
      }
    }
  }
  walk(value);
  return rows.length ? '<div class="personalization-grid">'+rows.join('')+'</div>' : '<p class="personalization-empty">Sem personalização indicada.</p>';
}

async function markSeen(kind,id) {
  const row = currentRows.find(row => row.id === id);
  if (!row || row.admin_seen_at) return;
  try {
    await adminApi('mark-seen',{kind,id});
    row.admin_seen_at = new Date().toISOString();
    if (currentView === (kind === 'order' ? 'orders' : 'projects')) await loadView();
  } catch (error) { console.warn('Não foi possível marcar como visto:',error); }
}

function unifiedDeliveryTask(record, kind, id) {
  const form = document.getElementById('admin-delivery-form');
  if (!form) return null;
  const method = form.elements.deliveryMethod.value;
  const trackingCode = method === 'ctt' ? form.elements.trackingCode.value.trim() : '';
  const meetingPlace = method === 'hand_delivery' ? form.elements.meetingPlace.value.trim() : '';
  const deliveryNotes = method ? form.elements.deliveryNotes.value.trim() : '';
  let meetingAt = null;
  if (method === 'hand_delivery' && form.elements.meetingAt.value) {
    const parsed = new Date(form.elements.meetingAt.value);
    if (!Number.isFinite(parsed.getTime())) throw new Error('A data da entrega não é válida.');
    meetingAt = parsed.toISOString();
  }
  const oldMeetingAt = record.delivery_method === 'hand_delivery' && record.delivery_meeting_at
    ? new Date(record.delivery_meeting_at).toISOString() : null;
  const changed = method !== (record.delivery_method || '')
    || trackingCode !== (record.delivery_method === 'ctt' ? String(record.delivery_tracking_code || '').trim() : '')
    || meetingPlace !== (record.delivery_method === 'hand_delivery' ? String(record.delivery_meeting_place || '').trim() : '')
    || meetingAt !== oldMeetingAt
    || deliveryNotes !== String(record.delivery_notes || '').trim();
  return changed ? { label: 'Entrega', action: 'set-delivery', body: { kind, id, deliveryMethod: method, trackingCode, meetingPlace, meetingAt, deliveryNotes } } : null;
}

function unifiedPaymentChoice(form, total) {
  const stage = form.elements.paymentStage.value;
  const custom = form.elements.receivedEuros;
  const amount = stage === 'unpaid' ? 0 : stage === 'half' ? Math.round(total / 2)
    : stage === 'paid' ? total : Math.round(Number(custom.value) * 100);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > total
    || (stage === 'custom' && (!custom.value || amount <= 0 || amount >= total))) {
    throw new Error('O valor recebido é inválido. Confirma o estado do pagamento.');
  }
  return {amount, fullyPaid: stage === 'paid'};
}

function unifiedOrderTasks(record, id) {
  const tasks = [];
  const manual = document.getElementById('order-edit-form');
  const total = Number(record.total_amount || 0);
  let editedTotal = total;
  if (manual) {
    if (!manual.reportValidity()) throw new Error('Revê os dados da encomenda antes de guardar.');
    const fd = new FormData(manual);
    editedTotal = Math.round(Number(fd.get('totalEuros')) * 100);
    if (!Number.isSafeInteger(editedTotal) || editedTotal < 0) throw new Error('O total da encomenda não é válido.');
    const customerName = String(fd.get('customerName') || '').trim();
    const customerEmail = String(fd.get('customerEmail') || '').trim();
    const customerPhone = String(fd.get('customerPhone') || '').trim();
    const channel = String(fd.get('channel') || '');
    const description = String(fd.get('description') || '').trim();
    const quantity = Number(fd.get('quantity'));
    const notes = String(fd.get('notes') || '').trim();
    const changed = customerName !== String(record.customer_name || '').trim()
      || customerEmail.toLowerCase() !== String(record.customer_email || '').trim().toLowerCase()
      || customerPhone !== String(record.customer_phone || '').trim()
      || channel !== String(record.sales_channel || '')
      || description !== String(record.order_items?.[0]?.name || '').trim()
      || quantity !== Number(record.order_items?.[0]?.quantity || 1)
      || editedTotal !== total || notes !== String(record.notes || '').trim();
    if (changed) tasks.push({label:'Dados da encomenda',action:'edit-manual-order',body:{
      id, customerName, customerEmail, customerPhone, channel, description, quantity, totalAmount:editedTotal, notes, markPaid:false
    }});
  }
  const delivery = unifiedDeliveryTask(record,'order',id);
  if (delivery) tasks.push(delivery);
  const status = document.querySelector('#order-status-form select[name=status]')?.value || '';
  if (status && status !== record.order_status) tasks.push({label:'Estado',action:'update-order',body:{id,orderStatus:status}});
  const payment = document.getElementById('order-payment-form');
  if (payment) {
    const choice = unifiedPaymentChoice(payment,editedTotal);
    const previous = Number(record.manual_received_amount || 0);
    if (choice.amount < previous && !window.confirm('Estás a reduzir o valor anteriormente recebido. Confirmas que é uma correção?')) return null;
    const changed = choice.amount !== previous || choice.fullyPaid;
    if (changed) {
      if (choice.fullyPaid && !window.confirm('Confirmas que já recebeste o valor total desta encomenda?')) return null;
      tasks.push({label:'Pagamento',action:'set-manual-payment',body:{
        id, receivedAmount:choice.amount, fullyPaid:choice.fullyPaid,
        confirmReduction:choice.amount<previous, paymentMethod:payment.elements.paymentMethod.value
      }});
    }
  }
  return tasks;
}

function unifiedProjectTasks(record, id) {
  const tasks = [];
  const notes = document.getElementById('project-admin-notes')?.value.trim() || '';
  if (notes !== String(record.admin_notes || '').trim()) tasks.push({label:'Notas internas',action:'update-project-notes',body:{id,notes}});
  const delivery = unifiedDeliveryTask(record,'project',id);
  if (delivery) tasks.push(delivery);
  const status = document.querySelector('#project-fulfillment-form select[name=status]')?.value || '';
  if (status && status !== String(record.fulfillment_status || '')) tasks.push({label:'Estado',action:'set-project-fulfillment',body:{id,fulfillmentStatus:status}});
  const quoteForm = document.getElementById('quote-form');
  let hasNewQuote = false;
  if (quoteForm) {
    const rows = [...quoteForm.querySelectorAll('.quote-row')];
    hasNewQuote = rows.length > 1 || rows.some(row => String(row.querySelector('[name=description]').value || '').trim() || String(row.querySelector('[name=unit]').value || '').trim()) || Boolean(quoteForm.elements.quoteNotes.value.trim());
    if (hasNewQuote) {
      if (!quoteForm.reportValidity()) throw new Error('Preenche a descrição, quantidade e preço de cada linha do novo orçamento.');
      const items = rows.map(row => ({
        description:row.querySelector('[name=description]').value.trim(),
        quantity:Number(row.querySelector('[name=quantity]').value),
        unitAmount:Math.round(Number(row.querySelector('[name=unit]').value)*100)
      }));
      if (items.some(item=>!item.description || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || !Number.isSafeInteger(item.unitAmount) || item.unitAmount < 0)) throw new Error('Revê os valores do novo orçamento.');
      tasks.push({label:'Novo orçamento (rascunho)',action:'create-quote',body:{
        projectId:id,items,notes:quoteForm.elements.quoteNotes.value
      }});
    }
  }
  const paymentForm = document.getElementById('project-payment-form');
  if (paymentForm) {
    const quote = lastProjectQuote(record);
    const total = Number(quote?.total_amount || 0);
    const choice = unifiedPaymentChoice(paymentForm,total);
    const previous = projectReceivedAmount(record);
    const changed = choice.amount !== previous || Boolean(record.payment_needs_confirmation);
    if (changed && hasNewQuote) throw new Error('Guarda primeiro o novo orçamento e depois atualiza o pagamento, para os valores não se misturarem.');
    if (changed) {
      if (choice.amount < previous && !window.confirm('Confirmas a redução do valor registado como recebido?')) return null;
      if (choice.fullyPaid && previous !== total && !window.confirm('Confirmas que recebeste o pagamento integral deste orçamento?')) return null;
      tasks.push({label:'Pagamento',action:'set-project-payment',body:{
        id,receivedAmount:choice.amount,confirmReduction:choice.amount<previous
      }});
    }
  }
  return tasks;
}

function setupUnifiedDetailEditor(kind, record, id) {
  const root = document.getElementById('drawer-content');
  const editor = document.getElementById(kind === 'order' ? 'order-edit-form' : 'quote-form');
  if (editor) editor.closest(kind === 'order' ? '.detail-section' : '.project-quote-subsection')?.classList.add('detail-edit-section');
  if (kind === 'project') {
    const notesForm = document.getElementById('project-notes-form');
    if (notesForm) {
      const readOnly = document.createElement('p');
      readOnly.className = 'detail-readonly-notes';
      readOnly.textContent = record.admin_notes || 'Sem notas internas.';
      notesForm.before(readOnly);
    }
  } else if (record.notes) {
    const section = document.createElement('div');
    section.className = 'detail-section detail-static-notes';
    section.innerHTML = '<h3>Notas internas</h3><p>' + esc(record.notes) + '</p>';
    root.querySelector('.detail-section')?.after(section);
  }
  const status = root.querySelector(kind === 'order' ? '#order-status-form select[name=status]' : '#project-fulfillment-form select[name=status]');
  if (status) {
    const current = kind === 'order' ? record.order_status : (record.fulfillment_status || '');
    if (![...status.options].some(option=>option.value===String(current||''))) {
      const option = document.createElement('option');
      option.value = current || '';
      option.textContent = current ? (ORDER_LABELS[current] || current) : 'Por definir';
      status.prepend(option);
    }
    status.value = current || '';
  }
  const bar = document.createElement('div');
  bar.className = 'unified-edit-bar';
  bar.innerHTML = '<p class="unified-edit-feedback" role="status" aria-live="polite"></p>'
    + '<button type="button" class="secondary unified-cancel" hidden>Cancelar</button>'
    + '<button type="button" class="unified-save" hidden>Guardar alterações</button>'
    + '<button type="button" class="unified-start">Editar</button>';
  // Botões no fluxo normal: só aparecem após percorrer todos os detalhes.
  root.append(bar);
  const start=bar.querySelector('.unified-start'),cancel=bar.querySelector('.unified-cancel'),save=bar.querySelector('.unified-save'),feedback=bar.querySelector('.unified-edit-feedback');
  const setEditMode = value => {
    drawer.classList.toggle('is-editing',value);
    start.hidden=value; cancel.hidden=!value; save.hidden=!value;
    if (value) root.scrollTo({top:0,behavior:'smooth'});
  };
  start.addEventListener('click',()=>{feedback.textContent='';setEditMode(true);});
  cancel.addEventListener('click',()=>{drawer.classList.remove('is-editing');(kind==='order'?openOrder(id):openProject(id));});
  save.addEventListener('click',async()=>{
    if(save.disabled)return;
    feedback.textContent='';
    let tasks;
    try{tasks=kind==='order'?unifiedOrderTasks(record,id):unifiedProjectTasks(record,id);}
    catch(error){feedback.textContent=error.message||'Verifica os campos antes de guardar.';return;}
    if(tasks===null)return;
    if(!tasks.length){setEditMode(false);feedback.textContent='Sem alterações para guardar.';return;}
    save.disabled=true;cancel.disabled=true;start.disabled=true;
    let completed=0;
    try{
      for(const task of tasks){feedback.textContent='A guardar: '+task.label+'…';await adminApi(task.action,task.body);completed++;}
      if(kind==='order'){await loadOrders();await openOrder(id);}
      else{await loadProjects();await openProject(id);}
    }catch(error){
      feedback.textContent=(completed?'Foram guardadas '+completed+' de '+tasks.length+' alterações. ':'')
        +(error.message||'Não foi possível guardar todas as alterações.')+(completed?' Atualiza a encomenda e confirma os restantes dados.':'');
      save.disabled=false;cancel.disabled=false;start.disabled=false;
    }
  });
  // Evita que Enter em formulários antigos guarde só uma secção.
  if(unifiedEditorController) unifiedEditorController.abort();
  unifiedEditorController=new AbortController();
  root.addEventListener('submit',event=>{
    if(event.target.matches('#order-status-form,#order-payment-form,#order-edit-form,#admin-delivery-form,#project-fulfillment-form,#project-payment-form,#project-notes-form,#quote-form')){
      event.preventDefault();event.stopImmediatePropagation();
      if(drawer.classList.contains('is-editing'))save.click();
    }
  },{capture:true,signal:unifiedEditorController.signal});
}

async function openOrder(id) {
  openDrawer('<p>A carregar…</p>');
  try {
    const order = await adminApi('get-order', { id });
    const { payment, grossAmount, feeAmount, netAmount } = paymentAmounts(order);
    const receivedAmount = orderReceivedAmount(order);
    const totalAmount = Number(order.total_amount || 0);
    const paymentStage = order.payment_status === 'paid' ? 'paid' : receivedAmount === 0 ? 'unpaid'
      : Math.abs(receivedAmount * 2 - totalAmount) <= 1 ? 'half' : 'custom';
    const paymentEditor = order.payment_provider === 'manual' && order.payment_status === 'unpaid'
      ? `<form id="order-payment-form" class="order-payment-form">
          <label>Estado do pagamento
            <select name="paymentStage" id="order-payment-stage">
              ${[['unpaid','Por pagar'],['half','50% pago'],['custom','Pagamento parcial (outro valor)'],['paid','Pago (100%)']].map(([value,label]) => `<option value="${value}" ${paymentStage===value?'selected':''}>${label}</option>`).join('')}
            </select>
          </label>
          <label id="order-payment-custom-field" hidden>Montante recebido acumulado (€)
            <input name="receivedEuros" type="number" min="0.01" max="${(totalAmount/100).toFixed(2)}" step="0.01" value="${(receivedAmount/100).toFixed(2)}">
          </label>
          <label>Método de pagamento
            <select name="paymentMethod"><option value="mbway">MB WAY</option><option value="transferencia">Transferência bancária</option><option value="numerario">Numerário</option><option value="outro">Outro</option></select>
          </label>
          <div id="order-payment-preview" class="order-payment-preview" aria-live="polite"></div>
          <p class="order-payment-hint">O montante corresponde ao total recebido até agora, não apenas ao último pagamento.</p>
          <p id="order-payment-error" class="error" role="alert"></p>
          <button type="submit">Guardar pagamento</button>
        </form>` : '';
    openDrawer(`<p class="eyebrow">Encomenda</p><h2>${esc(order.order_number)}</h2>
      <div class="detail-section"><div class="detail-grid"><p><strong>Cliente</strong>${esc(order.customer_name || '—')}</p><p><strong>Email</strong>${esc(order.customer_email || '—')}</p><p><strong>Telefone</strong>${esc(order.customer_phone || '—')}</p><p><strong>Total</strong>${money(order.total_amount,order.currency)}</p></div></div>
      <div class="detail-section"><h3>Estado da encomenda</h3><p class="order-current-status">${badge(order.order_status)}</p><form class="status-form" id="order-status-form"><select name="status">${['confirmed','review','awaiting_details','production','ready_to_ship','shipped','completed','cancelled'].map(status => `<option value="${status}" ${status===order.order_status?'selected':''}>${ORDER_LABELS[status]}</option>`).join('')}</select><button>Guardar estado</button></form></div>
      <div class="detail-section"><h3>Estado do pagamento</h3>
        <p class="order-current-status">${orderPaymentBadge(order)}</p>
        <div class="detail-grid order-payment-summary">
          <p><strong>Total do pedido</strong>${money(totalAmount,order.currency)}</p>
          <p><strong>Recebido</strong>${money(receivedAmount,order.currency)}</p>
          <p><strong>Por receber</strong>${money(Math.max(0,totalAmount-receivedAmount),order.currency)}</p>
        </div>
        ${paymentEditor}
      </div>
      ${deliveryFormHtml(order)}
      <div class="detail-section"><h3>Detalhes financeiros — ${order.payment_provider === 'manual' ? 'manual' : 'Stripe'}</h3><div class="detail-grid">${order.payment_provider === 'manual' ? '' : `<p><strong>Payment Intent</strong>${esc(payment.provider_payment_id || '—')}</p><p><strong>Charge</strong>${esc(payment.provider_charge_id || '—')}</p>`}<p><strong>Bruto</strong>${money(grossAmount,order.currency)}</p><p><strong>Taxas</strong>${feeAmount==null?'—':money(feeAmount,order.currency)}</p><p><strong>Líquido recebido</strong>${netAmount==null?'—':money(netAmount,order.currency)}</p><p><strong>Reembolsos</strong>${money(payment.refunded_amount,order.currency)}</p></div></div>
      ${order.payment_provider === 'manual' ? `<div class="detail-section"><h3>Dados da encomenda</h3>
        <form id="order-edit-form" class="order-edit-form">
          <label>Nome do cliente<input name="customerName" value="${esc(order.customer_name || '')}" required maxlength="160"></label>
          <label>Email<input type="email" name="customerEmail" value="${esc(order.customer_email || '')}"></label>
          <label>Telefone<input name="customerPhone" value="${esc(order.customer_phone || '')}"></label>
          <label>Canal<select name="channel">${[['instagram','Instagram'],['whatsapp','WhatsApp'],['other','Outro']].map(([v,l])=>`<option value="${v}" ${order.sales_channel===v?'selected':''}>${l}</option>`).join('')}</select></label>
          <label>Produto / descrição<input name="description" value="${esc(order.order_items?.[0]?.name || '')}" required maxlength="240"></label>
          <label>Quantidade<input type="number" name="quantity" min="1" step="1" max="10000" value="${Number(order.order_items?.[0]?.quantity || 1)}" required></label>
          <label>Total (€)<input type="number" name="totalEuros" min="0" step="0.01" value="${(Number(order.total_amount)/100).toFixed(2)}" ${order.payment_status==='paid'?'readonly':''} required></label>
          <label>Notas<textarea name="notes" rows="3">${esc(order.notes || '')}</textarea></label>
          <p id="order-edit-error" class="error" role="alert"></p>
          <button type="submit">Guardar alterações</button>
        </form></div>` : ''}
      <div class="detail-section"><h3>Artigos e personalização</h3>${order.order_items.map(item => `<div class="line-item"><strong>${esc(item.quantity)} × ${esc(item.name)}</strong><p>${money(item.line_amount,order.currency)}</p>${personalizationHtml(item.personalization)}</div>`).join('')}</div>
      <div class="detail-section"><h3>Ficheiros privados</h3>${filesHtml(order.attachments)}</div>`);
    document.getElementById('order-status-form').addEventListener('submit', async event => { event.preventDefault(); await adminApi('update-order',{id,orderStatus:new FormData(event.currentTarget).get('status')}); await openOrder(id); await loadOrders(); });
    bindDeliveryForm(order,'order',id);
    const paymentForm = document.getElementById('order-payment-form');
    if (paymentForm) {
      const stageSelect = document.getElementById('order-payment-stage');
      const customField = document.getElementById('order-payment-custom-field');
      const receivedInput = paymentForm.elements.receivedEuros;
      const preview = document.getElementById('order-payment-preview');
      const paymentError = document.getElementById('order-payment-error');
      const calculatePayment = () => {
        const stage = stageSelect.value;
        if (stage === 'unpaid') return 0;
        if (stage === 'half') return Math.round(totalAmount / 2);
        if (stage === 'paid') return totalAmount;
        const euros = Number(receivedInput.value);
        return Number.isFinite(euros) ? Math.round(euros * 100) : NaN;
      };
      const updatePaymentPreview = () => {
        customField.hidden = stageSelect.value !== 'custom';
        const amount = calculatePayment();
        const valid = Number.isSafeInteger(amount) && amount >= 0 && amount <= totalAmount &&
          (stageSelect.value !== 'custom' || (amount > 0 && amount < totalAmount));
        preview.textContent = valid
          ? 'Recebido: ' + money(amount,order.currency) + ' · Em falta: ' + money(totalAmount-amount,order.currency)
          : 'Indica um valor recebido entre 0 € e o total da encomenda.';
        preview.dataset.invalid = String(!valid);
        return valid;
      };
      stageSelect.addEventListener('change', updatePaymentPreview);
      receivedInput.addEventListener('input', updatePaymentPreview);
      updatePaymentPreview();
      paymentForm.addEventListener('submit', async event => {
        event.preventDefault();
        paymentError.textContent = '';
        if (!updatePaymentPreview()) { paymentError.textContent = 'O valor recebido não é válido.'; return; }
        const amount = calculatePayment();
        let confirmReduction = false;
        if (amount < receivedAmount) {
          if (!window.confirm('Estás a reduzir o valor registado como recebido. Confirma que se trata de uma correção.')) return;
          confirmReduction = true;
        }
        const fullyPaid = stageSelect.value === 'paid';
        if (fullyPaid && !window.confirm('Confirmas que recebeste o valor total desta encomenda?')) return;
        const button = paymentForm.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
          await adminApi('set-manual-payment', {
            id, receivedAmount: amount, fullyPaid, confirmReduction,
            paymentMethod: paymentForm.elements.paymentMethod.value
          });
          await loadOrders();
          await openOrder(id);
        } catch (error) {
          paymentError.textContent = error.message || 'Não foi possível guardar o pagamento.';
          button.disabled = false;
        }
      });
    }
    if (order.payment_provider === 'manual') {
      const form = document.getElementById('order-edit-form');
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        const error = document.getElementById('order-edit-error');
        const values = new FormData(form);
        error.textContent = '';
        button.disabled = true;
        try {
          await adminApi('edit-manual-order', {
            id, customerName: values.get('customerName'),
            customerEmail: values.get('customerEmail'), customerPhone: values.get('customerPhone'),
            channel: values.get('channel'), description: values.get('description'),
            quantity: Number(values.get('quantity')),
            totalAmount: Math.round(Number(values.get('totalEuros')) * 100),
            notes: values.get('notes'), markPaid: false
          });
          await loadOrders();
          await openOrder(id);
        } catch (cause) {
          error.textContent = cause.message || 'Não foi possível guardar as alterações.';
          button.disabled = false;
        }
      });
    }
    setupUnifiedDetailEditor('order',order,id);
    bindFiles();
    await markSeen('order',id);

  } catch (error) { openDrawer(`<p class="error">${esc(error.message)}</p>`); }
}

async function openProject(id) {
  openDrawer('<p>A carregar…</p>');
  try {
    const project = await adminApi('get-project', { id });
    const quote = lastProjectQuote(project);
    const total = quote ? Number(quote.total_amount || 0) : 0;
    const received = Math.min(total, Math.max(0, projectReceivedAmount(project)));
    const stage = projectPaymentStage(project);
    const paymentSelection = stage === 'half_paid' ? 'half'
      : stage === 'partially_paid' ? 'custom' : stage === 'paid' ? 'paid' : 'unpaid';
    const linkedCheckout = (project.quotes || []).some(item => Boolean(item.order_id)) || Boolean(project.orders?.length);
    const projectPaymentEditor = quote && total > 0 && !linkedCheckout
      ? `<form id="project-payment-form" class="order-payment-form">
          <label>Estado do pagamento
            <select name="paymentStage" id="project-payment-stage">
              ${[['unpaid','Por pagar'],['half','50% pago'],['custom','Pagamento parcial (outro valor)'],['paid','Pago (100%)']].map(([value,label]) =>
                `<option value="${value}" ${paymentSelection === value ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </label>
          <label id="project-payment-custom-field" hidden>Montante recebido acumulado (€)
            <input name="receivedEuros" type="number" min="0.01" step="0.01" max="${(total/100).toFixed(2)}" value="${(received/100).toFixed(2)}">
          </label>
          <div id="project-payment-preview" class="order-payment-preview" aria-live="polite"></div>
          <p class="order-payment-hint">Regista o total recebido até hoje, incluindo qualquer sinal de 50%.</p>
          <p id="project-payment-error" class="error" role="alert"></p>
          <button type="submit">Guardar pagamento</button>
        </form>`
      : `<p class="order-payment-hint">${linkedCheckout ? 'Pagamento associado a uma encomenda de checkout. Consulta essa encomenda para o atualizar.' : 'Guarda primeiro um orçamento com valor para registares o pagamento.'}</p>`;
    openDrawer(`<p class="eyebrow">Projeto personalizado</p><h2>${esc(project.project_number)}</h2>
      <div class="detail-section"><div class="detail-grid"><p><strong>Cliente</strong>${esc(project.customer_name)}</p><p><strong>Email</strong>${esc(project.customer_email)}</p><p><strong>Telefone</strong>${esc(project.customer_phone||'—')}</p><p><strong>Data do evento</strong>${esc(project.event_date||'—')}</p><p><strong>Ocasião</strong>${esc(project.occasion)}</p><p><strong>Tipo</strong>${esc(project.project_type)}</p><p><strong>Quantidade</strong>${esc(project.approximate_quantity||'—')}</p><p><strong>Orçamento indicado</strong>${esc(project.approximate_budget||'—')}</p></div><h3 style="margin-top:1rem">Ideia</h3><p>${esc(project.idea)}</p></div>
      <div class="detail-section">
        <h3>Estado da encomenda</h3>
        <p class="order-current-status">${badge(project.fulfillment_status)}</p>
        <form class="status-form" id="project-fulfillment-form">
          <select name="status">${PROJECT_FULFILLMENT_STATES.map(status =>
            `<option value="${status}" ${status===project.fulfillment_status ? 'selected' : ''}>${ORDER_LABELS[status]}</option>`).join('')}</select>
          <button>Guardar estado</button>
        </form>
      </div>
      <div class="detail-section">
        <h3>Estado do pagamento</h3>
        <p class="order-current-status">${projectPaymentBadge(project)}</p>
        <div class="detail-grid order-payment-summary">
          <p><strong>Valor orçamentado</strong>${quote ? money(total,quote.currency) : '—'}</p>
          <p><strong>Valor recebido</strong>${quote ? money(received,quote.currency) : '—'}</p>
          <p><strong>Por receber</strong>${quote ? money(Math.max(0,total-received),quote.currency) : '—'}</p>
        </div>
        ${project.payment_needs_confirmation && received > 0
          ? '<p class="legacy-payment-note">O valor recebido foi importado do antigo estado “Pago” e do orçamento. Confirma-o no formulário para retirar este aviso.</p>' : ''}
        ${projectPaymentEditor}
      </div>
      ${deliveryFormHtml(project)}
      <div class="detail-section"><h3>Ficheiros privados</h3>${filesHtml(project.attachments)}</div>
      <div class="detail-section" id="project-quote-section"><h3>Orçamento e notas</h3>
      <div class="project-quote-subsection"><h4>Notas internas do projeto</h4><p class="internal-notes-help">Regista aqui as confirmações, preferências e detalhes de entrega combinados com o cliente. Estas notas não são enviadas ao cliente.</p><form id="project-notes-form" class="project-notes-form"><label for="project-admin-notes">Notas do projeto</label><textarea id="project-admin-notes" name="notes" rows="6" maxlength="4000" placeholder="Ex.: Produtos, cores, fragrância, entrega e detalhes acordados">${esc(project.admin_notes || '')}</textarea><div class="project-notes-actions"><button type="submit">Guardar notas</button><span id="project-notes-feedback" role="status" aria-live="polite"></span></div></form></div>
      <div class="project-quote-subsection"><h4>Novo orçamento</h4><p class="quote-note">Ao guardares as alterações, este orçamento fica em rascunho. Não é enviado automaticamente.</p><form id="quote-form"><div id="quote-lines"><div class="quote-row"><input name="description" placeholder="Descrição" required/><input name="quantity" type="number" min="1" value="1" required/><input name="unit" type="number" min="0" step="0.01" placeholder="€/un" required/></div></div><label class="quote-client-notes-label" for="quote-client-notes">Observações para a cliente (opcional)</label><textarea id="quote-client-notes" name="quoteNotes" rows="3" maxlength="2000" placeholder="Estas observações só ficam visíveis quando enviares o orçamento."></textarea><div class="quote-actions"><button type="button" class="secondary" id="add-quote-line">+ Linha</button><button type="submit">Guardar rascunho</button></div></form></div>
      <div class="project-quote-subsection"><h4>Orçamentos guardados</h4>${(project.quotes||[]).map(q=>`<div class="quote-history-entry"><p><strong>v${q.version}</strong> · ${badge(q.status)} · ${money(q.total_amount,q.currency)} · válido até ${esc(q.valid_until||'—')}</p>${q.status==='draft'?`<button type="button" class="secondary" data-send-quote="${esc(q.id)}">Enviar orçamento</button><button type="button" class="delete-order-button" data-delete-draft-quote="${esc(q.id)}" data-quote-version="${esc(q.version)}">Eliminar</button>`:''}</div>`).join('')||'<p>Nenhum orçamento guardado.</p>'}</div>
      </div>`);
    bindDeliveryForm(project,'project',id);
    async function saveProjectNotes() {
      const notes = document.getElementById('project-admin-notes').value.trim();
      if (notes !== (project.admin_notes || '').trim()) {
        await adminApi('update-project-notes', { id, notes });
        project.admin_notes = notes;
      }
      document.getElementById('project-notes-feedback').textContent = 'Notas guardadas.';
    }
    document.getElementById('project-notes-form').addEventListener('submit', async event => {
      event.preventDefault();
      const button = event.currentTarget.querySelector('button[type="submit"]');
      const feedback = document.getElementById('project-notes-feedback');
      feedback.textContent = '';
      button.disabled = true;
      try { await saveProjectNotes(); }
      catch (error) { feedback.textContent = error.message || 'Não foi possível guardar as notas.'; }
      finally { button.disabled = false; }
    });
    document.getElementById('project-fulfillment-form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button[type="submit"],button');
      button.disabled = true;
      try {
        await adminApi('set-project-fulfillment', { id, fulfillmentStatus: new FormData(form).get('status') });
        await loadProjects();
        await openProject(id);
      } catch (error) { window.alert(error.message || 'Não foi possível guardar o estado da encomenda.'); button.disabled = false; }
    });
    const paymentForm = document.getElementById('project-payment-form');
    if (paymentForm) {
      const select = document.getElementById('project-payment-stage');
      const customField = document.getElementById('project-payment-custom-field');
      const input = paymentForm.elements.receivedEuros;
      const preview = document.getElementById('project-payment-preview');
      const errorElement = document.getElementById('project-payment-error');
      const proposed = () => {
        if (select.value === 'unpaid') return 0;
        if (select.value === 'half') return Math.round(total / 2);
        if (select.value === 'paid') return total;
        const euros = Number(input.value);
        return input.value && Number.isFinite(euros) ? Math.round(euros * 100) : NaN;
      };
      const update = () => {
        customField.hidden = select.value !== 'custom';
        const amount = proposed();
        const valid = Number.isSafeInteger(amount) && amount >= 0 && amount <= total &&
          (select.value !== 'custom' || (amount > 0 && amount < total));
        preview.dataset.invalid = String(!valid);
        preview.textContent = valid
          ? 'Recebido: ' + money(amount) + ' · Em falta: ' + money(total - amount)
          : 'Indica um montante entre 0 € e o valor orçamentado.';
        return valid;
      };
      select.addEventListener('change', update);
      input.addEventListener('input', update);
      update();
      paymentForm.addEventListener('submit', async event => {
        event.preventDefault();
        errorElement.textContent = '';
        if (!update()) { errorElement.textContent = 'Montante recebido inválido.'; return; }
        const amount = proposed();
        let confirmReduction = false;
        if (amount < received) {
          if (!window.confirm('Confirmas que queres reduzir o valor já registado como recebido?')) return;
          confirmReduction = true;
        }
        if (select.value === 'paid' && received !== total &&
          !window.confirm('Confirmas que recebeste a totalidade deste orçamento?')) return;
        const button = paymentForm.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
          await adminApi('set-project-payment', { id, receivedAmount: amount, confirmReduction });
          await loadProjects();
          await openProject(id);
        } catch (cause) { errorElement.textContent = cause.message || 'Não foi possível guardar o pagamento.'; button.disabled = false; }
      });
    }
    document.getElementById('add-quote-line').addEventListener('click', () => document.getElementById('quote-lines').insertAdjacentHTML('beforeend','<div class="quote-row"><input name="description" placeholder="Descrição" required/><input name="quantity" type="number" min="1" value="1" required/><input name="unit" type="number" min="0" step="0.01" placeholder="€/un" required/></div>'));
    document.getElementById('quote-form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      const rows = [...form.querySelectorAll('.quote-row')];
      const items = rows.map(row => ({
        description: row.querySelector('[name=description]').value,
        quantity: Number(row.querySelector('[name=quantity]').value),
        unitAmount: Math.round(Number(row.querySelector('[name=unit]').value) * 100)
      }));
      try {
        await saveProjectNotes();
        await adminApi('create-quote', { projectId: id, items, notes: form.elements.quoteNotes.value });
        alert('Orçamento guardado como rascunho. Não foi enviado ao cliente.');
        await openProject(id);
        await loadProjects();
      } catch (error) {
        alert(error.message || 'Não foi possível guardar o orçamento.');
        submit.disabled = false;
      }
    });
    document.querySelectorAll('[data-delete-draft-quote]').forEach(button => button.addEventListener('click', async () => {
      if (!window.confirm('Eliminar definitivamente o rascunho v' + button.dataset.quoteVersion + '? Esta ação não pode ser anulada.')) return;
      button.disabled = true;
      try {
        await adminApi('delete-draft-quote', { id: button.dataset.deleteDraftQuote });
        await openProject(id);
        await loadProjects();
      } catch (error) {
        window.alert(error.message || 'Não foi possível eliminar o rascunho.');
        button.disabled = false;
      }
    }));
    document.querySelectorAll('[data-send-quote]').forEach(button => button.addEventListener('click', async () => {
      const recipient = project.customer_email;
      const message = recipient
        ? 'Enviar este orçamento para ' + recipient + '?'
        : 'Gerar uma ligação para partilhar este orçamento com o cliente? Não existe email associado ao pedido.';
      if (!window.confirm(message)) return;
      button.disabled = true;
      try {
        const result = await adminApi('send-quote', { id: button.dataset.sendQuote });
        let copied = false;
        if (result.quoteUrl && navigator.clipboard) {
          copied = await navigator.clipboard.writeText(result.quoteUrl).then(() => true).catch(() => false);
        }
        if (result.emailQueued) {
          alert('Orçamento enviado para processamento por email.' + (copied ? ' A ligação também foi copiada.' : ''));
        } else if (result.emailError) {
          alert('O orçamento ficou disponível, mas não foi possível enviar o email: ' + result.emailError);
        } else {
          alert('Orçamento marcado como enviado.' + (copied ? ' A ligação para partilhar foi copiada.' : ''));
        }
        if (result.quoteUrl && !copied) window.prompt('Copia esta ligação para partilhar com o cliente:', result.quoteUrl);
        await openProject(id);
        await loadProjects();
      } catch (error) {
        alert(error.message || 'Não foi possível enviar o orçamento.');
        button.disabled = false;
      }
    }));
    setupUnifiedDetailEditor('project',project,id);
    bindFiles();
    await markSeen('project',id);
  } catch (error) { openDrawer(`<p class="error">${esc(error.message)}</p>`); }
}

let privatePreviewRequest = 0;

function filesHtml(files) {
  if (!files?.length) return '<p>Nenhum ficheiro.</p>';
  return `<div class="private-file-gallery">${files.map(file => {
    const name = String(file.original_name || 'Ficheiro');
    const mime = String(file.mime_type || file.content_type || '').toLowerCase();
    const isImage = /^image\/(jpeg|png|gif|webp|avif|bmp)$/.test(mime) || /\.(jpe?g|png|gif|webp|avif|bmp)$/i.test(name);
    const verified = file.status === 'verified';
    return `<button type="button" class="private-file-card" data-file="${esc(file.id)}" data-image="${isImage ? 'true' : 'false'}" data-filename="${esc(name)}" aria-label="${esc((isImage ? 'Ver imagem: ' : 'Abrir ficheiro: ') + name)}" ${verified ? '' : 'disabled'}>
      <span class="private-file-preview" aria-hidden="true">${isImage && verified ? 'A carregar imagem…' : 'Ficheiro'}</span>
      <span class="private-file-name">${esc(name)}</span>
      ${verified ? '' : `<span class="private-file-status">${esc(file.status || 'Pendente')}</span>`}
    </button>`;
  }).join('')}</div>`;
}

async function signedPreviewUrl(button) {
  const expiresAt = Number(button.dataset.previewExpires || 0);
  if (button.dataset.previewUrl && expiresAt - Date.now() > 15000) return button.dataset.previewUrl;
  const response = await adminApi('signed-file', { id: button.dataset.file });
  if (!response.url || !String(response.url).startsWith('https://')) throw new Error('Não foi possível abrir a imagem.');
  if (button.isConnected) {
    button.dataset.previewUrl = response.url;
    button.dataset.previewExpires = String(Date.now() + Math.min(Number(response.expiresIn) || 300, 300) * 1000);
  }
  return response.url;
}

function getPrivateImageViewer() {
  let viewer = document.getElementById('private-image-viewer');
  if (viewer) return viewer;
  viewer = document.createElement('dialog');
  viewer.id = 'private-image-viewer';
  viewer.className = 'private-image-viewer';
  viewer.setAttribute('aria-label', 'Pré-visualização de imagem privada');
  viewer.innerHTML = `<div class="private-image-panel">
    <div class="private-image-header"><strong class="private-image-title"></strong><button type="button" class="private-image-close" aria-label="Fechar pré-visualização">×</button></div>
    <p class="private-image-feedback" role="status"></p>
    <img class="private-image-full" alt="" hidden/>
  </div>`;
  document.body.appendChild(viewer);
  viewer.querySelector('.private-image-close').addEventListener('click', () => viewer.close());
  viewer.addEventListener('click', event => { if (event.target === viewer) viewer.close(); });
  viewer.addEventListener('close', () => {
    privatePreviewRequest++;
    viewer.querySelector('.private-image-full').removeAttribute('src');
  });
  return viewer;
}

async function openPrivateImage(button) {
  const viewer = getPrivateImageViewer();
  const request = ++privatePreviewRequest;
  const image = viewer.querySelector('.private-image-full');
  const feedback = viewer.querySelector('.private-image-feedback');
  viewer.querySelector('.private-image-title').textContent = button.dataset.filename || 'Imagem';
  image.hidden = true;
  image.removeAttribute('src');
  feedback.textContent = 'A carregar imagem…';
  if (!viewer.open) viewer.showModal();
  try {
    const url = await signedPreviewUrl(button);
    if (!viewer.open || request !== privatePreviewRequest) return;
    image.onload = () => {
      if (request === privatePreviewRequest) feedback.textContent = '';
    };
    image.onerror = () => {
      if (request === privatePreviewRequest) {
        image.hidden = true;
        feedback.textContent = 'Não foi possível apresentar a imagem. Tenta novamente.';
      }
    };
    image.src = url;
    image.hidden = false;
  } catch (error) {
    if (request === privatePreviewRequest) feedback.textContent = error.message || 'Não foi possível carregar a imagem.';
  }
}

function bindFiles() {
  document.querySelectorAll('#drawer-content .private-file-card').forEach(button => {
    if (button.dataset.image === 'true' && !button.disabled) {
      const preview = button.querySelector('.private-file-preview');
      signedPreviewUrl(button).then(url => {
        if (!button.isConnected) return;
        const image = document.createElement('img');
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.onerror = () => {
          if (button.isConnected) preview.textContent = 'Pré-visualização indisponível';
        };
        preview.replaceChildren(image);
        image.src = url;
      }).catch(() => {
        if (button.isConnected) preview.textContent = 'Pré-visualização indisponível';
      });
    }
    button.addEventListener('click', async () => {
      if (button.dataset.image === 'true') return openPrivateImage(button);
      try {
        const result = await adminApi('signed-file', { id: button.dataset.file });
        window.open(result.url, '_blank', 'noopener');
      } catch (error) {
        window.alert(error.message || 'Não foi possível abrir o ficheiro.');
      }
    });
  });
}

const { data: { session } } = await supabase.auth.getSession();
if (session) { try { await ensureMfa(); } catch (error) { document.getElementById('login-error').textContent = error.message; } }
