import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const admin = readFileSync(new URL('../supabase/functions/admin-api/index.ts', import.meta.url), 'utf8');
const core = readFileSync(new URL('../supabase/functions/_shared/core.ts', import.meta.url), 'utf8');
const body = admin.split('if (action === "quote-email-preview") {')[1].split('\n    if (action === "send-quote")')[0].replace(/\}\s*$/, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const preview = new AsyncFunction('client','body','req','cleanText','ApiError','json','Deno','fetch','emailHtml', stripTypeScriptTypes('async function preview() {' + body + '\n}').replace(/^async function preview\(\) \{/, '').replace(/\}\s*$/, ''));
class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const quoteId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const notification = (id = quoteId) => ({ recipient: 'test@example.com', sent_at: '2026-11-25T18:30:00Z', created_at: '2026-11-25T18:30:00Z', provider_message_id: 'email-1', payload: { projectNumber: 'LP-TEST', quoteUrl: `https://example.com/projeto/orcamento/?quote=${id}&token=test` } });
function runPreview(rows, options = {}) {
  const filters = [];
  const client = { from(table) {
    const chain = { select() { return this; }, eq(key, value) { filters.push([table,key,value]); return this; }, order() { return this; },
      async single() { return { data: options.missingQuote ? null : { id: quoteId, project_requests: { project_number: 'LP-TEST' } } }; },
      async limit() { return { data: rows }; } };
    return chain;
  } };
  return preview(client, { id: quoteId }, {}, value => value, ApiError, (_, data) => data,
    { env: { get: () => 'server-test-key' } }, options.fetch || (async () => { throw Error('Provider unavailable'); }), () => '<p>Current model</p>');
}

test('only considers notifications belonging to this exact quote', async () => {
  const other = notification(otherId); other.payload.emailSnapshot = { html: '<p>Other quote</p>' };
  const current = notification(); current.payload.emailSnapshot = { html: '<p>Original quote</p>', subject: 'Original' };
  const email = await runPreview([other, current]);
  assert.equal(email.html, '<p>Original quote</p>');
  assert.equal(email.source, 'snapshot');
});
test('retrieves original legacy email with the server-side key', async () => {
  const email = await runPreview([notification()], { fetch: async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails/email-1');
    assert.equal(options.headers.Authorization, 'Bearer server-test-key');
    return { ok: true, json: async () => ({ html: '<p>Original legacy email</p>', subject: 'Original subject', last_event: 'delivered' }) };
  } });
  assert.equal(email.source, 'provider');
  assert.equal(email.deliveryStatus, 'delivered');
  assert.equal(email.html, '<p>Original legacy email</p>');
});
test('labels reconstruction when the original is unavailable', async () => {
  const email = await runPreview([notification()], { fetch: async () => ({ ok: false, status: 403 }) });
  assert.equal(email.source, 'template');
  assert.equal(email.html, '<p>Current model</p>');
});
test('does not report queued or failed email as sent', async () => {
  for (const [last_error, state] of [[null, 'pending'], ['Rejected', 'failed']]) {
    const row = notification(); row.sent_at = null; row.last_error = last_error;
    const email = await runPreview([row]);
    assert.equal(email.state, state);
    assert.equal(email.html, null);
  }
});
test('does not show a different quote when this quote has no email', async () => {
  await assert.rejects(runPreview([notification(otherId)]), { status: 404, code: 'email_not_found' });
});
test('does not query notifications for a nonexistent quote', async () => {
  await assert.rejects(runPreview([], { missingQuote: true }), { status: 404, code: 'quote_not_found' });
});
test('saves exactly the subject and HTML submitted to the email provider', async () => {
  let saved, submitted;
  const source = core.slice(core.indexOf('export async function queueEmail('), core.indexOf('\nfunction escapeText(')).replace(/^export /gm, '');
  const queueEmail = new Function('serviceClient','Deno','fetch','emailHtml', stripTypeScriptTypes(source) + '; return queueEmail;')(
    () => ({ from() { return { insert(value) { saved = value; return { select() { return { single: async () => ({ data: { id: 'outbox-1' } }) }; } }; }, update() { return { eq: async () => ({}) }; } }; } }),
    { env: { get: key => key === 'RESEND_API_KEY' ? 'server-key' : undefined } },
    async (_, options) => { submitted = JSON.parse(options.body); return { ok: true, json: async () => ({ id: 'email-1' }) }; },
    () => '<p>Exact snapshot</p>'
  );
  await queueEmail('quote_ready', 'test@example.com', { quoteId, projectNumber: 'LP-TEST' });
  assert.equal(saved.payload.emailSnapshot.html, submitted.html);
  assert.equal(saved.payload.emailSnapshot.subject, submitted.subject);
  assert.equal(saved.payload.quoteId, quoteId);
  assert.equal(saved.payload.emailSnapshot.from, submitted.from);
});
test('email preview remains behind administrator authentication and in an isolated frame', () => {
  assert.ok(admin.indexOf('await requireAdmin(req)') < admin.indexOf('if (action === "quote-email-preview")'));
  const ui = readFileSync(new URL('../admin/admin.js', import.meta.url), 'utf8');
  assert.match(ui, /iframe title="Conteúdo do email enviado" sandbox="allow-popups allow-popups-to-escape-sandbox"/);
  assert.ok(ui.includes('frame.srcdoc = quoteEmailPreviewDocument(email.html)'));
  assert.ok(!ui.includes('sandbox="allow-scripts'));
  assert.ok(ui.includes("link.setAttribute('target', '_blank')"));
  assert.ok(ui.includes("link.setAttribute('rel', 'noopener noreferrer')"));
});
