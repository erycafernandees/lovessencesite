import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { database, loadFunction } from './security-harness.mjs';

// The original signed event and current test charge are supplied over stdin,
// never committed. The receiver independently checks Stripe's real delivery.
// This replay uses disposable PostgreSQL and adapters for provider/DB transport.
export async function replayProviderRefund(pg, input, sdkRoot) {
  const { raw, signature, secret, charge } = input;
  const event = JSON.parse(raw);
  assert.equal(event.livemode, false);
  assert.equal(event.type, 'charge.refunded');
  assert.equal(charge.livemode, false);
  assert.equal(charge.id, event.data.object.id);
  assert.equal(charge.refunded, true);
  assert.equal(charge.amount_refunded, charge.amount);
  const { default: Stripe } = await import(pathToFileURL(resolve(sdkRoot, 'node_modules/stripe/esm/stripe.esm.node.js')));
  class SandboxStripe extends Stripe {
    constructor() {
      super('sk_test_signature_verification_only');
      this.charges.retrieve = async id => { assert.equal(id, charge.id); return charge; };
    }
  }
  const client = database(async q => {
    assert.equal(q.table, 'webhook_events');
    try {
      if (q.operation === 'insert') await pg.query('insert into public.webhook_events(provider,event_id,event_type,payload) values($1,$2,$3,$4)', ['stripe', event.id, event.type, event]);
      else if (q.operation === 'update') await pg.query('update public.webhook_events set processed_at=$1,error=$2 where provider=$3 and event_id=$4', [q.values.processed_at ?? null, q.values.error ?? null, 'stripe', event.id]);
      else return { data: (await pg.query('select processed_at from public.webhook_events where provider=$1 and event_id=$2', ['stripe', event.id])).rows[0] };
      return { data: null };
    } catch (error) { return { error: { code: error.code, message: error.message } }; }
  });
  client.rpc = async (name, args) => {
    assert.equal(name, 'record_stripe_refund');
    await pg.query('select public.record_stripe_refund($1)', [args.p_charge]);
    return { data: null };
  };
  const { handler } = await loadFunction('stripe-webhook', { client, StripeSDK: SandboxStripe, env: { STRIPE_WEBHOOK_SECRET: secret } });
  const request = () => new Request('https://local.invalid/webhook', { method: 'POST', headers: { 'stripe-signature': signature }, body: raw });
  assert.equal((await handler(request())).status, 200);
  const second = await handler(request());
  assert.equal(second.status, 200); assert.equal((await second.json()).duplicate, true);
  const state = (await pg.query('select o.payment_status,p.status,p.refunded_amount from public.orders o join public.payments p on p.order_id=o.id where p.provider_charge_id=$1', [charge.id])).rows[0];
  assert.deepEqual(state, { payment_status: 'refunded', status: 'refunded', refunded_amount: charge.amount });
  assert.equal((await pg.query('select count(*)::int n from public.refunds where provider_refund_id=$1', [charge.refunds.data[0].id])).rows[0].n, 1);
  console.log('PROVIDER_REFUND_REPLAY_PASSED: original Stripe signature, real handler/SQL, full refund and duplicate');
}
