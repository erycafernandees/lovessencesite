import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const config = window.LOVE_COMMERCE_CONFIG || {};
const feedback = document.getElementById('feedback');
const requestView = document.getElementById('request-view');
const passwordView = document.getElementById('password-view');
const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:true}});
let recovery = false;
const showPassword = () => { recovery = true; requestView.hidden = true; passwordView.hidden = false; feedback.textContent = ''; };
supabase.auth.onAuthStateChange((event) => { if (event === 'PASSWORD_RECOVERY') showPassword(); });
(async () => {
  try {
    const fragment = new URLSearchParams(location.hash.slice(1));
    if (fragment.get('type') === 'recovery' && fragment.get('access_token') && fragment.get('refresh_token')) {
      const {error} = await supabase.auth.setSession({access_token:fragment.get('access_token'),refresh_token:fragment.get('refresh_token')});
      if (error) throw error;
      showPassword();
    }
    if (new URLSearchParams(location.search).get('code')) {
      const {error} = await supabase.auth.exchangeCodeForSession(new URLSearchParams(location.search).get('code'));
      if (error) throw error;
      showPassword();
    }
  } catch(e) { feedback.textContent = 'O link expirou ou não é válido. Pede um novo link abaixo.'; }
  if (location.hash || location.search) history.replaceState(null,'',location.pathname);
})();
document.getElementById('request-form').addEventListener('submit',async e=>{
  e.preventDefault(); feedback.textContent = 'A enviar…';
  const email = new FormData(e.currentTarget).get('email');
  const {error} = await supabase.auth.resetPasswordForEmail(email,{redirectTo:location.origin+'/admin/repor-password/'});
  feedback.textContent = error ? 'Não foi possível enviar o link. Tenta novamente.' : 'Se existir uma conta com este email, receberás um link de recuperação.';
});
document.getElementById('password-form').addEventListener('submit',async e=>{
  e.preventDefault(); if(!recovery) return;
  const form = new FormData(e.currentTarget);
  if(form.get('password')!==form.get('confirm')) {feedback.textContent='As palavras-passe não coincidem.';return;}
  feedback.textContent='A guardar…';
  const {error} = await supabase.auth.updateUser({password:form.get('password')});
  if(error) {feedback.textContent='Não foi possível guardar. Pede um novo link se tiver expirado.';return;}
  await supabase.auth.signOut(); recovery=false;passwordView.hidden=true;feedback.textContent='Palavra-passe definida! Já podes entrar no painel.';
});