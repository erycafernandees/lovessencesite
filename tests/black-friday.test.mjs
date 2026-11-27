import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,loadFunction,post} from './security-harness.mjs';

for (const [time, expected] of [['2026-11-27T23:59:59Z', 1842], ['2026-11-28T00:00:00Z', 2190]]) {
  test('mixed cart at '+time, async () => {
    const products = [['natal_vila_encantada',1190,''],['mini_difusor',410,'adult_event']];
    const variants = products.map(([code,unit_amount,group])=>({id:code,code,unit_amount,minimum_quantity:1,
      products:{id:code,code,name:code,active:true,metadata:{discount_group:group}}}));
    const client=database(q=>{
      if(q.table==='product_variants')return {data:variants};
      if(q.table==='orders')return {data:{id:'order',total_amount:q.values.total_amount}};
      if(q.table==='order_items')return {data:variants};
      return {count:0};
    });
    const {handler}=await loadFunction('checkout-prepare',{client,transform:(s,p)=>p.endsWith('checkout-prepare/index.ts')?s.replace('const now = Date.now()', 'const now = '+Date.parse(time)):s});
    const response=await handler(post({items:variants.map(v=>({lineKey:v.code,productCode:v.code,variantCode:v.code,quantity:1}))}));
    assert.equal(response.status,200);
    const order=client.calls.find(q=>q.table==='orders').values;
    assert.equal(order.shipping_amount,590);
    assert.equal(order.total_amount,expected);
  });
}

test('Stripe receives a discount on the eligible line only and rejects expired drafts', async () => {
  const {createHash}=await import('node:crypto');
  const order={id:'order',order_number:'BF-test',source:'catalog',currency:'eur',
    access_token_hash:createHash('sha256').update('owner').digest('hex'),access_token_expires_at:'2099-01-01',
    payment_status:'unpaid',payment_provider:'stripe',order_status:'draft',subtotal_amount:1600,
    discount_amount:348,shipping_amount:590,total_amount:1842,promotion_snapshot:{code:'black-friday-2026',campaignSaving:348},
    attachments:[],order_items:[
      {id:'eligible',name:'Vila Encantada',product_code:'natal_vila_encantada',quantity:1,line_amount:1190,product_snapshot:{blackFridaySaving:348}},
      {id:'excluded',name:'Mini Difusor',product_code:'mini_difusor',quantity:1,line_amount:410,product_snapshot:{}}
    ]};
  for(const [time,status] of [['2026-11-27T10:00:00Z',200],['2026-11-28T00:00:00Z',410]]){
    const client=database(()=>({data:order}));client.rpc=async()=>({data:true});
    let payload;
    const stripe={checkout:{sessions:{create:async body=>{payload=body;return {id:'cs_test',url:'https://example.invalid',metadata:body.metadata};}}}};
    const {handler}=await loadFunction('checkout-session',{client,stripe,transform:(s,p)=>p.endsWith('checkout-session/index.ts')?s.replaceAll('Date.now()',String(Date.parse(time))):s});
    const response=await handler(post({orderId:'order',orderToken:'owner'}));
    assert.equal(response.status,status);
    if(status===200){
      assert.deepEqual(Array.from(payload.line_items,l=>l.price_data.unit_amount),[842,410,590]);
      assert.equal(payload.allow_promotion_codes,false);
    }else assert.equal(payload,undefined);
  }
});
