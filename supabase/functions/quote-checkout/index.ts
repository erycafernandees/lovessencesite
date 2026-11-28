import { customerNif } from "../_shared/customer-nif.ts";
import { ApiError, checkoutSiteUrl, handleError, json, randomToken, readJson, serviceClient, sha256, stripeClient, verifyAccessToken } from "../_shared/core.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json(req, {}, 204);
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  try {
    const body = await readJson<{ quoteId?: string; quoteToken?: string; customerNif?: string; approve?: boolean }>(req);
    if (body.approve !== true) throw new ApiError(422, "approval_required", "É necessário aprovar o orçamento antes do pagamento.");
    const nif = customerNif(body.customerNif);
    const client = serviceClient();
    const { data: authorizedQuote, error } = await client.from("quotes")
      .select("*,quote_items(*),project_requests(*)").eq("id", body.quoteId || "").single();
    if (error || !authorizedQuote) throw new ApiError(404, "quote_not_found", "O orçamento não foi encontrado.");
    await verifyAccessToken(authorizedQuote.access_token_hash, authorizedQuote.access_token_expires_at, body.quoteToken);
    if (!["sent", "approved"].includes(authorizedQuote.status)) throw new ApiError(409, "quote_unavailable", "Este orçamento ainda não está disponível para aprovação.");
    if (authorizedQuote.valid_until && new Date(`${authorizedQuote.valid_until}T23:59:59Z`).getTime() < Date.now()) throw new ApiError(410, "quote_expired", "Este orçamento expirou.");
    const { data: reservation, error: reserveError } = await client.rpc("reserve_quote_checkout", {
      p_quote_id: authorizedQuote.id, p_access_hash: await sha256(String(body.quoteToken)), p_order_token_hash: await sha256(randomToken()),
    });
    if (reserveError || !reservation) throw reserveError || new Error("Could not reserve quoted order");
    const { order, quote } = reservation;
    const project = quote.project_requests;
    if (nif) {
      const { error } = await client.rpc("save_quote_checkout_nif", {p_order:order.id, p_project:project.id, p_nif:nif});
      if (error) throw error;
    }
    if (order.stripe_checkout_session_id) {
      const existing = await stripeClient().checkout.sessions.retrieve(order.stripe_checkout_session_id);
      if (existing.metadata?.order_id !== order.id) throw new ApiError(409, "checkout_mismatch", "Não foi possível confirmar a ligação de pagamento.");
      if (existing.status === "open" && existing.url) return json(req, { checkoutUrl: existing.url });
      throw new ApiError(existing.status === "complete" ? 409 : 410, "checkout_closed", "Esta ligação de pagamento já foi concluída ou expirou. Contacta-nos para confirmar o pagamento ou renovar o orçamento.");
    }
    const siteUrl = checkoutSiteUrl(req);
    const discountRatio = quote.subtotal_amount > 0 ? quote.discount_amount / quote.subtotal_amount : 0;
    let allocatedDiscount = 0;
    const lineItems = quote.quote_items.map((item: Record<string, unknown>, index: number) => {
      const lineAmount = Number(item.line_amount);
      const lineDiscount = index === quote.quote_items.length - 1
        ? quote.discount_amount - allocatedDiscount
        : Math.round(lineAmount * discountRatio);
      allocatedDiscount += lineDiscount;
      return {
        quantity: 1,
        price_data: {
          currency: quote.currency,
          unit_amount: Math.max(0, lineAmount - lineDiscount),
          product_data: { name: `${item.description} × ${item.quantity}`.slice(0, 120) },
        },
      };
    });
    if (quote.shipping_amount > 0) {
      lineItems.push({ quantity: 1, price_data: { currency: quote.currency, unit_amount: quote.shipping_amount, product_data: { name: "Envio" } } });
    }
    const session = await stripeClient().checkout.sessions.create({
      mode: "payment", line_items: lineItems,
      success_url: `${siteUrl}/encomenda/confirmacao/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/projeto/orcamento/?quote=${quote.id}&token=${encodeURIComponent(String(body.quoteToken))}&cancelled=1`,
      allow_promotion_codes: true,
      ...(project.customer_email ? { customer_email: project.customer_email } : {}),
      billing_address_collection: "auto", shipping_address_collection: { allowed_countries: ["PT"] },
      phone_number_collection: { enabled: true }, locale: "pt",
      metadata: { order_id: order.id, order_number: order.order_number, source: "custom_quote", quote_id: quote.id, project_request_id: project.id },
      payment_intent_data: { metadata: { order_id: order.id, order_number: order.order_number, quote_id: quote.id } },
    }, { idempotencyKey: `quote-checkout-${quote.id}` });
    if (session.metadata?.order_id !== order.id) throw new ApiError(409, "checkout_mismatch", "Não foi possível confirmar a ligação de pagamento.");
    const { error: attachError } = await client.rpc("attach_stripe_checkout", { p_order_id: order.id, p_session_id: session.id });
    if (attachError) throw attachError;
    return json(req, { checkoutUrl: session.url });
  } catch (error) { return handleError(req, error); }
});
