import { ApiError, cleanText, handleError, json, PRIVATE_BUCKET, queueEmail, randomToken, readJson, requireAdmin, serviceClient, sha256 } from "../_shared/core.ts";

const ORDER_STATES = ["draft","awaiting_payment","confirmed","review","awaiting_details","production","ready_to_ship","shipped","completed","cancelled"];
const PROJECT_STATES = ["draft","submitted","in_review","awaiting_details","quoted","approved","payment_pending","paid","production","completed","declined","archived"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json(req, {}, 204);
  try {
    const admin = await requireAdmin(req);
    const body = req.method === "POST" ? await readJson<Record<string, unknown>>(req) : {};
    const url = new URL(req.url);
    const action = String(body.action || url.searchParams.get("action") || "list-orders");
    const client = serviceClient();

    if (action === "list-orders") {
      const page = Math.max(1, Number(url.searchParams.get("page") || body.page || 1));
      const status = cleanText(url.searchParams.get("status") || body.status, 40);
      let query = client.from("orders").select("id,order_number,source,order_status,payment_status,payment_provider,total_amount,currency,customer_name,customer_email,created_at,paid_at,payments(gross_amount,processing_fee_amount,net_amount,refunded_amount,provider_payment_id)", { count: "exact" })
        .order("created_at", { ascending: false }).range((page - 1) * 25, page * 25 - 1);
      if (status) query = query.eq("order_status", status);
      const { data, count, error } = await query;
      if (error) throw error;
      return json(req, { data, count, page, pageSize: 25 });
    }

    if (action === "get-order") {
      const id = cleanText(body.id || url.searchParams.get("id"), 80, true)!;
      const { data, error } = await client.from("orders").select("*,order_items(*),attachments(*),payments(*,refunds(*)),order_status_history(*)").eq("id", id).single();
      if (error || !data) throw new ApiError(404, "order_not_found", "A encomenda não foi encontrada.");
      return json(req, data);
    }

    if (action === "update-order") {
      if (!ORDER_STATES.includes(String(body.orderStatus))) throw new ApiError(422, "invalid_status", "O estado da encomenda não é válido.");
      const id = cleanText(body.id, 80, true)!;
      const { data: before, error: beforeError } = await client.from("orders").select("order_status").eq("id", id).single();
      if (beforeError || !before) throw new ApiError(404, "order_not_found", "A encomenda não foi encontrada.");
      await client.from("orders").update({ order_status: body.orderStatus }).eq("id", id);
      await client.from("order_status_history").insert({ order_id: id, order_status: body.orderStatus, note: cleanText(body.note, 500), actor_user_id: admin.userId });
      await client.from("audit_log").insert({ actor_user_id: admin.userId, action: "order.status.update", entity_type: "order", entity_id: id, before_data: before, after_data: { order_status: body.orderStatus } });
      return json(req, { ok: true });
    }

    if (action === "list-projects") {
      const { data, error } = await client.from("project_requests").select("id,project_number,status,customer_name,customer_email,occasion,project_type,event_date,created_at,quotes(id,status,total_amount,currency,valid_until)").order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      return json(req, { data });
    }

    if (action === "get-project") {
      const id = cleanText(body.id || url.searchParams.get("id"), 80, true)!;
      const { data, error } = await client.from("project_requests").select("*,attachments(*),quotes(*,quote_items(*)),project_status_history(*)").eq("id", id).single();
      if (error || !data) throw new ApiError(404, "project_not_found", "O projeto não foi encontrado.");
      return json(req, data);
    }

    if (action === "update-project") {
      if (!PROJECT_STATES.includes(String(body.status))) throw new ApiError(422, "invalid_status", "O estado do projeto não é válido.");
      const id = cleanText(body.id, 80, true)!;
      const { data: before, error: beforeError } = await client.from("project_requests").select("status").eq("id", id).single();
      if (beforeError || !before) throw new ApiError(404, "project_not_found", "O projeto não foi encontrado.");
      await client.from("project_requests").update({ status: body.status }).eq("id", id);
      await client.from("project_status_history").insert({ project_request_id: id, status: body.status, note: cleanText(body.note, 500), actor_user_id: admin.userId });
      await client.from("audit_log").insert({ actor_user_id: admin.userId, action: "project.status.update", entity_type: "project_request", entity_id: id, before_data: before, after_data: { status: body.status } });
      return json(req, { ok: true });
    }

    if (action === "create-quote") {
      if (!Array.isArray(body.items) || !body.items.length || body.items.length > 30) throw new ApiError(422, "invalid_quote", "Adiciona pelo menos uma linha ao orçamento.");
      const projectId = cleanText(body.projectId, 80, true)!;
      const { data: project, error: projectError } = await client.from("project_requests").select("id,project_number,customer_email").eq("id", projectId).single();
      if (projectError || !project) throw new ApiError(404, "project_not_found", "O projeto não foi encontrado.");
      const { data: versions } = await client.from("quotes").select("version").eq("project_request_id", projectId).order("version", { ascending: false }).limit(1);
      const normalizedItems = body.items.map((raw) => {
        const item = raw as Record<string, unknown>;
        const quantity = Number(item.quantity);
        const unitAmount = Number(item.unitAmount);
        if (!Number.isInteger(quantity) || quantity < 1 || !Number.isInteger(unitAmount) || unitAmount < 0) throw new ApiError(422, "invalid_quote_item", "Uma linha do orçamento não é válida.");
        return { description: cleanText(item.description, 240, true), quantity, unit_amount: unitAmount, line_amount: quantity * unitAmount };
      });
      const subtotal = normalizedItems.reduce((sum, item) => sum + item.line_amount, 0);
      const discount = Math.max(0, Number(body.discountAmount) || 0);
      const shipping = Math.max(0, Number(body.shippingAmount) || 0);
      if (![discount, shipping].every(Number.isInteger) || discount > subtotal) throw new ApiError(422, "invalid_totals", "Os totais do orçamento não são válidos.");
      const quoteToken = randomToken();
      const accessExpiresAt = body.validUntil
        ? new Date(`${body.validUntil}T23:59:59Z`).toISOString()
        : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const { data: quote, error: quoteError } = await client.from("quotes").insert({
        project_request_id: projectId, version: Number(versions?.[0]?.version || 0) + 1, status: "sent",
        subtotal_amount: subtotal, discount_amount: discount, shipping_amount: shipping, total_amount: subtotal - discount + shipping,
        notes: cleanText(body.notes, 2000), valid_until: body.validUntil || null,
        access_token_hash: await sha256(quoteToken), access_token_expires_at: accessExpiresAt,
      }).select("id").single();
      if (quoteError || !quote) throw quoteError || new Error("Could not create quote");
      await client.from("quote_items").insert(normalizedItems.map((item) => ({ ...item, quote_id: quote.id })));
      await client.from("project_requests").update({ status: "quoted" }).eq("id", projectId);
      await client.from("project_status_history").insert({ project_request_id: projectId, status: "quoted", note: "Orçamento criado", actor_user_id: admin.userId });
      await client.from("audit_log").insert({ actor_user_id: admin.userId, action: "quote.create", entity_type: "quote", entity_id: quote.id, after_data: { total_amount: subtotal - discount + shipping } });
      const siteUrl = Deno.env.get("SITE_URL") || "http://127.0.0.1:4176";
      const quoteUrl = `${siteUrl}/projeto/orcamento/?quote=${quote.id}&token=${encodeURIComponent(quoteToken)}`;
      await queueEmail("quote_ready", project.customer_email, { projectNumber: project.project_number, quoteUrl, totalAmount: subtotal - discount + shipping });
      return json(req, { ok: true, quoteId: quote.id, quoteUrl });
    }

    if (action === "signed-file") {
      const id = cleanText(body.id || url.searchParams.get("id"), 80, true)!;
      const { data: attachment, error } = await client.from("attachments").select("object_path,original_name,status").eq("id", id).single();
      if (error || !attachment || attachment.status !== "verified") throw new ApiError(404, "file_not_found", "O ficheiro não está disponível.");
      const { data: signed, error: signError } = await client.storage.from(PRIVATE_BUCKET).createSignedUrl(attachment.object_path, 300, { download: attachment.original_name });
      if (signError || !signed) throw signError || new Error("Could not sign file");
      return json(req, { url: signed.signedUrl, expiresIn: 300 });
    }

    throw new ApiError(404, "unknown_action", "A operação pedida não existe.");
  } catch (error) { return handleError(req, error); }
});
