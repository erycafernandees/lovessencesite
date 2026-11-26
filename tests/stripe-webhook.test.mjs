import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database, loadFunction, post } from './security-harness.mjs';

const order = { id: 'order', stripe_checkout_session_id: 'cs_current', payment_provider: 'stripe', payment_status: 'unpaid', currency: 'eur', subtotal_amount: 2000, discount_amount: 100, shipping_amount: 590, total_amount: 2490 };
const checkout = { id: 'cs_current', livemode: false, metadata: { order_id: 'order' }, mode: 'payment', status: 'complete', payment_status: 'paid', currency: 'eur', amount_subtotal: 2490, amount_total: 2490, total_details: { amount_discount: 0, amount_tax: 0, amount_shipping: 0 }, payment_intent: 'pi_current' };

async function fixture({ session = {}, before = {}, eventType = 'checkout.session.completed', signature = true, rpcError = null, duplicate = false, intent = {} } = {}) {
  const stored = { ...order, ...before };
  const liveSession = { ...checkout, ...session };
  const rpcCalls = [];
  const client = database(q => {
    if (q.table === 'webhook_events') {
      if (q.operation === 'insert' && duplicate) return { error: { code: '23505' } };
      return { data: duplicate ? { processed_at: '2026-01-01' } : null };
    }
    if (q.table === 'orders') {
      if (q.operation === 'update') {
        const stateFilter = q.filters.find(f => f[0] === 'in' && f[1] === 'payment_status');
        const sessionFilter = q.filters.find(f => f[0] === 'eq' && f[1] === 'stripe_checkout_session_id');
        if (stateFilter?.[2].includes(stored.payment_status) && sessionFilter?.[2] === stored.stripe_checkout_session_id) Object.assign(stored, q.values);
      }
      return { data: stored };
    }
    throw new Error(`Unexpected table ${q.table}`);
  });
  client.rpc = async (name, args) => { rpcCalls.push({ name, args }); return { data: { notifications: [] }, error: rpcError }; };
  const event = { id: 'evt_current', type: eventType, livemode: false, data: { object: { id: 'cs_current', metadata: { order_id: 'order' }, ...checkout } } };
  const stripe = {
    webhooks: { constructEventAsync: async () => { if (!signature) throw new Error('Signature rejected by provider SDK'); return event; } },
    checkout: { sessions: { retrieve: async () => liveSession } },
    paymentIntents: { retrieve: async () => ({ id: 'pi_current', status: 'succeeded', metadata: { order_id: 'order' }, amount_received: liveSession.amount_total, currency: liveSession.currency, latest_charge: null, ...intent }) },
  };
  const { handler } = await loadFunction('stripe-webhook', { client, stripe, env: { STRIPE_WEBHOOK_SECRET: 'test-only' } });
  return { response: await handler(post({}, { 'stripe-signature': 'test-only' })), client, rpcCalls, stored };
}

test('invalid signature is rejected before any database call', async () => {
  const f = await fixture({ signature: false });
  assert.equal(f.response.status, 400);
  assert.equal(f.client.calls.length, 0);
});
for (const [name, session] of Object.entries({
  'another checkout session': { id: 'cs_other' },
  'another currency': { currency: 'usd' },
  'another order': { metadata: { order_id: 'other' } },
  'altered base price': { amount_subtotal: 200, amount_total: 200 },
  'missing amount': { amount_total: null },
  'inconsistent total': { amount_total: 1 },
  'negative discount': { total_details: { amount_discount: -1, amount_tax: 0, amount_shipping: 0 } },
  'uncompleted session': { status: 'open' },
  'another Stripe mode': { livemode: true },
})) {
  test(`webhook rejects ${name} without finalizing payment`, async () => {
    const f = await fixture({ session });
    assert.ok(f.response.status >= 400);
    assert.equal(f.rpcCalls.length, 0);
    assert.equal(f.client.calls.filter(q => q.table === 'orders' && q.operation === 'update').length, 0);
  });
}
test('valid payment uses the atomic finalization RPC', async () => {
  const f = await fixture();
  assert.equal(f.response.status, 200);
  assert.equal(f.rpcCalls.length, 1);
  assert.equal(f.rpcCalls[0].name, 'finalize_stripe_checkout');
  assert.equal(f.rpcCalls[0].args.p_session.id, 'cs_current');
});
test('legitimate Stripe promotion codes remain valid', async () => {
  const f = await fixture({ session: { amount_total: 2290, total_details: { amount_discount: 200, amount_tax: 0, amount_shipping: 0 } } });
  assert.equal(f.response.status, 200);
  assert.equal(f.rpcCalls.length, 1);
});
test('nullable Stripe shipping amount is accepted when shipping is an existing line item', async () => {
  const f = await fixture({ session: { total_details: { amount_discount: 0, amount_tax: 0, amount_shipping: null } } });
  assert.equal(f.response.status, 200);
  assert.equal(f.rpcCalls.length, 1);
});
test('100 percent Stripe coupon may complete without a PaymentIntent', async () => {
  const f = await fixture({ session: { payment_intent: null, payment_status: 'no_payment_required', amount_total: 0, total_details: { amount_discount: 2490, amount_tax: 0, amount_shipping: 0 } } });
  assert.equal(f.response.status, 200);
  assert.equal(f.rpcCalls.length, 1);
});
test('an asynchronous success event cannot mark an unpaid session paid', async () => {
  const f = await fixture({ eventType: 'checkout.session.async_payment_succeeded', session: { payment_status: 'unpaid' } });
  assert.equal(f.response.status, 500);
  assert.equal(f.rpcCalls.length, 0);
});
for (const payment_status of ['paid', 'partially_refunded', 'refunded']) {
  for (const eventType of ['checkout.session.completed', 'checkout.session.async_payment_failed']) {
    test(`${eventType} cannot downgrade ${payment_status}`, async () => {
      const f = await fixture({ before: { payment_status }, eventType, session: { payment_status: 'unpaid' } });
      assert.equal(f.response.status, 200);
      assert.equal(f.stored.payment_status, payment_status);
    });
  }
}
test('completed duplicate event skips finalization', async () => {
  const f = await fixture({ duplicate: true });
  assert.equal(f.response.status, 200);
  assert.equal(f.rpcCalls.length, 0);
  assert.equal((await f.response.json()).duplicate, true);
});
test('database failure is retriable and event is not marked processed', async () => {
  const f = await fixture({ rpcError: { message: 'transaction failed' } });
  assert.equal(f.response.status, 500);
  assert.equal(f.client.calls.some(q => q.table === 'webhook_events' && q.operation === 'update' && q.values.processed_at), false);
});
test('unconfirmed or mismatched PaymentIntent is rejected', async () => {
  for (const intent of [{ status: 'processing' }, { currency: 'usd' }, { amount_received: 1 }, { metadata: { order_id: 'other' } }]) {
    const f = await fixture({ intent });
    assert.equal(f.response.status, 409);
    assert.equal(f.rpcCalls.length, 0);
  }
});
