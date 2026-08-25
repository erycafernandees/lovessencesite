import { ApiError, handleError, json, readJson, serviceClient, stripeClient, verifyAccessToken } from "../_shared/core.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json(req, {}, 204);
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  try {
    const body = await readJson<{ orderId?: string; orderToken?: string }>(req);
    const client = serviceClient();
    const { data: order, error } = await client.from("orders")
      .select("*,order_items(*),attachments(id,status)").eq("id", body.orderId || "").single();
    if (error || !order) throw new ApiError(404, "order_not_found", "A encomenda não foi encontrada.");
    await verifyAccessToken(order.access_token_hash, order.access_token_expires_at, body.orderToken);
    if (order.payment_status === "paid") throw new ApiError(409, "already_paid", "Esta encomenda já está paga.");
    if (order.stripe_checkout_session_id) {
      const existing = await stripeClient().checkout.sessions.retrieve(order.stripe_checkout_session_id);
      if (existing.status === "open" && existing.url) return json(req, { checkoutUrl: existing.url, sessionId: existing.id });
    }
    if ((order.attachments || []).some((file: { status: string }) => file.status !== "verified")) throw new ApiError(422, "unverified_files", "Confirma o envio de todos os ficheiros antes de pagar.");

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

    const siteUrl = Deno.env.get("SITE_URL") || "http://127.0.0.1:4176";
    const session = await stripeClient().checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      success_url: `${siteUrl}/encomenda/confirmacao/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/checkout/?cancelled=1`,
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      shipping_address_collection: { allowed_countries: ["PT"] },
      phone_number_collection: { enabled: true },
      customer_creation: "always",
      locale: "pt",
      metadata: { order_id: order.id, order_number: order.order_number, source: order.source },
      payment_intent_data: { metadata: { order_id: order.id, order_number: order.order_number } },
      submit_type: "pay",
    }, { idempotencyKey: `checkout-session-${order.id}` });

    await client.from("orders").update({ stripe_checkout_session_id: session.id, order_status: "awaiting_payment" }).eq("id", order.id);
    await client.from("payments").insert({ order_id: order.id, provider: "stripe", status: "unpaid", provider_checkout_id: session.id, currency: order.currency });
    return json(req, { checkoutUrl: session.url, sessionId: session.id });
  } catch (error) { return handleError(req, error); }
});

