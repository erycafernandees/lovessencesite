import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database,loadFunction } from './security-harness.mjs';
test('empty or truncated PNG signatures cannot be accepted as uploaded photos',async()=>{
  const {core}=await loadFunction('attachment-confirm',{client:database(()=>({}))});
  const png=new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  for(let n=0;n<8;n++) assert.equal(core.hasValidMagic(png.slice(0,n),'image/png'),false,'length '+n);
  assert.equal(core.hasValidMagic(png,'image/png'),true);
  assert.equal(core.hasValidMagic(new TextEncoder().encode('<svg onload=alert(1)>'),'image/png'),false);
  assert.equal(core.hasValidMagic(new Uint8Array([0xff,0xd8]),'image/jpeg'),false);
  assert.equal(core.hasValidMagic(new TextEncoder().encode('%PDF'),'application/pdf'),false);
  assert.equal(core.hasValidMagic(new TextEncoder().encode('%PDF-'),'application/pdf'),true);
});
