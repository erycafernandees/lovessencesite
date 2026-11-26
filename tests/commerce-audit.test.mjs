import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,loadFunction,post} from './security-harness.mjs';

const old=new Date(Date.now()-10*86400000).toISOString();
const recent=new Date(Date.now()-86400000).toISOString();
const order={id:'order',order_number:'LOCAL-AUDIT',created_at:recent,is_test:false,payment_status:'paid',payment_provider:'stripe',total_amount:1000,stripe_checkout_session_id:'cs_audit'};
const session={id:'cs_audit',mode:'payment',status:'complete',payment_status:'paid',metadata:{order_id:'order'},created:Math.floor(Date.now()/1000)-86400,amount_total:1000};
async function audit({sessions=[session],orders=[order],older=[],trusted=true}={}){
  const client=database(q=>{
    if(q.table==='orders')return {data:q.filters.some(f=>f[0]==='in')?older:orders};
    if(q.table==='payments')return {data:orders.map(o=>({order_id:o.id,provider:'stripe',status:'paid'}))};
    if(q.table==='webhook_events')return {data:[]};
    if(q.table==='notification_outbox')return {data:[],count:1};
    throw new Error('Unexpected audit query '+q.table);
  });
  const externalModules={'npm:jose@6.1.0':{
    createRemoteJWKSet:()=>({}),jwtVerify:async()=>({payload:{repository:trusted?'erycafernandees/lovessencesite':'untrusted/repository',repository_id:'1210285972',ref:'refs/heads/main',workflow_ref:'erycafernandees/lovessencesite/.github/workflows/commerce-audit.yml@refs/heads/main',event_name:'push'}}),
  }};
  const stripe={checkout:{sessions:{list:async()=>({data:sessions,has_more:false})}}};
  const {handler}=await loadFunction('commerce-audit',{client,stripe,externalModules});
  const response=await handler(post({},{authorization:'Bearer local-oidc'}));
  return {response,client};
}
test('expired or open unpaid sessions can outlive deleted drafts without an alert',async()=>{
  for(const status of ['expired','open']){
    const {response}=await audit({sessions:[{...session,status,payment_status:'unpaid'}],orders:[]});
    assert.equal(response.status,200);assert.equal((await response.json()).healthy,true);
  }
});
test('a paid session whose order is genuinely missing still alerts',async()=>{
  const {response}=await audit({orders:[]});assert.equal(response.status,503);
});
test('a recent paid session can belong to an order older than the scan window',async()=>{
  const {response,client}=await audit({orders:[],older:[{...order,created_at:old}]});
  assert.equal(response.status,200);
  assert.ok(client.calls.some(q=>q.table==='orders'&&q.filters.some(f=>f[0]==='in')));
});
test('registered refunds remain reconciled with a paid Checkout session',async()=>{
  for(const payment_status of ['partially_refunded','refunded']){
    assert.equal((await audit({orders:[{...order,payment_status}]})).response.status,200);
  }
});
test('paid order with the wrong session or amount still alerts',async()=>{
  for(const changed of [{stripe_checkout_session_id:'cs_other'},{total_amount:1}]){
    assert.equal((await audit({orders:[{...order,...changed}]})).response.status,503);
  }
});
test('a successful zero-value payment is audited and an untrusted workflow is denied',async()=>{
  assert.equal((await audit({sessions:[{...session,payment_status:'no_payment_required',amount_total:0}],orders:[]})).response.status,503);
  const {response,client}=await audit({trusted:false});assert.equal(response.status,401);assert.equal(client.calls.length,0);
});
