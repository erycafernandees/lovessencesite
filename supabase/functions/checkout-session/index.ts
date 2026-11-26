import { ApiError, checkoutSiteUrl, handleError, json, readJson, serviceClient, stripeClient, verifyAccessToken } from "../_shared/core.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json(req, {}, 204);
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  try {
    const body = await readJson<{ orderId?: string; orderToken?: string; promoCode?: string }>(req);
    const client = serviceClient();
    const { data: order, error } = await client.from("orders")
      .select("*,order_items(*),attachments(id,status)").eq("id", body.orderId || "").single();
    if (error || !order) throw new ApiError(404, "order_not_found", "A encomenda não foi encontrada.");
    await verifyAccessToken(order.access_token_hash, order.access_token_expires_at, body.orderToken);
    if (!["unpaid", "processing", "failed"].includes(order.payment_status) || order.payment_provider !== "stripe" || order.order_status === "cancelled") throw new ApiError(409, "already_paid", "Esta encomenda já não está disponível para pagamento.");
    if (order.stripe_checkout_session_id) {
      const existing = await stripeClient().checkout.sessions.retrieve(order.stripe_checkout_session_id);
      if (existing.metadata?.order_id !== order.id) throw new ApiError(409, "checkout_mismatch", "Não foi possível confirmar a ligação de pagamento.");
      if (existing.status === "open" && existing.url) return json(req, { checkoutUrl: existing.url, sessionId: existing.id });
      throw new ApiError(existing.status === "complete" ? 409 : 410, "checkout_closed", "Esta ligação de pagamento já foi concluída ou expirou. Contacta-nos ou inicia uma nova encomenda.");
    }
    if ((order.attachments || []).some((file: { status: string }) => file.status !== "verified")) throw new ApiError(422, "unverified_files", "Confirma o envio de todos os ficheiros antes de pagar.");

    // Preserve the existing one-use checkout code, including safe retries for
    // the same order. The normal cart still uses server-calculated prices.
    const testCode = String(body.promoCode || "").trim().toUpperCase() === "TESTELOVE1";
    if (body.promoCode && !testCode) throw new ApiError(422, "invalid_code", "Código promocional inválido.");
    if (testCode) {
      if (order.source !== "catalog" || order.currency !== "eur" || order.total_amount < 100) throw new ApiError(422, "invalid_test_cart", "Este código não é válido para esta encomenda.");
      const { data: claimed, error: claimError } = await client.rpc("claim_test_checkout_code", { p_code: "TESTELOVE1", p_order_id: order.id });
      if (claimError) throw claimError;
      if (!claimed) throw new ApiError(409, "code_used", "O código TESTELOVE1 já foi utilizado.");
      const { error: discountError } = await client.from("orders").update({ discount_amount: Number(order.subtotal_amount) + Number(order.shipping_amount) - 100, total_amount: 100, is_test: true, promotion_snapshot: { code: "TESTELOVE1", label: "Teste de pagamento único", finalAmount: 100 } }).eq("id", order.id);
      if (discountError) throw discountError;
    }

    const discountRatio = order.subtotal_amount > 0 ? order.discount_amount / order.subtotal_amount : 0;
    let allocatedDiscount = 0;
    const lineItems = order.order_items.map((item: Record<string, unknown>, index: number) => {
      const lineAmount = Number(item.line_amount);
      const isLast = index === order.order_items.length - 1;
      const lineDiscount = isLast ? order.discount_amount - allocatedDiscount : Math.round(lineAmount * discountRatio);
      allocatedDiscount += lineDiscount;
      const snapshot = item.product_snapshot as Record<string, unknown>;
      return {
        quantity: 1,
        price_data: {
          currency: order.currency,
          unit_amount: Math.max(0, lineAmount - lineDiscount),
          product_data: {
            name: `${item.name} × ${item.quantity}`.slice(0, 120),
            description: Object.keys((item.personalization as Record<string, unknown>) || {}).length ? "Produto personalizado" : undefined,
            metadata: { product_code: String(item.product_code), variant_code: String(item.variant_code), order_item_id: String(item.id) },
            images: typeof snapshot?.imagePath === "string" && snapshot.imagePath.startsWith("https://") ? [snapshot.imagePath] : undefined,
          },
        },
      };
    });
    if (order.shipping_amount > 0) {
      lineItems.push({ quantity: 1, price_data: { currency: order.currency, unit_amount: order.shipping_amount, product_data: { name: "Envio Expresso — Portugal Continental", metadata: { product_code: "shipping", variant_code: "mainland", order_item_id: "shipping" } } } });
    }

    if (testCode) lineItems.splice(0, lineItems.length, { quantity: 1, price_data: { currency: "eur", unit_amount: 100, product_data: { name: "Encomenda Love Essences — pagamento de teste", metadata: { product_code: "test", variant_code: "test", order_item_id: "test" } } } });
    const siteUrl = checkoutSiteUrl(req);
    const session = await stripeClient().checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      success_url: `${siteUrl}/encomenda/confirmacao/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/checkout/?cancelled=1`,
      allow_promotion_codes: !testCode,
      billing_address_collection: "auto",
      shipping_address_collection: { allowed_countries: ["PT"] },
      phone_number_collection: { enabled: true },
      customer_creation: "always",
      locale: "pt",
      metadata: { order_id: order.id, order_number: order.order_number, source: order.source, ...(testCode ? { promo_code: "TESTELOVE1" } : {}) },
      payment_intent_data: { metadata: { order_id: order.id, order_number: order.order_number } },
      submit_type: "pay",
    }, { idempotencyKey: `checkout-session-${order.id}` });

    if (session.metadata?.order_id !== order.id) throw new ApiError(409, "checkout_mismatch", "Não foi possível confirmar a ligação de pagamento.");
    const { error: attachError } = await client.rpc("attach_stripe_checkout", { p_order_id: order.id, p_session_id: session.id });
    if (attachError) throw attachError;
    return json(req, { checkoutUrl: session.url, sessionId: session.id });
  } catch (error) { return handleError(req, error); }
});

