import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database, loadFunction, post } from './security-harness.mjs';
test('public project submission ignores privileged fields and stores SQL-looking text as a value', async () => {
  const client=database(q=>({data:q.table==='project_requests'?{id:'project',project_number:'LOCAL-1'}:{id:'notification'},count:0}));
  const {handler}=await loadFunction('project-submit',{client});
  const name="Name'; update orders set payment_status='paid'; --";
  const response=await handler(post({name,phone:'123456789',occasion:'Empresa',projectType:'Velas',idea:'Local fixture',privacyAccepted:true,role:'owner',isAdmin:true,status:'paid',payment_status:'paid',total_amount:1,access_token_hash:'attacker'}));
  assert.equal(response.status,200);
  const values=client.calls.find(q=>q.table==='project_requests'&&q.operation==='insert').values;
  assert.equal(values.customer_name,name);
  for (const key of ['role','isAdmin','status','payment_status','total_amount']) assert.equal(Object.hasOwn(values,key),false,key);
  assert.notEqual(values.access_token_hash,'attacker');
});
for (const approve of ['true',1,{},false]) {
  test(`quote approval requires literal true, rejects ${JSON.stringify(approve)}`, async () => {
    const client=database(()=>{throw new Error('Invalid approval must not access database')});
    const {handler}=await loadFunction('quote-checkout',{client});
    assert.equal((await handler(post({approve}))).status,422);
    assert.equal(client.calls.length,0);
  });
}
