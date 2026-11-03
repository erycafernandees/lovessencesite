import { createRemoteJWKSet, jwtVerify } from "npm:jose@6.1.0";
import { ApiError, handleError, json, queueEmail, serviceClient, stripeClient } from "../_shared/core.ts";

const REPOSITORY = "erycafernandees/lovessencesite";
const WORKFLOW_REF = REPOSITORY + "/.github/workflows/commerce-audit.yml@refs/heads/main";
const JWKS = createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));

async function authorizeGithub(req: Request): Promise<void> {
  const authorization = req.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) throw new ApiError(401, "unauthorized", "Não autorizado.");
  try {
    const { payload } = await jwtVerify(authorization.slice(7), JWKS, {
      issuer: "https://token.actions.githubusercontent.com",
      audience: "love-essences-commerce-audit",
      algorithms: ["RS256"],
    });
    if (payload.repository !== REPOSITORY ||
        String(payload.repository_id || "") !== "1210285972" ||
        payload.ref !== "refs/heads/main" ||
        payload.workflow_ref !== WORKFLOW_REF ||
        !["schedule", "workflow_dispatch", "push"].includes(String(payload.event_name || ""))) {
      throw new Error("Untrusted GitHub Actions identity");
    }
  } catch (_) {
    throw new ApiError(401, "unauthorized", "Não autorizado.");
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  try {
    await authorizeGithub(req);
    const db = serviceClient();
    const now = Date.now();
    const since = new Date(now - 7 * 86400000).toISOString();
    const oldEnough = new Date(now - 15 * 60000).toISOString();

    const [ordersRes, paymentsRes, webhookRes, outboxRes] = await Promise.all([
      db.from("orders")
        .select("id,order_number,is_test,payment_status,payment_provider,order_status,total_amount,stripe_checkout_session_id,created_at")
        .gte("created_at", since).limit(1000),
      db.from("payments").select("order_id,provider,status,provider_checkout_id")
        .gte("created_at", since).limit(1000),
      db.from("webhook_events").select("event_type,processed_at,error,created_at")
        .eq("provider", "stripe").gte("created_at", since).limit(1000),
      db.from("notification_outbox").select("template,payload,sent_at,last_error,created_at")
        .gte("created_at", since).limit(1000),
    ]);
    for (const response of [ordersRes, paymentsRes, webhookRes, outboxRes]) {
      if (response.error) throw response.error;
    }
    const orders = ordersRes.data || [];
    const payments = paymentsRes.data || [];
    const byId = new Map(orders.map((order) => [order.id, order]));
    const byNumber = new Map(orders.map((order) => [order.order_number, order]));
    const issues = new Set<string>();

    // Stripe is the system of record for real, successfully paid Checkout Sessions.
    const stripe = stripeClient();
    const sessions = await stripe.checkout.sessions.list({
      limit: 100,
      created: { gte: Math.floor((now - 7 * 86400000) / 1000) },
    });
    if (sessions.has_more) issues.add("stripe_list_incomplete");
    for (const session of sessions.data) {
      const orderId = session.metadata?.order_id;
      if (!orderId) continue;
      const order = byId.get(orderId);
      if (!order) { issues.add("stripe_order_missing"); continue; }
      if (session.payment_status === "paid" && new Date(order.created_at).getTime() < now - 15 * 60000) {
        if (order.payment_status !== "paid") issues.add("paid_session_not_registered");
        if (order.stripe_checkout_session_id !== session.id) issues.add("paid_session_id_mismatch");
        if (session.amount_total != null && order.total_amount !== session.amount_total) {
          issues.add("paid_amount_mismatch");
        }
      }
    }

    for (const order of orders) {
      if (order.payment_provider !== "stripe" || order.is_test) continue;
      if (order.payment_status === "paid" &&
          !payments.some((payment) => payment.provider === "stripe" && payment.order_id === order.id && payment.status === "paid")) {
        issues.add("paid_order_missing_payment_record");
      }
      if (order.payment_status === "processing" && order.created_at < oldEnough) {
        issues.add("stalled_processing_payment");
      }
    }

    for (const event of webhookRes.data || []) {
      if (event.created_at < oldEnough && (event.error || !event.processed_at)) {
        issues.add("webhook_unprocessed_or_failed");
      }
    }

    for (const message of outboxRes.data || []) {
      if (!["order_paid", "admin_order_paid", "project_received", "admin_project_received"].includes(message.template)) continue;
      if (message.created_at >= oldEnough || message.sent_at) continue;
      const order = byNumber.get(String(message.payload?.orderNumber || ""));
      if (order?.is_test) continue;
      if (message.last_error || order || message.template.includes("project")) {
        issues.add("transactional_email_unsent");
      }
    }

    if (issues.size) {
      // One admin email per 24 hours, and no personal or payment details in the message.
      const previous = await db.from("notification_outbox")
        .select("id", { head: true, count: "exact" }).eq("template", "commerce_audit_alert")
        .gte("created_at", new Date(now - 86400000).toISOString());
      if (previous.error) throw previous.error;
      if (!previous.count) {
        const recipient = Deno.env.get("ADMIN_NOTIFICATION_EMAIL");
        if (recipient) await queueEmail("commerce_audit_alert", recipient, { issueTypes: [...issues].sort() });
      }
      return json(req, { healthy: false, areas: issues.size }, 503);
    }
    return json(req, { healthy: true });
  } catch (error) { return handleError(req, error); }
});
