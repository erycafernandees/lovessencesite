import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { database, loadFunction, post } from './security-harness.mjs';
const token='local-owner', hash=createHash('sha256').update(token).digest('hex');
for (const mode of ['open','expired','mismatch','wrong-token']) {
  test(`quote checkout ${mode}: reservation and provider ownership enforced`, async () => {
    const quote={id:'quote',status:'approved',access_token_hash:hash,access_token_expires_at:'2099-01-01'};
    const client=database(()=>({data:quote})); const calls=[];
    client.rpc=async(name,args)=>{calls.push(name);return {data:{order:{id:'order',stripe_checkout_session_id:'cs_existing'},quote:{...quote,project_requests:{}}}}};
    let creates=0;
    const stripe={checkout:{sessions:{retrieve:async()=>({status:mode==='expired'?'expired':'open',url:'https://checkout.stripe.com/test',metadata:{order_id:mode==='mismatch'?'other':'order'}}),create:async()=>{creates++;throw new Error('Existing session must not be recreated')}}}};
    const {handler}=await loadFunction('quote-checkout',{client,stripe});
    const response=await handler(post({quoteId:'quote',quoteToken:mode==='wrong-token'?'wrong':token,approve:true}));
    assert.equal(response.status,mode==='open'?200:mode==='expired'?410:mode==='wrong-token'?403:409);
    assert.equal(creates,0);
    assert.equal(calls.length,mode==='wrong-token'?0:1);
  });
}
