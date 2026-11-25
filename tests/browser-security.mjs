import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require((process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES||'')+'/playwright');
const browser=await chromium.launch({headless:true,executablePath:process.env.SECURITY_CHROMIUM || '/usr/bin/chromium',args:['--no-sandbox']});
let passed=0;
try {
  const context=await browser.newContext();
  // Test only local generated files. Block telemetry, Supabase, Stripe and CDNs.
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const page=await context.newPage();
  for (const path of ['/','/admin/','/projeto/orcamento/','/avaliar/']) {
    await page.goto('http://127.0.0.1:4176'+path,{waitUntil:'load'});
    assert.equal(await page.locator('meta[http-equiv="Content-Security-Policy"]').count(),1,path);
    assert.equal(await page.locator('meta[name="referrer"]').getAttribute('content'),'no-referrer');
    passed++;console.log('PASS generated policy and referrer '+path);
  }
  await page.goto('http://127.0.0.1:4176/admin/',{waitUntil:'load'});
  await page.evaluate(()=>{
    window.__inlineInjectionExecuted=false;
    const script=document.createElement('script');script.textContent='window.__inlineInjectionExecuted=true';document.body.append(script);
  });
  assert.equal(await page.evaluate(()=>window.__inlineInjectionExecuted),false);
  passed++;console.log('PASS admin CSP blocks injected inline script');
  await page.goto('http://127.0.0.1:4176/',{waitUntil:'load'});
  await page.waitForFunction(()=>typeof window.openProduct==='function');
  const before=await page.locator('.product-name a').count();assert.ok(before>0);
  await page.locator('.product-name a').first().click();
  assert.ok(await page.evaluate(()=>!!window.currentProduct));
  passed++;console.log('PASS catalog product interaction survives browser policy');
  console.log('BROWSER_SECURITY_PASSED='+passed);
} finally { await browser.close(); }
