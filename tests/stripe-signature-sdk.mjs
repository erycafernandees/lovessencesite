import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { database,loadFunction } from './security-harness.mjs';
if(!process.env.SECURITY_TEST_TOOLS) throw new Error('Set SECURITY_TEST_TOOLS');
const {default:Stripe}=await import(pathToFileURL(resolve(process.env.SECURITY_TEST_TOOLS,'node_modules/stripe/esm/stripe.esm.node.js')));
const secret='local-fixture-signature-secret';
const payload=JSON.stringify({id:'evt_local_signature',type:'ignored.local_fixture',livemode:false,data:{object:{id:'fixture'}}});
let passed=0;
for(const mode of ['valid','tampered','wrong-secret','expired']){
  const client=database(()=>({data:null}));
  const {handler}=await loadFunction('stripe-webhook',{client,StripeSDK:Stripe,env:{STRIPE_WEBHOOK_SECRET:secret}});
  const signature=Stripe.webhooks.generateTestHeaderString({payload,secret:mode==='wrong-secret'?'other-fixture-secret':secret,timestamp:mode==='expired'?Math.floor(Date.now()/1000)-3600:Math.floor(Date.now()/1000)});
  const response=await handler(new Request('https://test.invalid',{method:'POST',headers:{'stripe-signature':signature},body:mode==='tampered'?payload+' ':payload}));
  assert.equal(response.status,mode==='valid'?200:400,mode);
  if(mode!=='valid') assert.equal(client.calls.length,0,'Invalid signature reached database');
  passed++;console.log('PASS real Stripe SDK signature '+mode);
}
console.log('STRIPE_SIGNATURE_SDK_PASSED='+passed);
