# Analytics e privacidade — Love Essences

## Ativação

A configuração central está em `assets/js/analytics-config.js`.

1. No GA4, criar um fluxo Web para `https://love-essences.pt` e copiar o ID `G-...`.
2. No Microsoft Clarity, criar o projeto para `love-essences.pt` e copiar o Project ID.
3. Substituir `G-XXXXXXXXXX` e o valor vazio de `clarityProjectId` no ficheiro de configuração.
4. Manter `enableGA4` e `enableClarity` em `true`. Qualquer integração pode ser desligada individualmente com `false`.

Com IDs vazios/de exemplo, nenhuma biblioteca externa é descarregada. O banner, a atribuição e o modo de teste local continuam disponíveis.

## Consentimento

- O estado inicial do Google Consent Mode v2 é `denied` para Analytics e Marketing.
- GA4 e Clarity só são carregados depois de consentimento analítico explícito.
- O visitante pode aceitar, rejeitar ou gerir separadamente Necessários, Analytics e Marketing.
- “Gerir cookies” está disponível no rodapé e na Política de Privacidade.
- Revogar Analytics remove cookies conhecidos de GA4/Clarity.
- Campos de formulário, personalização e carrinho são mascarados no Clarity.
- Não são enviados nomes, emails, telefones, moradas, mensagens ou textos de personalização.

## Eventos implementados

| Área | Eventos |
| --- | --- |
| Navegação | `page_view`, `scroll_depth`, `cta_click`, `site_error` |
| Descoberta | `view_item_list`, `select_item`, `view_item`, `filter_use` |
| Carrinho | `add_to_cart`, `remove_from_cart`, `view_cart`, `cart_abandonment` |
| Pedido | `begin_checkout`, `whatsapp_click`, `checkout_error`, `generate_lead` |
| Futuro checkout | `add_shipping_info`, `add_payment_info`, `purchase` |

Os eventos de comércio usam `EUR`, `item_id`, nome seguro do catálogo, categoria, variante, preço e quantidade. O `purchase` exige `transaction_id` e é deduplicado em `localStorage`, inclusive após atualização da página.

O site atual não recebe pagamento online nem tem uma página real de confirmação: o pedido termina em WhatsApp ou formulário. Por isso, não é emitido um `purchase` fictício. Quando existir checkout, a integração deve chamar:

```js
LoveAnalytics.trackShippingInfo('Portugal Continental');
LoveAnalytics.trackPaymentInfo('MB WAY');
LoveAnalytics.trackPurchase({
  transactionId: 'LE-12345',
  value: 24.90,
  shipping: 4.90,
  tax: 0,
  items: [
    {
      item_id: 'bloom',
      item_name: 'Bloom',
      item_category: 'Coleção Assinatura',
      item_variant: 'Mini',
      price: 20,
      quantity: 1
    }
  ]
});
```

## Campanhas e WhatsApp

Os parâmetros `utm_source`, `utm_medium`, `utm_campaign`, `utm_term` e `utm_content` são guardados como primeira e última origem. São anexados aos eventos sem guardar outros parâmetros ou informação pessoal. `whatsapp_click` inclui página, produto seguro do catálogo quando aplicável e atribuição UTM.

## Pesquisa

Não existe atualmente um campo de pesquisa interna no site. Quando for acrescentado, usar:

```js
LoveAnalytics.trackSearch(termo, numeroDeResultados);
```

Termos com formato de email ou telefone são recusados.

## Testes antes de publicar

1. Abrir o site com `?analytics_debug=1`.
2. Antes de consentir, confirmar no separador Network que não existem pedidos para `googletagmanager.com` ou `clarity.ms`.
3. Testar “Rejeitar” e confirmar que os scripts não carregam.
4. Em “Gerir cookies”, aceitar Analytics e confirmar GA4 no DebugView/Tag Assistant e Clarity no Live View.
5. Navegar por loja, filtros, produto, adicionar/remover, abrir carrinho e iniciar pedido.
6. Confirmar eventos com `LoveAnalytics.getDebugEvents()` na consola.
7. Confirmar que um único clique gera um único evento do mesmo tipo.
8. Chamar `trackPurchase` duas vezes com o mesmo `transactionId`; a primeira chamada deve devolver `true` e a segunda `false`. Atualizar a página e confirmar que continua `false`.
9. Rever gravações do Clarity e confirmar que formulários, personalização e carrinho aparecem mascarados.

O ficheiro `faturacao.html` é uma ferramenta separada de faturação/backoffice e foi deliberadamente excluído da medição pública para proteger dados pessoais.
