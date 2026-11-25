import { ApiError } from "./core.ts";

type Checkout = {
  id: string; mode: string | null; status: string | null; payment_status: string;
  currency: string | null; amount_subtotal: number | null; amount_total: number | null;
  total_details: { amount_discount: number; amount_tax: number; amount_shipping: number | null } | null;
  metadata: Record<string, string> | null;
};

// Stripe coupons remain enabled. Only Stripe's authenticated discount may reduce
// the server's checkout amount; browser totals and metadata cannot set a price.
export function validatePaidCheckout(session: Checkout, order: Record<string, any>): void {
  const fail = () => { throw new ApiError(409, "payment_mismatch", "O pagamento não corresponde à encomenda."); };
  if (session.id !== order.stripe_checkout_session_id || session.metadata?.order_id !== order.id || order.payment_provider !== "stripe") fail();
  if (session.mode !== "payment" || session.status !== "complete" || session.currency !== order.currency) fail();
  if (!Number.isSafeInteger(session.amount_total) || session.amount_total! < 0 || !Number.isSafeInteger(session.amount_subtotal)) fail();
  const discount = session.total_details?.amount_discount;
  if (!Number.isSafeInteger(discount) || discount! < 0 || discount! > session.amount_subtotal!) fail();
  // Shipping is already included as a line item; tax is not enabled by this app.
  if (session.total_details?.amount_tax !== 0 || (session.total_details?.amount_shipping ?? 0) !== 0) fail();
  const expectedBase = Number(order.subtotal_amount) - Number(order.discount_amount) + Number(order.shipping_amount);
  const terminal = ["paid", "partially_refunded", "refunded"].includes(order.payment_status);
  if (!terminal && session.amount_subtotal !== expectedBase) fail();
  if (session.amount_total !== session.amount_subtotal! - discount!) fail();
  if (terminal && (session.amount_total !== order.total_amount || session.amount_subtotal !== Number(order.subtotal_amount) + Number(order.shipping_amount) - Number(order.discount_amount) + discount!)) fail();
  if (session.payment_status !== "paid" && !(session.payment_status === "no_payment_required" && session.amount_total === 0)) fail();
}
