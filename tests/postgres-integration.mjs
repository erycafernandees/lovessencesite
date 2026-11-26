import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Tools are installed separately from application dependencies. This runner
// always creates its own local cluster; it never accepts a production DB URL.
const toolsRoot = process.env.SECURITY_TEST_TOOLS;
if (!toolsRoot) throw new Error('Set SECURITY_TEST_TOOLS to the isolated tools directory');
const { default: EmbeddedPostgres } = await import(pathToFileURL(resolve(toolsRoot, 'node_modules/embedded-postgres/dist/index.js')));
const directory = await mkdtemp(join(tmpdir(), 'love-security-pg-'));
const server = new EmbeddedPostgres({
  databaseDir: directory, user: 'postgres', password: 'local-test-only', port: 55439,
  persistent: false, autoRehydrateSymlinks: true,
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'unix_socket_directories=', '-c', 'max_connections=40'],
  onLog(message) { if (process.env.SECURITY_TEST_DEBUG) console.error(message); },
  onError(message) { console.error(message); },
});
let client;
const connections = [];
let passed = 0;
let failed = false;
async function check(name, callback) {
  await callback();
  passed++;
  console.log(`PASS ${name}`);
}
async function connect() {
  const c = server.getPgClient('postgres', '127.0.0.1');
  await c.connect(); connections.push(c); return c;
}
const fixtureId = '00000000-0000-4000-8000-000000000611';
const session = {
  id: 'cs_concurrent_611', metadata: { order_id: fixtureId }, mode: 'payment', status: 'complete', payment_status: 'paid',
  currency: 'eur', amount_subtotal: 2490, amount_total: 2290,
  total_details: { amount_discount: 200, amount_tax: 0, amount_shipping: 0 }, customer_details: { email: 'local@example.invalid' },
};
const payment = { payment_intent_id: 'pi_concurrent_611', charge_id: 'ch_concurrent_611', refunded_amount: 0, fee: 50, net: 2240 };
const finalize = (c, s = session, p = payment) => c.query('select public.finalize_stripe_checkout($1::jsonb,$2::jsonb,$3::text)', [s,p,'admin@example.invalid']);
const refund = (c, amount) => c.query('select public.record_stripe_refund($1::jsonb)', [{ id: payment.charge_id, currency: 'eur', amount: 2290, amount_refunded: amount, refunds: { data: [] } }]);

try {
  await server.initialise(); await server.start(); client = await connect();
  console.log((await client.query('select version()')).rows[0].version);
  await client.query(`
    create schema extensions; create schema auth; create schema storage;
    create role anon; create role authenticated; create role service_role bypassrls;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key,bucket_id text,name text);
    alter table storage.objects enable row level security;
  `);
  const liveFixture = process.env.SECURITY_SCHEMA_FIXTURE;
  if (liveFixture) await client.query(await readFile(resolve(liveFixture),'utf8'));
  const migrations = liveFixture
    ? ['20261125183500_quantity_bounds.sql','20261125184000_stripe_finalization.sql','20261125220000_checkout_reservation.sql','20261125221000_atomic_rate_limit.sql']
    : ['202608210001_commerce.sql','20261125183500_quantity_bounds.sql','20261125184000_stripe_finalization.sql','20261125220000_checkout_reservation.sql','20261125221000_atomic_rate_limit.sql'];
  for (const file of migrations) {
    await client.query(await readFile(resolve('supabase/migrations',file),'utf8'));
  }
  await client.query('grant usage on schema public,auth to anon,authenticated,service_role; grant all on all tables in schema public to anon,authenticated,service_role; grant all on all sequences in schema public to service_role');
  await check('SQL rejection, coupon, duplicate, refund and RPC privilege fixtures', async () => {
    const sql = (await readFile('tests/stripe-finalization.sql','utf8')).replace(/^\\set.*$/m,'');
    await client.query(sql);
  });
  await client.query('insert into public.orders(id,order_number,access_token_hash,subtotal_amount,discount_amount,shipping_amount,total_amount,stripe_checkout_session_id) values($1,$2,$3,2000,100,590,2490,$4)', [fixtureId,'SECURITY-CONCURRENT-611','test-only',session.id]);
  await check('12 simultaneous deliveries produce one payment, history and notification pair', async () => {
    const clients = await Promise.all(Array.from({length:12},connect));
    await Promise.all(clients.map(c => finalize(c)));
    for (const [table, expected, column] of [['payments',1,'order_id'],['order_status_history',1,'order_id'],['notification_outbox',2,"payload->>'orderId'"]]) {
      const count = await client.query(`select count(*)::int as count from public.${table} where ${column}=$1`,[fixtureId]);
      assert.equal(count.rows[0].count,expected,table);
    }
  });
  await check('concurrent full/partial refunds cannot reduce the refunded amount', async () => {
    await Promise.all(connections.slice(1).map((c,i)=>refund(c,i%2?100:2290)));
    const result = await client.query('select o.payment_status,p.refunded_amount from public.orders o join public.payments p on p.order_id=o.id where o.id=$1',[fixtureId]);
    assert.equal(result.rows[0].payment_status,'refunded'); assert.equal(result.rows[0].refunded_amount,2290);
  });
  await check('late successful checkout cannot undo a full refund', async () => {
    const result = await finalize(client);
    assert.deepEqual(result.rows[0].finalize_stripe_checkout.notifications, []);
    assert.equal((await client.query('select payment_status from public.orders where id=$1',[fixtureId])).rows[0].payment_status,'refunded');
  });
  await check('failed notification insert rolls back payment and order updates', async () => {
    const id='00000000-0000-4000-8000-000000000612';
    await client.query('insert into public.orders(id,order_number,access_token_hash,subtotal_amount,discount_amount,shipping_amount,total_amount,stripe_checkout_session_id) values($1,$2,$3,2000,100,590,2490,$4)',[id,'SECURITY-ROLLBACK-612','test-only','cs_rollback_612']);
    await client.query(`create function public.test_notification_failure() returns trigger language plpgsql as $$ begin if new.payload->>'orderId'='${id}' then raise exception 'injected notification insert failure'; end if; return new; end $$; create trigger test_notification_failure before insert on public.notification_outbox for each row execute function public.test_notification_failure()`);
    await assert.rejects(finalize(client,{...session,id:'cs_rollback_612',metadata:{order_id:id}},{...payment,payment_intent_id:'pi_rollback_612',charge_id:'ch_rollback_612'}),/injected notification/);
    assert.equal((await client.query('select payment_status from public.orders where id=$1',[id])).rows[0].payment_status,'unpaid');
    assert.equal((await client.query('select count(*)::int n from public.payments where order_id=$1',[id])).rows[0].n,0);
    assert.equal((await client.query('select count(*)::int n from public.order_status_history where order_id=$1',[id])).rows[0].n,0);
    await client.query('drop trigger test_notification_failure on public.notification_outbox; drop function public.test_notification_failure()');
  });
  await check('anon and authenticated non-admins cannot read orders via RLS', async () => {
    for (const role of ['anon','authenticated']) {
      await client.query(`set role ${role}`);
      try { assert.equal((await client.query('select id from public.orders')).rowCount,0); }
      finally { await client.query('reset role'); }
    }
  });
  await check('12 concurrent quote approvals reserve a single order and one payment session', async () => {
    const projectId='00000000-0000-4000-8000-000000000701', quoteId='00000000-0000-4000-8000-000000000702';
    await client.query(`insert into public.project_requests(id,customer_name,customer_email,occasion,project_type,idea,access_token_hash,consent_at) values($1,'Local Test','local@example.invalid','Empresa','Velas','Fixture','test-only',now())`,[projectId]);
    await client.query(`insert into public.quotes(id,project_request_id,status,access_token_hash,access_token_expires_at,subtotal_amount,total_amount) values($1,$2,'sent','quote-test-hash',now()+interval '1 day',1000,1000)`,[quoteId,projectId]);
    const reservations=await Promise.all(connections.slice(1).map((c,i)=>c.query('select public.reserve_quote_checkout($1,$2,$3) as result',[quoteId,'quote-test-hash','order-hash-'+i])));
    const orderIds=reservations.map(r=>r.rows[0].result.order.id);
    assert.equal(new Set(orderIds).size,1);
    assert.equal((await client.query('select count(*)::int n from public.orders where project_request_id=$1',[projectId])).rows[0].n,1);
    await Promise.all(connections.slice(1).map(c=>c.query('select public.attach_stripe_checkout($1,$2)',[orderIds[0],'cs_quote_702'])));
    assert.equal((await client.query('select count(*)::int n from public.payments where order_id=$1',[orderIds[0]])).rows[0].n,1);
    await assert.rejects(client.query('select public.attach_stripe_checkout($1,$2)',[orderIds[0],'cs_other_702']),/already bound/);
    await assert.rejects(client.query('select public.reserve_quote_checkout($1,$2,$3)',[quoteId,'wrong-hash','order-hash']),/invalid or expired/);
  });
  await check('12 simultaneous requests consume exactly 3 rate limit slots', async () => {
    const results=await Promise.all(connections.slice(1).map(c=>c.query("select public.consume_api_rate_limit('test-action','test-client',3,60) allowed")));
    assert.equal(results.filter(r=>r.rows[0].allowed).length,3);
    assert.equal((await client.query("select count(*)::int n from public.api_requests where action='test-action' and client_hash='test-client'")).rows[0].n,3);
  });
  await check('quote approval and payment finalization use a consistent lock order',async()=>{
    const q='00000000-0000-4000-8000-000000000702', holder=connections[1],worker=connections[2];
    const orderId=(await client.query('select order_id from public.quotes where id=$1',[q])).rows[0].order_id;
    const s={...session,id:'cs_quote_702',metadata:{order_id:orderId,quote_id:q},amount_subtotal:1000,amount_total:1000,total_details:{amount_discount:0,amount_tax:0,amount_shipping:0}};
    const p={...payment,payment_intent_id:'pi_quote_702',charge_id:'ch_quote_702',fee:0,net:1000};
    await holder.query('begin');
    await holder.query("set local statement_timeout='2s'");
    await holder.query('select id from public.quotes where id=$1 for update',[q]);
    const pending=finalize(worker,s,p).then(result=>({result}),error=>({error}));
    try{
      for(let i=0;i<30;i++){
        const state=await client.query("select wait_event_type from pg_stat_activity where pid=$1",[worker.processID]);
        if(state.rows[0].wait_event_type==='Lock')break;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      await holder.query('select public.reserve_quote_checkout($1,$2,$3)',[q,'quote-test-hash','fixture-hash']);
      await holder.query('commit');
    }catch(error){await holder.query('rollback');throw error;}
    const result=await pending;if(result.error)throw result.error;
    assert.equal((await client.query('select payment_status from public.orders where id=$1',[orderId])).rows[0].payment_status,'paid');
  });
  await check('RLS requires an active administrator with MFA and blocks viewer writes', async () => {
    const userId='00000000-0000-4000-8000-000000001401';
    await client.query('insert into auth.users(id) values($1)',[userId]);
    await client.query("insert into public.admin_users(user_id,role,active) values($1,'owner',true)",[userId]);
    await client.query("select set_config('request.jwt.claim.sub',$1,false)",[userId]);
    await client.query('set role authenticated');
    try {
      await client.query("select set_config('request.jwt.claims','{\"aal\":\"aal1\"}',false)");
      assert.equal((await client.query('select id from public.orders')).rowCount,0);
      await client.query("select set_config('request.jwt.claims','{\"aal\":\"aal2\"}',false)");
      assert.ok((await client.query('select id from public.orders')).rowCount>0);
    } finally { await client.query('reset role'); }
    await client.query("update public.admin_users set role='viewer' where user_id=$1",[userId]);
    await client.query('set role authenticated');
    try { assert.equal((await client.query("update public.orders set order_status='cancelled' where id=$1",[fixtureId])).rowCount,0); }
    finally { await client.query('reset role'); }
    await client.query('update public.admin_users set active=false where user_id=$1',[userId]);
    await client.query('set role authenticated');
    try { assert.equal((await client.query('select id from public.orders')).rowCount,0); }
    finally { await client.query('reset role'); }
  });
  await check('SQL quantity constraints reject oversized administrative lines', async () => {
    await assert.rejects(client.query("insert into public.quote_items(quote_id,description,quantity,unit_amount,line_amount) values($1,'Fixture',10001,1,10001)",['00000000-0000-4000-8000-000000000702']),error=>error.code==='23514');
    await assert.rejects(client.query("insert into public.order_items(order_id,product_code,variant_code,name,quantity,unit_amount,line_amount) values($1,'fixture','fixture','Fixture',10001,1,10001)",[fixtureId]),error=>error.code==='23514');
  });
  await check('all six RPCs require service_role and execute under its actual privileges',async()=>{
    for(const signature of ['finalize_stripe_checkout(jsonb,jsonb,text)','record_stripe_refund(jsonb)','reserve_quote_checkout(uuid,text,text)','attach_stripe_checkout(uuid,text)','consume_api_rate_limit(text,text,integer,integer)','claim_test_checkout_code(text,uuid)']){
      const result=await client.query("select has_function_privilege('anon',$1,'execute') a,has_function_privilege('authenticated',$1,'execute') b,has_function_privilege('service_role',$1,'execute') s",['public.'+signature]);
      assert.deepEqual(result.rows[0],{a:false,b:false,s:true});
    }
    await client.query('set role service_role');
    try {
      await finalize(client);
      assert.equal((await client.query("select public.consume_api_rate_limit('service-test','fixture',3,60) allowed")).rows[0].allowed,true);
    }finally{await client.query('reset role');}
  });
  if(liveFixture)await check('one-use checkout code retries the same order and blocks another order',async()=>{
    await client.query("insert into public.one_time_checkout_codes(code) values('LOCAL-COUPON')");
    await client.query('set role service_role');
    try{
      for(const [id,expected] of [[fixtureId,true],[fixtureId,true],['00000000-0000-4000-8000-000000000612',false]])
        assert.equal((await client.query("select public.claim_test_checkout_code('LOCAL-COUPON',$1) claimed",[id])).rows[0].claimed,expected);
    }finally{await client.query('reset role');}
  });
  if(process.env.SECURITY_STRIPE_FIXTURE){
    const {replaySandbox}=await import('./stripe-sandbox-replay.mjs');
    await replaySandbox(client,process.env.SECURITY_STRIPE_FIXTURE,process.env.SECURITY_STRIPE_TOOLS||toolsRoot);
  }
  console.log(`POSTGRES_INTEGRATION_PASSED=${passed}`);
} catch (error) {
  console.error('POSTGRES_INTEGRATION_FAILED', error); failed = true; process.exitCode = 1;
} finally {
  await Promise.allSettled(connections.map(c=>c.end()));
  await server.stop();
}
if (failed) process.exit(1);
