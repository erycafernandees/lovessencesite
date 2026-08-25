import { ApiError, handleError, json, randomToken, readJson, serviceClient, sha256, stripeClient, verifyAccessToken } from "../_shared/core.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json(req, {}, 204);
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  try {
    const body = await readJson<{ quoteId?: string; quoteToken?: string; approve?: boolean }>(req);
    if (!body.approve) throw new ApiError(422, "approval_required", "É necessário aprovar o orçamento antes do pagamento.");
    const client = serviceClient();
    const { data: quote, error } = await client.from("quotes")
      .select("*,quote_items(*),project_requests(*)").eq("id", body.quoteId || "").single();
    if (error || !quote) throw new ApiError(404, "quote_not_found", "O orçamento não foi encontrado.");
    const project = quote.project_requests;
    await verifyAccessToken(quote.access_token_hash, quote.access_token_expires_at, body.quoteToken);
    if (quote.status !== "sent" && quote.status !== "approved") throw new ApiError(409, "quote_unavailable", "Este orçamento ainda não está disponível para aprovação.");
    if (quote.valid_until && new Date(`${quote.valid_until}T23:59:59Z`).getTime() < Date.now()) throw new ApiError(410, "quote_expired", "Este orçamento expirou.");
    if (quote.order_id) {
      const { data: existing } = await client.from("orders").select("stripe_checkout_session_id").eq("id", quote.order_id).single();
      if (existing?.stripe_checkout_session_id) {
        const session = await stripeClient().checkout.sessions.retrieve(existing.stripe_checkout_session_id);
        if (session.url && session.status === "open") return json(req, { checkoutUrl: session.url });
      }
    }
    const orderToken = randomToken();
    const { data: order, error: orderError } = await client.from("orders").insert({
      source: "custom_quote", order_status: "awaiting_payment", payment_status: "unpaid", payment_provider: "stripe",
      currency: quote.currency, subtotal_amount: quote.subtotal_amount, discount_amount: quote.discount_amount,
      shipping_amount: quote.shipping_amount, total_amount: quote.total_amount, customer_name: project.customer_name,
      customer_email: project.customer_email, customer_phone: project.customer_phone, project_request_id: project.id,
      access_token_hash: await sha256(orderToken), access_token_expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    }).select("id,order_number").single();
    if (orderError || !order) throw orderError || new Error("Could not create quoted order");
    const siteUrl = Deno.env.get("SITE_URL") || "http://127.0.0.1:4176";
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
      allow_promotion_codes: true, customer_email: project.customer_email,
      billing_address_collection: "auto", shipping_address_collection: { allowed_countries: ["PT"] },
      phone_number_collection: { enabled: true }, locale: "pt",
      metadata: { order_id: order.id, order_number: order.order_number, source: "custom_quote", quote_id: quote.id, project_request_id: project.id },
      payment_intent_data: { metadata: { order_id: order.id, order_number: order.order_number, quote_id: quote.id } },
    }, { idempotencyKey: `quote-checkout-${quote.id}` });
    await client.from("orders").update({ stripe_checkout_session_id: session.id }).eq("id", order.id);
    await client.from("payments").insert({ order_id: order.id, provider: "stripe", status: "unpaid", provider_checkout_id: session.id, currency: quote.currency });
    await client.from("quotes").update({ status: "approved", approved_at: new Date().toISOString(), order_id: order.id }).eq("id", quote.id);
    await client.from("project_requests").update({ status: "payment_pending" }).eq("id", project.id);
    return json(req, { checkoutUrl: session.url });
  } catch (error) { return handleError(req, error); }
});
