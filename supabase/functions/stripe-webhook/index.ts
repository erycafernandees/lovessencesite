import Stripe from "npm:stripe@22.5.0";
import { ApiError, deliverQueuedEmail, handleError, json, readBodyText, serviceClient, stripeClient } from "../_shared/core.ts";
import { validatePaidCheckout } from "../_shared/payment-validation.ts";

async function recordPaidSession(session: Stripe.Checkout.Session): Promise<void> {
  const client = serviceClient();
  const orderId = session.metadata?.order_id;
  if (!orderId) throw new Error("Stripe session has no order_id metadata");
  const { data: before, error: beforeError } = await client.from("orders").select("*").eq("id", orderId).single();
  if (beforeError || !before) throw beforeError || new Error("Order not found");
  validatePaidCheckout(session, before);
  let charge: Stripe.Charge | null = null;
  let balance: Stripe.BalanceTransaction | null = null;
  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  if (paymentIntentId) {
    const intent = await stripeClient().paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge.balance_transaction"] });
    if (intent.status !== "succeeded" || intent.currency !== session.currency || intent.amount_received !== session.amount_total || intent.metadata?.order_id !== orderId)
      throw new ApiError(409, "payment_intent_mismatch", "O pagamento não corresponde à encomenda.");
    charge = typeof intent.latest_charge === "object" ? intent.latest_charge : null;
    balance = charge && typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
  } else if (session.amount_total !== 0) {
    throw new ApiError(409, "missing_payment_intent", "Falta confirmar o pagamento.");
  }
  const sameSettlementCurrency = balance?.currency === session.currency;
  const { data: finalized, error: finalizeError } = await client.rpc("finalize_stripe_checkout", {
    p_session: session,
    p_payment: {
      payment_intent_id: paymentIntentId || null, charge_id: charge?.id || null,
      customer_id: typeof session.customer === "string" ? session.customer : session.customer?.id || null,
      balance_id: balance?.id || null, fee: sameSettlementCurrency ? balance?.fee : null,
      net: sameSettlementCurrency ? balance?.net : null, refunded_amount: charge?.amount_refunded || 0,
      method: charge?.payment_method_details?.type || null,
      checkout_base_amount: session.amount_subtotal,
      settlement: balance ? { amount: balance.amount, fee: balance.fee, net: balance.net, currency: balance.currency } : null,
    },
    p_admin_email: Deno.env.get("ADMIN_NOTIFICATION_EMAIL") || null,
  });
  if (finalizeError) throw finalizeError;
  for (const email of finalized?.notifications || []) {
    await deliverQueuedEmail(email.id, email.template, email.recipient, email.payload, true);
  }
}

async function recordSessionState(session: Stripe.Checkout.Session, status: "processing" | "failed"): Promise<void> {
  if (!session.metadata?.order_id) throw new Error("Stripe session has no order_id metadata");
  const { error } = await serviceClient().from("orders").update({ payment_status: status })
    .eq("id", session.metadata.order_id).eq("stripe_checkout_session_id", session.id).eq("payment_provider", "stripe")
    .in("payment_status", ["unpaid", "processing", "failed"]);
  if (error) throw error;
}

async function retrieveSession(id: string, liveMode: boolean): Promise<Stripe.Checkout.Session> {
  const session = await stripeClient().checkout.sessions.retrieve(id);
  if (session.livemode !== liveMode) throw new Error("Stripe mode mismatch");
  return session;
}

async function recordRefund(charge: Stripe.Charge): Promise<void> {
  // Event delivery is unordered. Retrieve current provider state and commit all
  // refund changes together; a delayed partial refund cannot undo a full one.
  const current = await stripeClient().charges.retrieve(charge.id, { expand: ["refunds"] });
  const { error } = await serviceClient().rpc("record_stripe_refund", { p_charge: current });
  if (error) throw error;
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
    if (!signature) throw new ApiError(400, "invalid_signature", "Falta a assinatura do webhook.");
    if (!secret) throw new Error("Webhook signature configuration missing");
    const raw = await readBodyText(req);
    const stripe = stripeClient();
    let event: Stripe.Event;
    try { event = await stripe.webhooks.constructEventAsync(raw, signature, secret, undefined, Stripe.createSubtleCryptoProvider()); }
    catch { throw new ApiError(400, "invalid_signature", "A assinatura do webhook não é válida."); }
    const client = serviceClient();
    const { error: eventError } = await client.from("webhook_events").insert({ provider: "stripe", event_id: event.id, event_type: event.type, payload: event });
    if (eventError?.code === "23505") {
      const { data: existing, error: lookupError } = await client.from("webhook_events")
        .select("processed_at").eq("provider", "stripe").eq("event_id", event.id).single();
      if (lookupError) throw lookupError;
      if (existing?.processed_at) return json(req, { received: true, duplicate: true });
      // Retry processing an event whose previous delivery failed.
    }
    if (eventError && eventError.code !== "23505") throw eventError;
    try {
      if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
        const session = await retrieveSession(event.data.object.id, event.livemode);
        if (session.payment_status === "paid" || session.payment_status === "no_payment_required") await recordPaidSession(session);
        else if (event.type === "checkout.session.async_payment_succeeded") throw new Error("Stripe payment is not yet confirmed");
        else await recordSessionState(session, "processing");
      } else if (event.type === "checkout.session.async_payment_failed") {
        const session = await retrieveSession(event.data.object.id, event.livemode);
        if (session.payment_status === "paid" || session.payment_status === "no_payment_required") await recordPaidSession(session);
        else await recordSessionState(session, "failed");
      } else if (event.type === "payment_intent.payment_failed") {
        const intent = event.data.object as Stripe.PaymentIntent;
        if (intent.metadata?.order_id) {
          const { data: order, error } = await client.from("orders").select("stripe_checkout_session_id").eq("id", intent.metadata.order_id).single();
          if (error) throw error;
          if (order?.stripe_checkout_session_id) {
            const session = await retrieveSession(order.stripe_checkout_session_id, event.livemode);
            const linkedIntent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
            if (linkedIntent === intent.id) {
              if (session.payment_status === "paid" || session.payment_status === "no_payment_required") await recordPaidSession(session);
              else await recordSessionState(session, "failed");
            }
          }
        }
      } else if (event.type === "charge.refunded") {
        await recordRefund(event.data.object as Stripe.Charge);
      } else if (event.type === "refund.created" || event.type === "refund.updated" || event.type === "refund.failed" || event.type === "charge.refund.updated") {
        await recordRefundObject(event.data.object as Stripe.Refund);
      }
      const { error: markProcessedError } = await client.from("webhook_events").update({ processed_at: new Date().toISOString(), error: null }).eq("provider", "stripe").eq("event_id", event.id);
      if (markProcessedError) throw markProcessedError;
    } catch (processingError) {
      await client.from("webhook_events").update({ error: String(processingError) }).eq("provider", "stripe").eq("event_id", event.id);
      throw processingError;
    }
    return json(req, { received: true });
  } catch (error) { return handleError(req, error); }
});
