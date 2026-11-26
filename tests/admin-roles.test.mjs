import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database, loadFunction, post } from './security-harness.mjs';
const jwt='test.'+Buffer.from(JSON.stringify({aal:'aal2'})).toString('base64url')+'.test';
for (const action of ['update-order','update-project','set-delivery','resolve-checkout-error','mark-seen','set-project-payment','create-quote']) {
  test(`viewer cannot perform ${action}`,async()=>{
    const client=database(q=>{
      assert.equal(q.table,'admin_users','viewer must not reach business tables');
      return {data:{active:true,role:'viewer'}};
    });
    client.auth={getUser:async()=>({data:{user:{id:'viewer-user'}}})};
    const {handler}=await loadFunction('admin-api',{client});
    assert.equal((await handler(post({action,id:'order',orderStatus:'confirmed',status:'paid'},{authorization:'Bearer '+jwt}))).status,403);
    assert.equal(client.calls.some(q=>q.operation!=='select'),false);
  });
}
test('viewer can still list orders',async()=>{
  const client=database(q=>q.table==='admin_users'?{data:{active:true,role:'viewer'}}:{data:[],count:0});
  client.auth={getUser:async()=>({data:{user:{id:'viewer-user'}}})};
  const {handler}=await loadFunction('admin-api',{client});
  assert.equal((await handler(post({action:'list-orders'},{authorization:'Bearer '+jwt}))).status,200);
});
for(const name of ['admin-email-test','aftership-ctt-sync']) {
  for(const [role,aal,status] of [['viewer','aal2',403],['owner','aal1',403],['owner','aal2',503]]) {
    test(`${name}: ${role}/${aal} follows admin permission and MFA checks`,async()=>{
      const client=database(q=>{assert.equal(q.table,'admin_users');return {data:{active:true,role}}});
      client.auth={getUser:async()=>({data:{user:{id:'local-admin'}}})};
      const token='test.'+Buffer.from(JSON.stringify({aal})).toString('base64url')+'.test';
      const {handler}=await loadFunction(name,{client});
      const response=await handler(post({},{authorization:'Bearer '+token}));
      // An authorized request reaches missing provider configuration, without
      // ever sending email or contacting the carrier in this test.
      assert.equal(response.status,name==='admin-email-test'&&status===503?500:status);
    });
  }
  test(`${name}: anonymous request cannot reach provider`,async()=>{
    const client=database(()=>{throw new Error('Must not query without authentication')});
    const {handler}=await loadFunction(name,{client});
    assert.equal((await handler(post({}))).status,401);
  });
}
