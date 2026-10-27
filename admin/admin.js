import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const config = window.LOVE_COMMERCE_CONFIG || {};
const loginCard = document.getElementById('login-card');
const mfaCard = document.getElementById('mfa-card');
const authShell = document.getElementById('auth-shell');
const app = document.getElementById('admin-app');
const drawer = document.getElementById('detail-drawer');
const backdrop = document.getElementById('drawer-backdrop');
let currentView = 'orders';
let searchTerm = '';
let statusFilter = '';
let channelFilter = '';
let testFilter = 'real';
const ORDER_LABELS = {draft:'Rascunho',awaiting_payment:'A aguardar pagamento',confirmed:'Confirmada',review:'Em análise',awaiting_details:'A aguardar detalhes',production:'Em produção',ready_to_ship:'Pronta para enviar',shipped:'Enviada',completed:'Concluída',cancelled:'Cancelada'};
const PROJECT_LABELS = {draft:'Rascunho',submitted:'Recebido',in_review:'Em análise',awaiting_details:'A aguardar detalhes',quoted:'Orçamentado',approved:'Aprovado',payment_pending:'A aguardar pagamento',paid:'Pago',production:'Em produção',completed:'Concluído',declined:'Recusado',archived:'Arquivado'};
function updateStatusOptions() {
  const labels = currentView === 'orders' ? ORDER_LABELS : PROJECT_LABELS;
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
  return rows.filter(row => (currentView !== 'orders' || ((testFilter === 'all' || Boolean(row.is_test) === (testFilter === 'test')) && (!channelFilter || row.sales_channel === channelFilter))) && (!statusFilter || (currentView === 'orders' ? row.order_status : row.status) === statusFilter) && (!q || [row.order_number,row.project_number,row.customer_name,row.customer_email].some(value => String(value || '').toLocaleLowerCase('pt-PT').includes(q))));
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
function date(value) { return value ? new Intl.DateTimeFormat('pt-PT', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—'; }
function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
function badge(value) { const labels = {...ORDER_LABELS,...PROJECT_LABELS}; return `<span class="badge ${esc(value)}">${esc(labels[value] || String(value || '').replaceAll('_', ' '))}</span>`; }

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
document.querySelectorAll('.tabs button').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach(item => item.classList.remove('active'));
  button.classList.add('active'); currentView = button.dataset.view; statusFilter = ''; updateStatusOptions(); loadView();
}));

async function loadView() {
  const body = document.getElementById('table-body');
  body.innerHTML = '<tr><td colspan="8">A carregar…</td></tr>';
  try {
    if (currentView === 'orders') await loadOrders(); else await loadProjects();
  } catch (error) { body.innerHTML = `<tr><td colspan="8" class="error">${esc(error.message)}</td></tr>`; }
}

async function loadOrders() {
  const result = await adminApi('list-orders');
  const rows = result.data || [];
  currentRows = rows;
  updateStatusOptions();
  document.getElementById('view-title').textContent = 'Encomendas';
  const visibleRows = rows.filter(row => (testFilter === 'all' || Boolean(row.is_test) === (testFilter === 'test')) && (!channelFilter || row.sales_channel === channelFilter));
  const paid = visibleRows.filter(row => ['paid','partially_refunded'].includes(row.payment_status));
  const net = paid.reduce((sum, row) => sum + Number(row.payments?.[0]?.net_amount || 0), 0);
  document.getElementById('summary-grid').innerHTML = [
    ['Total visível', visibleRows.length], ['Pagas', paid.length], ['Em produção', visibleRows.filter(row => row.order_status === 'production').length], ['Líquido recebido', money(net)]
  ].map(item => `<div class="summary-card"><span>${item[0]}</span><strong>${item[1]}</strong></div>`).join('');
  document.getElementById('table-head').innerHTML = '<tr><th>Referência</th><th>Canal</th><th>Cliente</th><th>Encomenda</th><th>Pagamento</th><th>Bruto</th><th>Taxas</th><th>Líquido</th><th>Data</th></tr>';
  renderOrderRows(rows);
}

function renderOrderRows(allRows) {
  const rows = filterRows(allRows);
  document.getElementById('results-count').textContent = `${rows.length} resultados (página atual)`;
  document.getElementById('table-body').innerHTML = rows.map(row => {
    const payment = row.payments?.[0] || {};
    return `<tr data-order="${row.id}"><td><strong>${esc(row.order_number)}</strong><br>${esc(payment.provider_payment_id || '—')}</td><td>${esc(({website:'Site',whatsapp:'WhatsApp',instagram:'Instagram',other:'Outro'})[row.sales_channel] || 'Site')}${row.is_test ? ' · Teste' : ''}</td><td>${esc(row.customer_name || '—')}<br>${esc(row.customer_email || '')}</td><td>${badge(row.order_status)}</td><td>${badge(row.payment_status)}</td><td>${money(payment.gross_amount || row.total_amount, row.currency)}</td><td>${payment.processing_fee_amount == null ? '—' : money(payment.processing_fee_amount,row.currency)}</td><td>${payment.net_amount == null ? '—' : money(payment.net_amount,row.currency)}</td><td>${date(row.created_at)}</td></tr>`;
  }).join('');
  document.querySelectorAll('[data-order]').forEach(row => row.addEventListener('click', () => openOrder(row.dataset.order)));
}

async function loadProjects() {
  const result = await adminApi('list-projects');
  const rows = result.data || [];
  currentRows = rows;
  updateStatusOptions();
  document.getElementById('view-title').textContent = 'Projetos personalizados';
  document.getElementById('summary-grid').innerHTML = [
    ['Total recente', rows.length], ['Por analisar', rows.filter(row => row.status === 'submitted').length], ['Orçamentados', rows.filter(row => row.status === 'quoted').length], ['Em produção', rows.filter(row => row.status === 'production').length]
  ].map(item => `<div class="summary-card"><span>${item[0]}</span><strong>${item[1]}</strong></div>`).join('');
  document.getElementById('table-head').innerHTML = '<tr><th>Referência</th><th>Cliente</th><th>Ocasião</th><th>Tipo</th><th>Estado</th><th>Evento</th><th>Data do pedido</th></tr>';
  renderProjectRows(rows);
}

function renderProjectRows(allRows) {
  const rows = filterRows(allRows);
  document.getElementById('results-count').textContent = `${rows.length} resultados (lista carregada)`;
  document.getElementById('table-body').innerHTML = rows.map(row => `<tr data-project="${row.id}"><td><strong>${esc(row.project_number)}</strong></td><td>${esc(row.customer_name)}<br>${esc(row.customer_email)}</td><td>${esc(row.occasion)}</td><td>${esc(row.project_type)}</td><td>${badge(row.status)}</td><td>${esc(row.event_date || '—')}</td><td>${date(row.created_at)}</td></tr>`).join('');
  document.querySelectorAll('[data-project]').forEach(row => row.addEventListener('click', () => openProject(row.dataset.project)));
}

function openDrawer(html) { document.getElementById('drawer-content').innerHTML = html; backdrop.hidden = false; drawer.classList.add('open'); drawer.setAttribute('aria-hidden','false'); }
function closeDrawer() { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden','true'); setTimeout(() => { backdrop.hidden = true; }, 250); }
document.getElementById('drawer-close').addEventListener('click', closeDrawer); backdrop.addEventListener('click', closeDrawer);

async function openOrder(id) {
  openDrawer('<p>A carregar…</p>');
  try {
    const order = await adminApi('get-order', { id });
    const payment = order.payments?.[0] || {};
    openDrawer(`<p class="eyebrow">Encomenda</p><h2>${esc(order.order_number)}</h2>
      <div class="detail-section"><div class="detail-grid"><p><strong>Cliente</strong>${esc(order.customer_name || '—')}</p><p><strong>Email</strong>${esc(order.customer_email || '—')}</p><p><strong>Telefone</strong>${esc(order.customer_phone || '—')}</p><p><strong>Total</strong>${money(order.total_amount,order.currency)}</p></div></div>
      <div class="detail-section"><h3>Estado</h3><form class="status-form" id="order-status-form"><select name="status">${['confirmed','review','awaiting_details','production','ready_to_ship','shipped','completed','cancelled'].map(status => `<option value="${status}" ${status===order.order_status?'selected':''}>${status.replaceAll('_',' ')}</option>`).join('')}</select><button>Guardar</button></form></div>
      <div class="detail-section"><h3>Pagamento Stripe</h3><div class="detail-grid"><p><strong>Payment Intent</strong>${esc(payment.provider_payment_id || '—')}</p><p><strong>Charge</strong>${esc(payment.provider_charge_id || '—')}</p><p><strong>Bruto</strong>${money(payment.gross_amount,order.currency)}</p><p><strong>Taxas</strong>${payment.processing_fee_amount==null?'—':money(payment.processing_fee_amount,order.currency)}</p><p><strong>Líquido</strong>${payment.net_amount==null?'—':money(payment.net_amount,order.currency)}</p><p><strong>Reembolsos</strong>${money(payment.refunded_amount,order.currency)}</p></div></div>
      <div class="detail-section"><h3>Artigos e personalização</h3>${order.order_items.map(item => `<div class="line-item"><strong>${esc(item.quantity)} × ${esc(item.name)}</strong><p>${money(item.line_amount,order.currency)}</p><pre>${esc(JSON.stringify(item.personalization,null,2))}</pre></div>`).join('')}</div>
      <div class="detail-section"><h3>Ficheiros privados</h3>${filesHtml(order.attachments)}</div>`);
    document.getElementById('order-status-form').addEventListener('submit', async event => { event.preventDefault(); await adminApi('update-order',{id,orderStatus:new FormData(event.currentTarget).get('status')}); await openOrder(id); await loadOrders(); });
    bindFiles();

  } catch (error) { openDrawer(`<p class="error">${esc(error.message)}</p>`); }
}

async function openProject(id) {
  openDrawer('<p>A carregar…</p>');
  try {
    const project = await adminApi('get-project', { id });
    openDrawer(`<p class="eyebrow">Projeto personalizado</p><h2>${esc(project.project_number)}</h2>
      <div class="detail-section"><div class="detail-grid"><p><strong>Cliente</strong>${esc(project.customer_name)}</p><p><strong>Email</strong>${esc(project.customer_email)}</p><p><strong>Telefone</strong>${esc(project.customer_phone||'—')}</p><p><strong>Data do evento</strong>${esc(project.event_date||'—')}</p><p><strong>Ocasião</strong>${esc(project.occasion)}</p><p><strong>Tipo</strong>${esc(project.project_type)}</p><p><strong>Quantidade</strong>${esc(project.approximate_quantity||'—')}</p><p><strong>Orçamento indicado</strong>${esc(project.approximate_budget||'—')}</p></div><h3 style="margin-top:1rem">Ideia</h3><p>${esc(project.idea)}</p></div>
      <div class="detail-section"><h3>Estado</h3><form class="status-form" id="project-status-form"><select name="status">${['submitted','in_review','awaiting_details','quoted','approved','payment_pending','paid','production','completed','declined','archived'].map(status => `<option value="${status}" ${status===project.status?'selected':''}>${status.replaceAll('_',' ')}</option>`).join('')}</select><button>Guardar</button></form></div>
      <div class="detail-section"><h3>Ficheiros privados</h3>${filesHtml(project.attachments)}</div>
      <div class="detail-section"><h3>Novo orçamento</h3><form id="quote-form"><div id="quote-lines"><div class="quote-row"><input name="description" placeholder="Descrição" required/><input name="quantity" type="number" min="1" value="1" required/><input name="unit" type="number" min="0" step="0.01" placeholder="€/un" required/></div></div><div class="quote-actions"><button type="button" class="secondary" id="add-quote-line">+ Linha</button><button type="submit">Criar e marcar como enviado</button></div></form></div>
      <div class="detail-section"><h3>Orçamentos anteriores</h3>${(project.quotes||[]).map(q=>`<p><strong>v${q.version}</strong> · ${badge(q.status)} · ${money(q.total_amount,q.currency)} · válido até ${esc(q.valid_until||'—')}</p>`).join('')||'<p>Nenhum.</p>'}</div>`);
    document.getElementById('project-status-form').addEventListener('submit', async event => { event.preventDefault(); await adminApi('update-project',{id,status:new FormData(event.currentTarget).get('status')}); await openProject(id); await loadProjects(); });
    document.getElementById('add-quote-line').addEventListener('click', () => document.getElementById('quote-lines').insertAdjacentHTML('beforeend','<div class="quote-row"><input name="description" placeholder="Descrição" required/><input name="quantity" type="number" min="1" value="1" required/><input name="unit" type="number" min="0" step="0.01" placeholder="€/un" required/></div>'));
    document.getElementById('quote-form').addEventListener('submit', async event => { event.preventDefault(); const rows=[...event.currentTarget.querySelectorAll('.quote-row')]; const items=rows.map(row=>({description:row.querySelector('[name=description]').value,quantity:Number(row.querySelector('[name=quantity]').value),unitAmount:Math.round(Number(row.querySelector('[name=unit]').value)*100)})); const created=await adminApi('create-quote',{projectId:id,items}); if(navigator.clipboard&&created.quoteUrl) await navigator.clipboard.writeText(created.quoteUrl).catch(()=>{}); alert('Orçamento criado e enviado por email.'+(created.quoteUrl?' A ligação de aprovação foi copiada.':'')); await openProject(id); await loadProjects(); });
    bindFiles();
  } catch (error) { openDrawer(`<p class="error">${esc(error.message)}</p>`); }
}

function filesHtml(files) { return (files||[]).map(file => `<button class="file-button" data-file="${file.id}" ${file.status!=='verified'?'disabled':''}>${esc(file.original_name)} · ${esc(file.status)}</button>`).join('') || '<p>Nenhum ficheiro.</p>'; }
function bindFiles() { document.querySelectorAll('[data-file]').forEach(button => button.addEventListener('click', async () => { const result=await adminApi('signed-file',{id:button.dataset.file}); window.open(result.url,'_blank','noopener'); })); }

const { data: { session } } = await supabase.auth.getSession();
if (session) { try { await ensureMfa(); } catch (error) { document.getElementById('login-error').textContent = error.message; } }
