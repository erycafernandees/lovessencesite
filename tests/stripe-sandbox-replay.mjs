import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { database, loadFunction } from './security-harness.mjs';

// Replay a provider-confirmed sandbox session through the actual webhook and
// order-status handlers against disposable PostgreSQL. Provider transport and
// Supabase's query transport are adapters; application code and SQL are real.
// No external requests or emails are possible from this runner.
export async function replaySandbox(pg,fixturePath,sdkRoot) {
  const {order,session}=JSON.parse(await readFile(fixturePath,'utf8'));
  assert.equal(session.livemode,false);assert.equal(session.payment_status,'paid');
  assert.equal(session.metadata.order_id,order.id);assert.equal(session.amount_total,order.total_amount);
  const intent=session.payment_intent;
  assert.equal(intent.status,'succeeded');
  const {default:Stripe}=await import(pathToFileURL(resolve(sdkRoot,'node_modules/stripe/esm/stripe.esm.node.js')));
  class SandboxStripe extends Stripe {
    constructor(){
      super('sk_test_local_replay');
      this.checkout.sessions.retrieve=async id=>{assert.equal(id,session.id);return session};
      this.paymentIntents.retrieve=async id=>{assert.equal(id,intent.id);return intent};
    }
  }
  await pg.query('insert into public.orders(id,order_number,access_token_hash,subtotal_amount,discount_amount,shipping_amount,total_amount,stripe_checkout_session_id) values($1,$2,$3,$4,$5,$6,$7,$8)',[order.id,order.order_number,order.access_token_hash,order.subtotal_amount,order.discount_amount,order.shipping_amount,order.total_amount,session.id]);
  for(const item of order.order_items)await pg.query('insert into public.order_items(id,order_id,product_code,variant_code,name,quantity,unit_amount,line_amount,product_snapshot,personalization) values($1,$2,$3,$4,$5,$6,$7,$7,$8,$9)',[item.id,order.id,item.product_code,item.variant_code,item.name,item.quantity,item.line_amount,item.product_snapshot,item.personalization]);
  const client=database(async q=>{
    try {
      if(q.table==='orders'&&q.operation==='select'){
        const result=await pg.query('select o.*,coalesce((select jsonb_agg(i) from public.order_items i where i.order_id=o.id),\'[]\'::jsonb) as order_items from public.orders o where o.id=$1',[order.id]);
        return {data:result.rows[0]};
      }
      if(q.table==='webhook_events') {
        if(q.operation==='insert')await pg.query('insert into public.webhook_events(provider,event_id,event_type,payload) values($1,$2,$3,$4)',[q.values.provider,q.values.event_id,q.values.event_type,q.values.payload]);
        else if(q.operation==='update')await pg.query('update public.webhook_events set processed_at=$1,error=$2 where provider=$3 and event_id=$4',[q.values.processed_at??null,q.values.error??null,'stripe',event.id]);
        else return {data:(await pg.query('select processed_at from public.webhook_events where provider=$1 and event_id=$2',['stripe',event.id])).rows[0]};
        return {data:null};
      }
      throw new Error('Unexpected replay query '+q.table+'/'+q.operation);
    } catch(error){return {error:{code:error.code,message:error.message}}}
  });
  client.rpc=async(name,args)=>{
    assert.equal(name,'finalize_stripe_checkout');
    return {data:(await pg.query('select public.finalize_stripe_checkout($1,$2,$3) result',[args.p_session,args.p_payment,args.p_admin_email])).rows[0].result};
  };
  const secret='local-sandbox-replay-signature';
  const event={id:'evt_local_replay_825',type:'checkout.session.completed',livemode:false,data:{object:{id:session.id}}};
  const payload=JSON.stringify(event);
  const signature=Stripe.webhooks.generateTestHeaderString({payload,secret});
  const {handler}=await loadFunction('stripe-webhook',{client,StripeSDK:SandboxStripe,env:{STRIPE_WEBHOOK_SECRET:secret,ADMIN_NOTIFICATION_EMAIL:'admin@example.invalid'}});
  const request=()=>new Request('https://local.invalid/webhook',{method:'POST',headers:{'stripe-signature':signature},body:payload});
  assert.equal((await handler(request())).status,200);
  const second=await handler(request());assert.equal(second.status,200);assert.equal((await second.json()).duplicate,true);
  assert.equal((await pg.query('select count(*)::int n from public.payments where order_id=$1',[order.id])).rows[0].n,1);
  const notifications=(await pg.query("select template,recipient,sent_at from public.notification_outbox where payload->>'orderId'=$1 order by template",[order.id])).rows;
  assert.deepEqual(notifications.map(x=>x.template),['admin_order_paid','order_paid']);
  assert.ok(notifications.every(x=>x.recipient.endsWith('@example.invalid')&&x.sent_at===null));
  const {handler:statusHandler}=await loadFunction('order-status',{client,StripeSDK:SandboxStripe});
  const response=await statusHandler(new Request('https://local.invalid/order-status?session_id='+session.id));
  assert.equal(response.status,200);const status=await response.json();
  assert.equal(status.paid,true);assert.equal(status.totalAmount,1880);assert.equal(status.orderNumber,order.order_number);
  console.log('PASS provider-confirmed test Checkout EUR 18.80 -> signed webhook -> PostgreSQL payment -> duplicate rejection -> confirmation data -> two queued emails');
  console.log('SANDBOX_REPLAY_PASSED=1; live charges=0; emails sent=0; Supabase gateway transport not exercised');
}
