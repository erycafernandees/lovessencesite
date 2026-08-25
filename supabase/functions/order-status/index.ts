import { ApiError, handleError, json, serviceClient, stripeClient } from "../_shared/core.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json(req, {}, 204);
  if (req.method !== "GET") return json(req, { error: "method_not_allowed" }, 405);
  try {
    const sessionId = new URL(req.url).searchParams.get("session_id");
    if (!sessionId?.startsWith("cs_")) throw new ApiError(422, "invalid_session", "A referência do pagamento não é válida.");
    const session = await stripeClient().checkout.sessions.retrieve(sessionId);
    const orderId = session.metadata?.order_id;
    if (!orderId) throw new ApiError(404, "order_not_found", "A encomenda não foi encontrada.");
    const { data: order, error } = await serviceClient().from("orders")
      .select("order_number,order_status,payment_status,total_amount,currency,created_at")
      .eq("id", orderId).eq("stripe_checkout_session_id", sessionId).single();
    if (error || !order) throw new ApiError(404, "order_not_found", "A encomenda não foi encontrada.");
    return json(req, {
      orderNumber: order.order_number,
      orderStatus: order.order_status,
      paymentStatus: order.payment_status,
      paid: order.payment_status === "paid" || order.payment_status === "partially_refunded",
      totalAmount: order.total_amount,
      currency: order.currency,
    });
  } catch (error) { return handleError(req, error); }
});

