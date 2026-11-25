import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database, loadFunction, post } from './security-harness.mjs';

const variant = { id: 'variant', code: 'variant', unit_amount: 100, minimum_quantity: 1, products: { id: 'product', code: 'product', name: 'Test', active: true, metadata: {} } };
for (const quantity of [-1, 0, 1.5, 501, 1e100, '2', 'text', true, null]) {
  test(`checkout rejects quantity ${JSON.stringify(quantity)} without creating an order`, async () => {
    const client = database(q => q.table === 'product_variants' ? { data: [variant] } : { count: 0 });
    const { handler } = await loadFunction('checkout-prepare', { client });
    const response = await handler(post({ items: [{ lineKey: 'item', productCode: 'product', variantCode: 'variant', quantity }] }));
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, 'invalid_quantity');
    assert.equal(client.calls.filter(q => q.table === 'orders').length, 0);
  });
}
for (const quantity of [1, 500]) {
  test(`checkout accepts boundary ${quantity} and calculates price on the server`, async () => {
    const client = database(q => {
      if (q.table === 'product_variants') return { data: [variant] };
      if (q.table === 'orders') return { data: { id: 'order', total_amount: q.values.total_amount } };
      if (q.table === 'order_items') return { data: [{ id: 'item' }] };
      return { count: 0 };
    });
    const { handler } = await loadFunction('checkout-prepare', { client });
    const response = await handler(post({ total_amount: 1, payment_status: 'paid', items: [{ lineKey: 'item', productCode: 'product', variantCode: 'variant', quantity, unitAmount: 1 }] }));
    assert.equal(response.status, 200);
    const order = client.calls.find(q => q.table === 'orders').values;
    assert.equal(order.total_amount, quantity * 100 + (quantity === 500 ? 0 : 590));
    assert.equal(order.payment_status, 'unpaid');
  });
}
