# Ativar Stripe sem introduzir produtos na Stripe — Love Essences

O catálogo continua na base de dados Supabase (ficheiros `supabase/seed.sql` e tabelas `products`, `product_variants`, `product_addons`). Na Edge Function `checkout-session`, cada artigo é enviado à Stripe Checkout usando `price_data` e `product_data` com o preço validado no servidor. **Não é necessário criar manualmente produtos nem preços na Dashboard Stripe.**

## Estado atual
- O código de checkout e webhook já existe no repositório, mas **não está ligado à produção**.
- `assets/js/commerce-config.js` ainda contém valores exemplificativos e `enabled: false`.
- Esta alteração encaminha o botão “Finalizar compra” para Stripe **apenas depois** de a configuração estar ativa; mantém WhatsApp quando o checkout não está configurado ou o destino não é Portugal Continental.
- Não ativar pagamentos reais sem testar produtos, portes, taxas, personalizações, anexos, reembolsos e confirmações.

## Para concluir (primeiro em ambiente de teste)
1. Ligar o projeto Supabase correto. Aplicar a migration `supabase/migrations/202608210001_commerce.sql`, importar o seed e confirmar que os preços correspondem ao catálogo atual.
2. Configurar os secrets das Edge Functions (`STRIPE_SECRET_KEY` em modo teste, `STRIPE_WEBHOOK_SECRET`, URL do site e origens permitidas), sem nunca colocar chaves secretas no GitHub ou no browser.
3. Publicar as Edge Functions necessárias e configurar na Stripe o endpoint `stripe-webhook` e eventos indicados em `COMMERCE_ARCHITECTURE.md`.
4. Atualizar `assets/js/commerce-config.js` com **apenas** URL do Supabase e chave pública, e marcar `enabled: true` quando a instalação estiver funcional.
5. Verificar pagamento em modo teste, página de confirmação, webhook assinado, confirmação da encomenda na BD, envio de email e eventos GA4. Validar falhas e cancelamentos.
6. Só depois, e com validação expressa, passar para chaves de produção e publicar.

## Atenção
O checkout automático atual suporta apenas Portugal Continental. Produtos especiais continuam a poder seguir para orçamento personalizado. A API Stripe pode criar objetos transitórios do checkout em seu próprio sistema, mas não obriga à criação manual de cada artigo na Dashboard.
