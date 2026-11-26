import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { database, loadFunction, post } from './security-harness.mjs';

const token = 'customer-secret';
const owner = { access_token_hash: createHash('sha256').update(token).digest('hex'), access_token_expires_at: '2099-01-01' };

for (const kind of ['order', 'project']) {
  for (const supplied of [undefined, 'someone-elses-token', token]) {
    test(`verified ${kind} attachment: ${supplied === token ? 'valid owner' : supplied || 'missing token'}`, async () => {
      const client = database(() => ({ data: { id: 'file', status: 'verified', order_id: kind === 'order' ? 'order' : null, orders: owner, project_requests: owner } }));
      const { handler } = await loadFunction('attachment-confirm', { client });
      const response = await handler(post({ attachmentId: 'file', ownerToken: supplied }));
      assert.equal(response.status, supplied === token ? 200 : 403);
      assert.equal(client.calls.filter(q => q.operation !== 'select').length, 0);
    });
  }
}

test('verified attachment rejects an expired owner token', async () => {
  const client = database(() => ({ data: { status: 'verified', order_id: 'order', orders: { ...owner, access_token_expires_at: '2020-01-01' } } }));
  const { handler } = await loadFunction('attachment-confirm', { client });
  assert.equal((await handler(post({ attachmentId: 'file', ownerToken: token }))).status, 410);
});
