import test from 'node:test';
import assert from 'node:assert/strict';
import { testDraft, previewOrder } from '../supabase/functions/_shared/facturalusa-test.mjs';

const config = { token: 'fake', item: 'demo', customer: 'demo' };
test('only an active test subscription receives a synthetic draft', async () => {
  for (const [environment, active] of [['Produção', true], ['Teste', false], ['unknown', true]]) {
    let calls = 0;
    const request = async () => { calls++; return Response.json({ environment, active }); };
    await assert.rejects(testDraft({ ...config, request }));
    assert.equal(calls, 1);
  }
  const paths = [];
  const request = async (url, init) => {
    paths.push(new URL(url).pathname);
    if (init.method === 'GET') return Response.json({ environment: 'Teste', active: true });
    const payload = JSON.parse(init.body);
    assert.equal(payload.status, 'Rascunho');
    assert.equal(payload.force_send_email, false);
    assert.equal(payload.customer, 'demo');
    return Response.json({ id: 7, status: 'Rascunho' });
  };
  assert.deepEqual(await testDraft({ ...config, request }), { id: 7 });
  assert.deepEqual(paths, ['/api/v2/subscription/status','/api/v2/sales']);
});
test('preview distinguishes test sessions and a partial manual payment', () => {
  const row = { payment_status: 'unpaid', manual_received_amount: 500, total_amount: 1000 };
  assert.equal(previewOrder({ ...row, is_test: true }), null);
  assert.equal(previewOrder({ ...row, stripe_checkout_session_id: 'cs_test_123' }), null);
  assert.equal(previewOrder(row).received, 500);
  assert.match(previewOrder(row).observation, /Sinal/);
});
