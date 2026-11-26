import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database,loadFunction,post } from './security-harness.mjs';
test('atomic rate limit denial returns 429 before cart lookup or order creation',async()=>{
  const client=database(()=>{throw new Error('Limited request must not query tables')});
  client.rpc=async(name)=>{assert.equal(name,'consume_api_rate_limit');return {data:false}};
  const {handler}=await loadFunction('checkout-prepare',{client});
  assert.equal((await handler(post({items:[]}))).status,429);
  assert.equal(client.calls.length,0);
});
test('streamed body cap works without a Content-Length header',async()=>{
  const {core}=await loadFunction('attachment-confirm',{client:database(()=>({}))});
  const request=new Request('https://test.invalid',{method:'POST',body:'a'.repeat(17)});
  await assert.rejects(core.readBodyText(request,16),error=>error.status===413);
});
test('valid JSON remains accepted inside the body cap',async()=>{
  const {core}=await loadFunction('attachment-confirm',{client:database(()=>({}))});
  assert.equal((await core.readJson(post({message:'ação'}))).message,'ação');
});
test('forwarded-for spoofing cannot rotate missing trusted ingress identity',async()=>{
  const hashes=[];const client=database(()=>({}));
  client.rpc=async(name,args)=>{hashes.push(args.p_client_hash);return {data:true}};
  const {core}=await loadFunction('attachment-confirm',{client});
  for(const address of ['192.0.2.1','192.0.2.2'])await core.enforceRateLimit(post({}, {'x-forwarded-for':address}),'test',3,60);
  assert.equal(hashes[0],hashes[1]);
});
test('AfterShip webhook caps streamed request before signature parsing',async()=>{
  const {handler}=await loadFunction('aftership-ctt-webhook',{client:database(()=>{throw new Error('No database access allowed')}),env:{AFTERSHIP_WEBHOOK_SECRET:'test-only'}});
  assert.equal((await handler(new Request('https://test.invalid',{method:'POST',body:'x'.repeat(200001)}))).status,413);
  assert.equal((await handler(new Request('https://test.invalid',{method:'POST',body:'{}'}))).status,401);
});
test('public tracking limits requests before lookup or carrier calls',async()=>{
  const client=database(()=>{throw new Error('No lookup for a limited request')});
  client.rpc=async()=>({data:false});
  const {handler}=await loadFunction('public-ctt-tracking',{client});
  assert.equal((await handler(post({code:'AA000000000PT'}))).status,429);
});
