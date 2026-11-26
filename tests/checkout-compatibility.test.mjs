import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { database, loadFunction, post } from './security-harness.mjs';

const token='local-owner';
export const fixtureOrder={
  id:'00000000-0000-4000-8000-000000000825',order_number:'SECURITY-SANDBOX-825',
  access_token_hash:createHash('sha256').update(token).digest('hex'),access_token_expires_at:'2099-01-01',
  source:'catalog',currency:'eur',subtotal_amount:1290,discount_amount:0,shipping_amount:590,total_amount:1880,
  payment_status:'unpaid',payment_provider:'stripe',order_status:'awaiting_payment',attachments:[],
  order_items:[{id:'00000000-0000-4000-8000-000000000826',name:'Rumo ao Natal',quantity:1,line_amount:1290,product_code:'natal_carrinha_pinheiro',variant_code:'natal_carrinha_pinheiro:default',product_snapshot:{},personalization:{fragrance:'Cashmere'}}],
};
export async function captureCheckout({promoCode,claimed=true,origin,env={}}={}) {
  let payload;
  const client=database(q=>({data:q.operation==='select'?structuredClone(fixtureOrder):null}));
  client.rpc=async(name)=>({data:name==='claim_test_checkout_code'?claimed:true});
  const stripe={checkout:{sessions:{create:async body=>{payload=body;return {id:'cs_local',url:'https://checkout.stripe.com/local',metadata:body.metadata}}}}};
  const {handler,core}=await loadFunction('checkout-session',{client,stripe,env});
  const response=await handler(post({orderId:fixtureOrder.id,orderToken:token,promoCode},origin?{origin}:{}));
  return {response,payload,client,core};
}
test('normal checkout preserves server prices and promotion codes',async()=>{
  const {response,payload,client}=await captureCheckout();
  assert.equal(response.status,200);
  assert.equal(payload.line_items.reduce((n,l)=>n+l.price_data.unit_amount*l.quantity,0),1880);
  assert.equal(payload.allow_promotion_codes,true);
  assert.equal(client.calls.filter(q=>q.operation==='update').length,0);
});
test('legacy one-use checkout code preserves 100-cent payment and stored discount',async()=>{
  const {response,payload,client}=await captureCheckout({promoCode:' testelove1 '});
  assert.equal(response.status,200);assert.equal(payload.line_items.length,1);
  assert.equal(payload.line_items[0].price_data.unit_amount,100);assert.equal(payload.allow_promotion_codes,false);
  const update=client.calls.find(q=>q.operation==='update').values;
  assert.equal(update.total_amount,100);assert.equal(update.discount_amount,1780);assert.equal(update.is_test,true);
});
test('claimed code and arbitrary code cannot create a checkout',async()=>{
  for(const options of [{promoCode:'TESTELOVE1',claimed:false},{promoCode:'inventado'}]) {
    const {response,payload}=await captureCheckout(options);
    assert.equal(response.status,options.claimed===false?409:422);assert.equal(payload,undefined);
  }
});
test('redirects use configured site or the existing preview, never arbitrary Origin',async()=>{
  for(const [origin,expected] of [['https://attacker.invalid','https://love-essences.pt'],['https://love-essences-teste.pages.dev','https://love-essences-teste.pages.dev']]) {
    const {payload}=await captureCheckout({origin});assert.ok(payload.success_url.startsWith(expected+'/'));
  }
  const {payload}=await captureCheckout({env:{SITE_URL:'http://127.0.0.1:4173'}});
  assert.ok(payload.success_url.startsWith('http://127.0.0.1:4173/'));
});
