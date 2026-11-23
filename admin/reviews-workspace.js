// As avaliações reutilizam a estrutura e o drawer nativos do CRM.
export function setupReviews({supabase,config,openDrawer,closeDrawer}) {
  const byId=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[char]));
  const statuses={awaiting:'A aguardar',pending:'Por aprovar',published:'Publicada',rejected:'Rejeitada'};
  const channels={website:'Site',instagram:'Instagram',whatsapp:'WhatsApp',other:'Outro'};
  let rows=[],creating=false,products=[];
  async function api(action,extra={}) {
    const {data:{session}}=await supabase.auth.getSession();
    if(!session) throw Error('A sessão terminou. Volta a entrar no CRM.');
    const res=await fetch(config.supabaseUrl+'/functions/v1/customer-reviews',{
      method:'POST',headers:{'Content-Type':'application/json',apikey:config.supabaseAnonKey,Authorization:'Bearer '+session.access_token},
      body:JSON.stringify({action,...extra})
    });
    const json=await res.json().catch(()=>({}));
    if(!res.ok)throw Error(json.message||'Não foi possível concluir a operação.');
    return json;
  }
  async function loadCatalog(){
    const response=await api('catalog');
    products=Array.isArray(response.data)?response.data:[];
  }
  function productSelect(selectedName=''){
    const selected=products.find(p=>p.name===selectedName)?.code||'';
    return '<label>Artigo Love Essences (opcional — podes associar depois)<select name="productCode">'+
      '<option value="">Selecionar mais tarde / Personalizado</option>'+
      products.map(p=>'<option value="'+esc(p.code)+'"'+(p.code===selected?' selected':'')+'>'+esc(p.name)+' · '+esc(p.category)+'</option>').join('')+
      '</select></label>';
  }
  function reviewOf(row) {
    const value=row.customer_reviews;
    return Array.isArray(value)?value[0]:value||null;
  }
  function statusOf(row){return reviewOf(row)?.status||'awaiting'}
  function badge(status){return '<span class="badge review-'+esc(status)+'">'+esc(statuses[status]||status)+'</span>'}
  function date(value){return value?new Intl.DateTimeFormat('pt-PT',{dateStyle:'short',timeStyle:'short'}).format(new Date(value)):'—'}
  function rating(value){return value?'<span class="reviews-stars" aria-label="'+value+' em 5 estrelas">'+('★'.repeat(Math.min(5,value)))+'</span>':'—'}
  function getFiltered() {
    const search=byId('reviews-search').value.trim().toLocaleLowerCase('pt-PT');
    const status=byId('reviews-status').value,channel=byId('reviews-channel').value;
    return rows.filter(r=>(status==='all'||statusOf(r)===status)&&(channel==='all'||r.channel===channel)&&(!search||[r.customer_name,r.product_name,r.channel,reviewOf(r)?.public_name].some(x=>String(x||'').toLocaleLowerCase('pt-PT').includes(search))));
  }
  function render() {
    const entries=getFiltered();
    byId('reviews-count').textContent=entries.length+' resultados';
    byId('reviews-body').innerHTML=entries.length?entries.map(r=>{
      const v=reviewOf(r);
      return '<tr data-review-row="'+esc(r.id)+'" tabindex="0" role="button" aria-label="Ver avaliação de '+esc(r.customer_name)+'">'+
        '<td><strong>'+esc(r.customer_name)+'</strong></td><td>'+esc(r.product_name||'Por associar')+'</td>'+
        '<td>'+esc(channels[r.channel]||r.channel)+'</td><td>'+rating(v?.product_rating)+'</td>'+
        '<td>'+rating(v?.experience_rating)+'</td><td>'+badge(statusOf(r))+'</td>'+
        '<td>'+date(v?.created_at||r.created_at)+'</td></tr>';
    }).join(''):'<tr><td colspan="7" class="empty">Não há avaliações para estes filtros.</td></tr>';
    byId('reviews-body').querySelectorAll('[data-review-row]').forEach(tr=>{
      const open=()=>showDetails(rows.find(r=>r.id===tr.dataset.reviewRow));
      tr.addEventListener('click',open);
      tr.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}});
    });
  }
  function summary(){
    const count=status=>rows.filter(r=>statusOf(r)===status).length;
    const cards=[
      ['Por aprovar',count('pending'),'Aguardam a tua decisão'],
      ['Publicadas',count('published'),'Visíveis no site'],
      ['A aguardar',count('awaiting'),'Convites ainda sem resposta'],
      ['Rejeitadas',count('rejected'),'Não visíveis no site']
    ];
    byId('reviews-summary').innerHTML=cards.map(([title,total,subtitle])=>'<div class="summary-card"><span>'+title+'</span><strong>'+total+'</strong><small class="summary-card-note">'+subtitle+'</small></div>').join('');
  }
  async function load() {
    byId('reviews-body').innerHTML='<tr><td colspan="7">A carregar…</td></tr>';
    try {
      const [res]=await Promise.all([api('list'),loadCatalog()]);rows=Array.isArray(res.data)?res.data:[];
      summary();render();
    }catch(err){byId('reviews-body').innerHTML='<tr><td colspan="7" class="error">'+esc(err.message)+'</td></tr>';byId('reviews-count').textContent='';}
  }
  async function moderate(reviewId,status,button){
    if(button)button.disabled=true;
    try {
      await api('moderate',{reviewId,status});
      closeDrawer();
      await load();
    }catch(e){const error=byId('reviews-drawer-error');if(error)error.textContent=e.message;else alert(e.message);if(button)button.disabled=false;}
  }
  function showDetails(row) {
    if(!row)return;
    const v=reviewOf(row),status=statusOf(row);
    const photo=v?.photo_path&&v.publish_photo?config.supabaseUrl+'/storage/v1/object/public/customer-review-photos/'+encodeURIComponent(v.photo_path):null;
    const content='<p class="eyebrow">Avaliações</p><h2>'+esc(row.customer_name)+'</h2>'+
      '<div class="detail-section"><h3>Convite</h3><div class="detail-grid"><p><strong>Artigo</strong>'+esc(row.product_name||'Por associar')+'</p><p><strong>Canal</strong>'+esc(channels[row.channel]||row.channel)+'</p><p><strong>Data</strong>'+date(row.created_at)+'</p><p><strong>Estado</strong>'+badge(status)+'</p></div></div>'+
      (v?'<div class="detail-section"><h3>Opinião da cliente</h3><div class="detail-grid"><p><strong>Produto</strong>'+rating(v.product_rating)+'</p><p><strong>Experiência</strong>'+rating(v.experience_rating)+'</p></div><p><strong>Nome público</strong>'+esc(v.public_name)+'</p><p class="reviews-comment">'+esc(v.comment)+'</p>'+
      (photo?'<img class="reviews-preview" alt="Fotografia enviada pela cliente" src="'+esc(photo)+'">':'')+
      (v.photo_path&&!v.publish_photo?'<p class="reviews-hint">A cliente não autorizou a publicação da fotografia.</p>':'')+
      '<p class="reviews-hint">Os comentários são publicados sem alterações ao seu conteúdo.</p>'+
      '<div class="reviews-actions"><button data-review-status="published" type="button">Aprovar</button><button class="secondary" data-review-status="rejected" type="button">Rejeitar / Retirar</button><button class="secondary" data-review-status="pending" type="button">Marcar pendente</button></div><p class="error" id="reviews-drawer-error" role="alert"></p></div>':
      '<div class="detail-section"><h3>A aguardar avaliação</h3><p>A cliente ainda não respondeu ao convite. Os links de convite são apresentados no momento da criação por segurança.</p></div>');
    const association='<div class="detail-section"><h3>Associar artigo Love Essences</h3>'+
      '<p class="reviews-hint">Podes enviar o convite primeiro e associar o artigo depois. É necessário associá-lo antes de publicar a avaliação.</p>'+
      '<form id="reviews-associate-form" class="reviews-create-form">'+
      productSelect(row.product_name||'')+
      '<button type="submit">Guardar associação</button><p class="error" id="reviews-associate-error"></p></form></div>';
    openDrawer(content+association);
    byId('reviews-associate-form').addEventListener('submit',async event=>{
      event.preventDefault();
      const form=event.currentTarget,button=form.querySelector('button[type=submit]');
      button.disabled=true;byId('reviews-associate-error').textContent='';
      try{
        await api('associate',{invitationId:row.id,...Object.fromEntries(new FormData(form))});
        await load();
        showDetails(rows.find(item=>item.id===row.id));
      }catch(error){byId('reviews-associate-error').textContent=error.message;button.disabled=false}
    });
    document.querySelectorAll('#drawer-content [data-review-status]').forEach(button=>button.addEventListener('click',()=>moderate(v.id,button.dataset.reviewStatus,button)));
  }
  function showCreate() {
    if(creating)return;
    creating=true;
    const content='<p class="eyebrow">Avaliações</p><h2>Criar link de avaliação</h2><p class="reviews-hint">Envia por Instagram, WhatsApp ou outro canal, mesmo para encomendas não realizadas no site.</p>'+
      '<form id="reviews-create-form" class="reviews-create-form">'+
      '<label>Nome da cliente<input name="customerName" maxlength="100" required placeholder="Ex.: Catarina"></label>'+
      productSelect()+
      '<label>Canal<select name="channel"><option value="instagram">Instagram</option><option value="whatsapp">WhatsApp</option><option value="website">Site</option><option value="other">Outro</option></select></label>'+
      '<p class="reviews-hint">Podes enviar o convite só com o nome da cliente e o canal. Mais tarde, associa o artigo na avaliação antes de a publicares.</p>'+
      '<button type="submit">Criar link</button><p class="error" id="reviews-create-error" role="alert"></p></form><div id="reviews-created-link" hidden></div>';
    openDrawer(content);creating=false;
    byId('reviews-create-form').addEventListener('submit',async e=>{
      e.preventDefault();const form=e.currentTarget,button=form.querySelector('button[type=submit]');
      button.disabled=true;byId('reviews-create-error').textContent='';
      try {
        const response=await api('create',Object.fromEntries(new FormData(form)));
        const box=byId('reviews-created-link');
        box.hidden=false;
        box.innerHTML='<div class="detail-section"><h3>Link criado 💜</h3><p class="reviews-hint">Copia e envia diretamente à cliente. Este link dá acesso apenas ao formulário dela.</p><p class="reviews-link">'+esc(response.url)+'</p><button type="button" id="reviews-copy-link">Copiar link</button></div>';
        byId('reviews-copy-link').onclick=async()=>{try{await navigator.clipboard.writeText(response.url);byId('reviews-copy-link').textContent='Copiado!'}catch{window.prompt('Copia o link:',response.url)}};
        form.hidden=true;await load();
      }catch(err){byId('reviews-create-error').textContent=err.message;button.disabled=false}
    });
  }
  byId('reviews-new-link').addEventListener('click',showCreate);
  byId('reviews-refresh').addEventListener('click',load);
  for(const id of ['reviews-search','reviews-status','reviews-channel'])
    byId(id).addEventListener(id==='reviews-search'?'input':'change',render);
  return {load};
}
