import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync('scripts/public-events.js','utf8');
function element(attrs={},dataset={}){
  const listeners={};
  return {nodeType:1,dataset,listeners,hasAttribute:k=>Object.hasOwn(attrs,k),getAttribute:k=>attrs[k]??null,
    addEventListener(name,fn){listeners[name]=fn},querySelectorAll(){return []}};
}
function fixture(nodes=[]){
  let mutations;const actions=[];const errors={};
  const document={nodeType:9,documentElement:{},querySelectorAll:()=>nodes,addEventListener:(name,fn)=>{errors[name]=fn}};
  const context={document,WeakMap,Set,Object,Number,MutationObserver:class{constructor(fn){mutations=fn}observe(){}},
    showPage:value=>actions.push(['page',value]),openShopCategory:value=>actions.push(['category',value]),
    selectSoapFlowerFragrance:value=>actions.push(['fragrance',value]),changeProductGallery:(...v)=>actions.push(['gallery',...v]),
    setProductGallerySlide:(...v)=>actions.push(['slide',...v]),updateCartLineQty:(...v)=>actions.push(['quantity',...v]),removeCartLine:value=>actions.push(['remove',value]),
    capture:(self,event)=>actions.push(['capture',self,event])};
  vm.runInNewContext(source.replace('__LOVE_EVENT_HANDLERS__',`{'static':{event:'click',handle:function(event){capture(this,event);return false;}}}`),context);
  return {actions,hydrate:node=>mutations([{addedNodes:[node]}]),resourceError:node=>errors.error({target:node})};
}
test('static actions preserve this, event and return-false navigation prevention',()=>{
  const node=element({'data-le-onclick':'static'});const f=fixture([node]);let prevented=false;
  const event={preventDefault(){prevented=true}};node.listeners.click(event);
  assert.deepEqual(f.actions,[['capture',node,event]]);assert.equal(prevented,true);
});
test('inserted and cloned cart controls bind once and preserve line index/delta',()=>{
  const f=fixture();const node=element({'data-le-onclick':'cart-quantity'},{leIndex:'2',leDelta:'-1'});
  f.hydrate(node);const callback=node.listeners.click;f.hydrate(node);assert.equal(node.listeners.click,callback);
  callback({});assert.deepEqual(f.actions,[['quantity',2,-1]]);
});
test('unknown identifiers and code-looking indices cannot execute arbitrary code',()=>{
  const nodes=[element({'data-le-onclick':'constructor'}),element({'data-le-onclick':'this.dataset.pwned=1'}),element({'data-le-onclick':'cart-remove'},{leIndex:'1; alert(1)'})];
  const f=fixture(nodes);nodes.forEach(n=>n.listeners.click({}));assert.equal(f.actions.length,0);
});
test('dynamic fragrance, category and gallery actions keep their data separate from code',()=>{
  const nodes=[element({'data-le-onclick':'soap-fragrance'},{fragrance:'Cashmere'}),element({'data-le-onclick':'gallery-slide'},{leIndex:'1'}),element({'data-le-onclick':'shop-category'},{leCategory:'natal'})];
  const f=fixture(nodes);nodes.forEach(n=>n.listeners.click({preventDefault(){}}));
  assert.deepEqual(f.actions,[['fragrance','Cashmere'],['slide',1,true],['category','natal']]);
});
test('resource errors remove only the failed gallery slide without an inline handler',()=>{
  const image=element({'data-le-onerror':'gallery-image-error'});let removed=false;image.closest=()=>({remove(){removed=true}});
  const f=fixture();f.resourceError(image);assert.equal(removed,true);
});
