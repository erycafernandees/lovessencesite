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
      .select("order_number,order_status,payment_status,total_amount,shipping_amount,currency,created_at,order_items(product_code,variant_code,name,quantity,unit_amount)")
      .eq("id", orderId).eq("stripe_checkout_session_id", sessionId).single();
    if (error || !order) throw new ApiError(404, "order_not_found", "A encomenda não foi encontrada.");
    return json(req, {
      orderNumber: order.order_number,
      orderStatus: order.order_status,
      paymentStatus: order.payment_status,
      paid: order.payment_status === "paid" || order.payment_status === "partially_refunded",
      totalAmount: order.total_amount,
      currency: order.currency,
      shippingAmount: order.shipping_amount,
      items: (order.order_items || []).map((item: {
        product_code: string; variant_code: string; name: string;
        quantity: number; unit_amount: number;
      }) => ({
        item_id: item.product_code,
        item_name: item.name,
        item_variant: item.variant_code,
        quantity: item.quantity,
        price: item.unit_amount / 100,
      })),
    });
  } catch (error) { return handleError(req, error); }
});

