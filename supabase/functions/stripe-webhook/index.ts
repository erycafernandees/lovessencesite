import Stripe from "npm:stripe@22.5.0";
import { handleError, json, queueEmail, serviceClient, stripeClient } from "../_shared/core.ts";

async function recordPaidSession(session: Stripe.Checkout.Session): Promise<void> {
  const client = serviceClient();
  const orderId = session.metadata?.order_id;
  if (!orderId) throw new Error("Stripe session has no order_id metadata");
  const { data: before, error: beforeError } = await client.from("orders").select("*").eq("id", orderId).single();
  if (beforeError || !before) throw beforeError || new Error("Order not found");
  const customer = session.customer_details;
  const shipping = session.collected_information?.shipping_details;
  const update = {
    payment_status: "paid", order_status: before.order_status === "awaiting_payment" || before.order_status === "draft" ? "confirmed" : before.order_status,
    customer_name: customer?.name || before.customer_name, customer_email: customer?.email || before.customer_email,
    customer_phone: customer?.phone || before.customer_phone, shipping_address: shipping || before.shipping_address,
    stripe_customer_id: typeof session.customer === "string" ? session.customer : session.customer?.id,
    stripe_payment_intent_id: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id,
    total_amount: session.amount_total ?? before.total_amount,
    discount_amount: (before.subtotal_amount + before.shipping_amount) - (session.amount_total ?? before.total_amount),
    paid_at: new Date().toISOString(),
  };
  await client.from("orders").update(update).eq("id", orderId);

  let charge: Stripe.Charge | null = null;
  let balance: Stripe.BalanceTransaction | null = null;
  const paymentIntentId = update.stripe_payment_intent_id;
  if (paymentIntentId) {
    const intent = await stripeClient().paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge.balance_transaction"] });
    charge = typeof intent.latest_charge === "object" ? intent.latest_charge : null;
    balance = charge && typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
  }
  await client.from("payments").upsert({
    order_id: orderId, provider: "stripe", status: "paid", provider_checkout_id: session.id,
    provider_payment_id: paymentIntentId, provider_charge_id: charge?.id || null,
    provider_balance_transaction_id: balance?.id || null, currency: session.currency || before.currency,
    gross_amount: balance?.amount ?? session.amount_total ?? 0, processing_fee_amount: balance?.fee ?? null,
    net_amount: balance?.net ?? null, refunded_amount: charge?.amount_refunded ?? 0,
    payment_method_type: charge?.payment_method_details?.type || null,
    provider_data: { payment_status: session.payment_status, checkout_status: session.status },
  }, { onConflict: "provider,provider_checkout_id" });
  await client.from("order_status_history").insert({ order_id: orderId, order_status: update.order_status, payment_status: "paid", note: "Pagamento confirmado pela Stripe" });
  if (before.payment_status !== "paid") {
    if (update.customer_email) await queueEmail("order_paid", update.customer_email, { orderNumber: before.order_number });
    const adminEmail = Deno.env.get("ADMIN_NOTIFICATION_EMAIL");
    if (adminEmail) await queueEmail("admin_order_paid", adminEmail, { orderNumber: before.order_number });
  }
  if (session.metadata?.quote_id) {
    await client.from("quotes").update({ status: "paid" }).eq("id", session.metadata.quote_id);
    if (session.metadata?.project_request_id) await client.from("project_requests").update({ status: "paid" }).eq("id", session.metadata.project_request_id);
  }
}

async function recordRefund(charge: Stripe.Charge): Promise<void> {
  const client = serviceClient();
  const { data: payment } = await client.from("payments").select("id,order_id,gross_amount").eq("provider_charge_id", charge.id).maybeSingle();
  if (!payment) return;
  for (const refund of charge.refunds?.data || []) {
    await client.from("refunds").upsert({ payment_id: payment.id, provider_refund_id: refund.id, amount: refund.amount, status: refund.status || "unknown", reason: refund.reason || null }, { onConflict: "provider_refund_id" });
  }
  const fullyRefunded = charge.refunded || charge.amount_refunded >= payment.gross_amount;
  const status = fullyRefunded ? "refunded" : "partially_refunded";
  await client.from("payments").update({ status, refunded_amount: charge.amount_refunded }).eq("id", payment.id);
  await client.from("orders").update({ payment_status: status }).eq("id", payment.order_id);
  await client.from("order_status_history").insert({ order_id: payment.order_id, payment_status: status, note: "Reembolso atualizado pela Stripe" });
}

async function recordRefundObject(refund: Stripe.Refund): Promise<void> {
  const chargeId = typeof refund.charge === "string" ? refund.charge : refund.charge?.id;
  if (!chargeId) return;
  const charge = await stripeClient().charges.retrieve(chargeId, { expand: ["refunds"] });
  await recordRefund(charge);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  try {
    const signature = req.headers.get("stripe-signature");
    const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    if (!signature || !secret) throw new Error("Webhook signature configuration missing");
    const raw = await req.text();
    const stripe = stripeClient();
    const event = await stripe.webhooks.constructEventAsync(raw, signature, secret, undefined, Stripe.createSubtleCryptoProvider());
    const client = serviceClient();
    const { error: eventError } = await client.from("webhook_events").insert({ provider: "stripe", event_id: event.id, event_type: event.type, payload: event });
    if (eventError?.code === "23505") return json(req, { received: true, duplicate: true });
    if (eventError) throw eventError;
    try {
      if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.payment_status === "paid" || event.type.endsWith("async_payment_succeeded")) await recordPaidSession(session);
        else if (session.metadata?.order_id) await client.from("orders").update({ payment_status: "processing" }).eq("id", session.metadata.order_id);
      } else if (event.type === "checkout.session.async_payment_failed") {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.metadata?.order_id) await client.from("orders").update({ payment_status: "failed" }).eq("id", session.metadata.order_id);
      } else if (event.type === "payment_intent.payment_failed") {
        const intent = event.data.object as Stripe.PaymentIntent;
        if (intent.metadata?.order_id) await client.from("orders").update({ payment_status: "failed" }).eq("id", intent.metadata.order_id);
      } else if (event.type === "charge.refunded") {
        await recordRefund(event.data.object as Stripe.Charge);
      } else if (event.type === "refund.created" || event.type === "refund.updated" || event.type === "refund.failed" || event.type === "charge.refund.updated") {
        await recordRefundObject(event.data.object as Stripe.Refund);
      }
      await client.from("webhook_events").update({ processed_at: new Date().toISOString() }).eq("provider", "stripe").eq("event_id", event.id);
    } catch (processingError) {
      await client.from("webhook_events").update({ error: String(processingError) }).eq("provider", "stripe").eq("event_id", event.id);
      throw processingError;
    }
    return json(req, { received: true });
  } catch (error) { return handleError(req, error); }
});
