// A sandbox draft contains only a synthetic sale. No CRM record is sent to the provider.
export async function testDraft({ token, customer, item, request = fetch }) {
  if (!token || !customer || !item) throw new Error('Configura a chave, o cliente e o artigo da subscrição de testes.');
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' };
  const base = 'https://facturalusa.pt/api/v2';
  async function call(path, options) {
    const result = await request(base + path, { ...options, headers, redirect: 'error', signal: AbortSignal.timeout(12000) });
    if (!result.ok) throw new Error('O Facturalusa respondeu com HTTP ' + result.status + '. Verifica a configuração de teste.');
    return result.json();
  }
  const subscription = await call('/subscription/status', { method: 'GET' });
  const environment = String(subscription.environment).trim().toLowerCase();
  if (!subscription.active || !['teste', 'test', 'sandbox'].includes(environment)) {
    throw new Error('A chave tem de pertencer a uma subscrição de testes ativa.');
  }
  const payload = {
    issue_date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon' }).format(new Date()),
    document_type: 'Factura Recibo', status: 'Rascunho', customer,
    vat_type: 'IVA incluído', items: [{ id: item, quantity: 1, price: 10, vat: 23 }],
    observations: 'Venda fictícia para teste técnico', force_send_email: false, force_send_sms: false
  };
  const draft = await call('/sales', { method: 'POST', body: JSON.stringify(payload) });
  if (draft.status !== 'Rascunho' || !draft.id) throw new Error('Confirma o resultado na subscrição de testes antes de repetir.');
  return { id: draft.id };
}

export function previewOrder(row) {
  if (row.is_test || row.stripe_checkout_session_id?.startsWith('cs_test_')) return null;
  const received = row.payment_status === 'paid' ? row.total_amount : row.manual_received_amount;
  let observation = 'Aguardar pagamento ou entrega';
  if (row.payment_status.includes('refund') || row.order_status === 'cancelled') observation = 'Rever cancelamento ou devolução';
  else if (row.payment_provider === 'stripe' && received > 0 && !row.stripe_checkout_session_id?.startsWith('cs_live_')) observation = 'Confirmar modo do pagamento Stripe';
  else if (received > 0 && received < row.total_amount) observation = 'Sinal recebido · confirmar data e saldo';
  else if (received > 0) observation = 'Pago · conferir datas de entrega e pagamento';
  else if (['shipped','completed'].includes(row.order_status)) observation = 'Confirmar data de disponibilização dos artigos';
  return { reference: row.order_number, received, observation };
}
