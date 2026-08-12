/*
 * Love Essences — configuração central de analytics
 *
 * Antes de publicar a medição, substitua apenas os dois valores abaixo:
 *   ga4MeasurementId: ID do fluxo Web do Google Analytics 4 (formato G-...)
 *   clarityProjectId: ID do projeto Microsoft Clarity
 *
 * Enquanto os valores estiverem vazios/de exemplo, nenhum script externo de
 * analytics é descarregado. O banner e o modo de teste local continuam ativos.
 */
window.LOVE_ANALYTICS_CONFIG = Object.freeze({
  version: '1.0.0',
  consentVersion: 1,
  enableGA4: true,
  enableClarity: true,
  ga4MeasurementId: 'G-XXXXXXXXXX',
  clarityProjectId: '',
  currency: 'EUR',
  debug: false,
  consentStorageKey: 'le_cookie_consent_v1',
  attributionStorageKey: 'le_campaign_attribution_v1',
  purchaseStorageKey: 'le_analytics_purchase_ids_v1',
  abandonmentStorageKey: 'le_analytics_cart_abandonment_v1'
});
