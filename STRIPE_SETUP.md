# Ativação do Stripe sem recriar produtos

Este projeto utiliza **Stripe Checkout com `price_data` dinâmico**. Não é necessário criar produtos ou preços na Dashboard da Stripe: o backend lê as variantes e os preços na base de dados Supabase, valida os totais e envia as linhas de pagamento à Stripe.

## Estado desta alteração
- O carrinho conserva o pedido por WhatsApp quando `LOVE_COMMERCE_CONFIG.enabled` está desligado.
- Quando o backend Supabase estiver configurado e `enabled: true`, o botão «Finalizar compra» encaminha as compras para `checkout-prepare` e `checkout-session`.
- Encomendas fora de Portugal Continental continuam no WhatsApp.
- **Esta alteração não ativa pagamentos reais** nem guarda chaves secretas no GitHub.
- O código de backend já existente precisa de ser implantado e testado antes da ativação.

## Checklist antes de ligar o checkout
1. Confirmar que a Stripe está devidamente verificada e que os métodos de pagamento pretendidos estão disponíveis.
2. Ligar um projeto Supabase. Aplicar `supabase/migrations/202608210001_commerce.sql` e `supabase/seed.sql`; validar os preços atuais antes de importar/atualizar o catálogo.
3. Implantar as Edge Functions de `supabase/functions/` com a configuração de `supabase/config.toml`. Configurar os segredos exclusivamente no Supabase (ver `supabase/functions/.env.example`), começando com `STRIPE_SECRET_KEY=sk_test_...`.
4. Criar webhook Stripe de teste para `https://<project-ref>.supabase.co/functions/v1/stripe-webhook` com os eventos documentados em `COMMERCE_ARCHITECTURE.md`; guardar `STRIPE_WEBHOOK_SECRET` nos segredos de função.
5. Definir `SITE_URL=https://love-essences.pt` e `ALLOWED_ORIGINS=https://love-essences.pt`, além dos outros segredos necessários.
6. Preencher **apenas** a URL e a chave pública/anon em `assets/js/commerce-config.js`; colocar `enabled: true` **só quando** a base de dados, funções e webhooks estiverem verificados.
7. Testar no ambiente de teste: seleção, quantidade, personalização, preço, portes, checkout concluído/cancelado, webhook, confirmação e email; testar também variantes inexistentes e carrinhos antigos.
8. Confirmar que o valor cobrado coincide com o preço do catálogo e que encomendas pagas não são registadas duas vezes.
9. Antes de passar a produção, substituir apenas segredos server-side pelas chaves reais, atualizar webhook e confirmar formalmente a ativação.

## Nota sobre segurança
Nunca colocar `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` ou `SUPABASE_SERVICE_ROLE_KEY` em HTML/JavaScript público. Não se deve mudar `enabled` para `true` antes dos testes: isso desvia o botão do WhatsApp e pode bloquear as encomendas.
