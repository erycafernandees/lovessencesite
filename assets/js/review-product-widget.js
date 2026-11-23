/* Avaliações aprovadas nas páginas de produto e na homepage. */
(() => {
const cfg=window.LOVE_COMMERCE_CONFIG||{};
if(!cfg.supabaseUrl||!cfg.supabaseAnonKey)return;
const clean=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
let reviews=[];
const style=document.createElement('style');style.textContent='.le-reviews-section{margin:2.5rem auto;padding:2rem max(5vw,20px);max-width:1250px;color:#511449}.le-reviews-section h2{font:400 clamp(1.65rem,3.3vw,2.5rem) Georgia,serif;margin:0 0 1.4rem;text-align:center}.le-reviews-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:1rem}.le-review-card{border:1px solid #eadce7;border-radius:14px;background:#fff;padding:1.2rem}.le-review-card img{width:100%;height:165px;object-fit:cover;border-radius:9px;margin:0 0 .8rem}.le-review-card .stars{color:#c69a38;font-size:1.2rem}.le-review-card p{line-height:1.5;font-size:.9rem;white-space:pre-wrap;overflow-wrap:anywhere}.le-review-card small{color:#796978}.le-reviews-more{display:block;text-align:center;color:#66135e;margin:1.1rem 0;text-decoration:underline}#le-reviews-product{max-width:800px;margin:2.2rem auto;padding:1rem 20px 1.5rem}#le-reviews-product h2{font:400 clamp(1.5rem,2.5vw,2rem) Georgia,serif;margin:0 0 1.3rem}#le-reviews-product .le-reviews-grid{max-width:680px;margin:auto;grid-template-columns:minmax(0,1fr)}#le-reviews-product .le-review-card{display:flex;align-items:center;gap:18px;padding:16px 18px}#le-reviews-product .le-review-card img{width:112px;height:112px;flex:0 0 112px;object-fit:cover;margin:0;border-radius:9px}#le-reviews-product .le-review-content{flex:1;min-width:0}#le-reviews-product .le-review-card p{margin:.35rem 0;font-size:.85rem}#le-reviews-product .le-review-card small{display:block;font-size:.75rem;margin-top:.35rem}#le-reviews-product .le-reviews-more{font-size:.82rem;margin:1rem 0 0}@media(max-width:480px){#le-reviews-product{margin:1.5rem auto;padding:1rem 15px}#le-reviews-product .le-review-card{gap:12px;padding:12px}#le-reviews-product .le-review-card img{width:84px;height:84px;flex-basis:84px}}';document.head.appendChild(style);
function safeImage(url){try{const u=new URL(url);return u.protocol==='https:'&&['love-essences.pt','www.love-essences.pt'].includes(u.hostname)}catch{return false}}
function media(r){const u=r.photo_path&&r.publish_photo?cfg.supabaseUrl+'/storage/v1/object/public/customer-review-photos/'+encodeURIComponent(r.photo_path):r.review_invitations?.product_image_url;return u&&(r.photo_path&&r.publish_photo||safeImage(u))?u:null}
function card(r){const img=media(r);return '<article class="le-review-card">'+(img?'<img loading="lazy" src="'+clean(img)+'" alt="Encomenda '+clean(r.review_invitations?.product_name)+'">':'')+'<div class="le-review-content"><div class="stars">'+('★'.repeat(Math.min(5,r.product_rating)))+'</div>'+(r.comment?'<p>'+clean(r.comment)+'</p>':'')+'<small>'+clean(r.public_name)+' · '+clean(r.review_invitations?.product_name)+'</small></div></article>'}
function panel(id,title,entries){let section=document.getElementById(id);if(!entries.length){if(section)section.remove();return}if(!section){section=document.createElement('section');section.id=id;section.className='le-reviews-section';if(id==='le-reviews-product')document.querySelector('#page-product')?.appendChild(section);else document.querySelector('#page-home')?.appendChild(section)}section.innerHTML='<h2>'+title+'</h2><div class="le-reviews-grid">'+entries.map(card).join('')+'</div><a class="le-reviews-more" href="/avaliacoes/">Ver todas as avaliações</a>'}
function renderHome(entries){
 const home=document.querySelector('#page-home .feedback-list');
 if(!home)return;
 home.querySelectorAll('[data-live-review]').forEach(el=>el.remove());
 const existing=new Set([...home.querySelectorAll('.feedback-card')].map(el=>norm(el.querySelector('.feedback-author strong')?.textContent)));
 for(const review of entries){
   if(existing.has(norm(review.public_name)))continue;
   const article=document.createElement('article');
   article.className='feedback-card';
   article.dataset.liveReview=review.id;
   const initials=String(review.public_name||'Cliente').split(/\s+/).slice(0,2).map(w=>w[0]||'').join('').toUpperCase();
   article.innerHTML='<div class="feedback-stars">'+('★'.repeat(Math.min(5,review.product_rating)))+'</div>'+
     (review.comment?'<p>"'+clean(review.comment)+'"</p>':'')+
     '<div class="feedback-author"><div class="testi-avatar">'+clean(initials)+'</div><div><strong>'+clean(review.public_name)+'</strong><span>Love Essences</span></div></div>';
   home.appendChild(article);
 }
}
function update(){const name=document.querySelector('#pd-name')?.textContent||'';if(name)panel('le-reviews-product','O que dizem sobre esta peça ♡',reviews.filter(r=>norm(r.review_invitations?.product_name)===norm(name)).slice(0,4));renderHome(reviews.slice(0,12))}
async function init(){try{const response=await fetch(cfg.supabaseUrl+'/functions/v1/customer-reviews',{method:'POST',headers:{'Content-Type':'application/json',apikey:cfg.supabaseAnonKey},body:JSON.stringify({action:'published'})});if(!response.ok)return;const d=await response.json();reviews=Array.isArray(d.data)?d.data:[];update();const heading=document.querySelector('#pd-name');if(heading)new MutationObserver(update).observe(heading,{childList:true,characterData:true,subtree:true})}catch(e){/* A loja continua funcional sem avaliações. */}}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();