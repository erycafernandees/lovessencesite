import { ApiError, cleanText, createSignedUploads, handleError, hasValidMagic, json, PRIVATE_BUCKET, queueEmail, randomToken, readJson, requireAdmin, serviceClient, sha256, validateUploads } from "../_shared/core.ts";

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
      let query = client.from("orders").select("id,order_number,source,order_status,payment_status,payment_provider,total_amount,currency,customer_name,customer_email,created_at,paid_at,sales_channel,is_test,admin_seen_at,payments(gross_amount,processing_fee_amount,net_amount,refunded_amount,provider_payment_id)", { count: "exact" })
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
      const { data: before, error: beforeError } = await client.from("orders").select("order_status,admin_seen_at").eq("id", id).single();
      if (beforeError || !before) throw new ApiError(404, "order_not_found", "A encomenda não foi encontrada.");
      const statusUpdate = body.orderStatus === "completed"
        ? { order_status: body.orderStatus, admin_seen_at: before.admin_seen_at || new Date().toISOString() }
        : { order_status: body.orderStatus };
      const { error: updateError } = await client.from("orders").update(statusUpdate).eq("id", id);
      if (updateError) throw updateError;
      await client.from("order_status_history").insert({ order_id: id, order_status: body.orderStatus, note: cleanText(body.note, 500), actor_user_id: admin.userId });
      await client.from("audit_log").insert({ actor_user_id: admin.userId, action: "order.status.update", entity_type: "order", entity_id: id, before_data: before, after_data: { order_status: body.orderStatus } });
      return json(req, { ok: true });
    }

    if (action === "delete-order") {
      if (admin.role !== "owner") throw new ApiError(403, "forbidden", "Apenas a proprietária pode eliminar encomendas.");
      const id = cleanText(body.id, 80, true)!;
      const { data: order, error: orderError } = await client.from("orders")
        .select("id,order_number,order_status,payment_status,paid_at,customer_name,total_amount,payments(id,status,provider_payment_id,provider_charge_id,refunded_amount)")
        .eq("id", id).single();
      if (orderError || !order) throw new ApiError(404, "order_not_found", "A encomenda não foi encontrada.");
      const payments = order.payments || [];
      const blocked = !["unpaid","failed","cancelled"].includes(order.payment_status) || Boolean(order.paid_at)
        || payments.some((payment) => !["unpaid","failed","cancelled"].includes(payment.status)
          || Boolean(payment.provider_charge_id) || Number(payment.refunded_amount || 0) > 0);
      if (blocked) throw new ApiError(409, "paid_order_protected", "Esta encomenda tem informação de pagamento que deve ser preservada e não pode ser eliminada.");
      const { error: auditError } = await client.from("audit_log").insert({
        actor_user_id: admin.userId, action: "order.delete", entity_type: "order", entity_id: id,
        before_data: { order_number: order.order_number, order_status: order.order_status, payment_status: order.payment_status, customer_name: order.customer_name, total_amount: order.total_amount },
        after_data: { deleted: true }
      });
      if (auditError) throw auditError;
      const { error: deleteError } = await client.from("orders").delete().eq("id", id).in("payment_status", ["unpaid","failed","cancelled"]).is("paid_at", null).select("id").single();
      if (deleteError) throw deleteError;
      return json(req, { ok: true });
    }

    if (action === "bulk-delete-test-orders") {
      if (admin.role !== "owner") throw new ApiError(403, "forbidden", "Apenas a proprietária pode eliminar encomendas de teste.");
      const preview = body.preview === true;
      if (!preview && body.confirmation !== "ELIMINAR_TESTES") {
        throw new ApiError(422, "confirmation_required", "É necessário confirmar a eliminação dos testes.");
      }

      const selected = Array.isArray(body.ids) ? body.ids : null;
      if (body.ids !== undefined && (!selected || selected.length < 1 || selected.length > 500
        || selected.some((id) => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
        || new Set(selected).size !== selected.length)) {
        throw new ApiError(422, "invalid_test_selection", "Seleciona entre 1 e 500 encomendas de teste válidas.");
      }
      // Nunca confiar no filtro do browser para autorizar eliminações.
      let query = client.from("orders")
        .select("id,order_number,is_test,payment_status,paid_at,stripe_payment_intent_id,stripe_checkout_session_id,customer_name,total_amount,payments(id,status,provider_payment_id,provider_charge_id,refunded_amount)")
        .eq("is_test", true).order("created_at", { ascending: false });
      query = selected ? query.in("id", selected) : query.limit(501);
      const { data: orders, error: ordersError } = await query;
      if (ordersError) throw ordersError;
      if (!selected && (orders || []).length > 500) throw new ApiError(422, "too_many_tests", "Existem mais de 500 testes. Faz a limpeza por seleção.");
      if (selected && orders?.length !== selected.length) throw new ApiError(409, "selection_changed", "A lista de testes foi alterada. Atualiza a página e tenta novamente.");

      const allowedStates = new Set(["unpaid", "failed", "cancelled"]);
      const eligible = (orders || []).filter((order) => allowedStates.has(order.payment_status)
        && !order.paid_at && !order.stripe_payment_intent_id && !order.stripe_checkout_session_id
        && (order.payments || []).every((payment) => allowedStates.has(payment.status)
          && !payment.provider_payment_id && !payment.provider_charge_id
          && Number(payment.refunded_amount || 0) === 0));

      // Cupões e códigos de checkout podem ter referências próprias: preservar
      // essas encomendas para evitar falhas de integridade e perda de histórico.
      const preliminaryIds = eligible.map((order) => order.id);
      let linkedCodeIds = new Set<string>();
      if (preliminaryIds.length) {
        const { data: codes, error: codesError } = await client.from("one_time_checkout_codes")
          .select("order_id").in("order_id", preliminaryIds);
        if (codesError) throw codesError;
        linkedCodeIds = new Set((codes || []).map((code) => code.order_id));
      }
      const safeOrders = eligible.filter((order) => !linkedCodeIds.has(order.id));
      const skippedCount = (orders || []).length - safeOrders.length;
      if (preview) return json(req, {
        eligibleIds: safeOrders.map((order) => order.id),
        eligibleCount: safeOrders.length, skippedCount, totalCount: (orders || []).length,
      });
      if (!selected) throw new ApiError(422, "selection_required", "Confirma primeiro quais os testes a eliminar.");
      if (!safeOrders.length) return json(req, { deletedCount: 0, skippedCount });

      const { error: auditError } = await client.from("audit_log").insert(safeOrders.map((order) => ({
        actor_user_id: admin.userId, action: "order.test.bulk_delete", entity_type: "order", entity_id: order.id,
        before_data: { order_number: order.order_number, customer_name: order.customer_name,
          payment_status: order.payment_status, total_amount: order.total_amount, is_test: true },
        after_data: { deleted: true, method: "bulk" },
      })));
      if (auditError) throw auditError;
      const { data: deleted, error: deleteError } = await client.from("orders").delete()
        .in("id", safeOrders.map((order) => order.id)).eq("is_test", true)
        .in("payment_status", ["unpaid", "failed", "cancelled"])
        .is("paid_at", null).is("stripe_payment_intent_id", null).is("stripe_checkout_session_id", null)
        .select("id");
      if (deleteError) throw deleteError;
      return json(req, {
        deletedCount: deleted?.length || 0,
        skippedCount: (orders || []).length - (deleted?.length || 0),
      });
    }

    if (action === "bulk-delete-draft-orders") {
      if (admin.role !== "owner") throw new ApiError(403, "forbidden", "Apenas a proprietária pode eliminar encomendas.");
      const preview = body.preview === true;
      if (!preview && body.confirmation !== "ELIMINAR_RASCUNHOS") {
        throw new ApiError(422, "confirmation_required", "Confirma a eliminação dos rascunhos.");
      }

      const selected = Array.isArray(body.ids) ? body.ids : null;
      if (body.ids !== undefined && (!selected || selected.length < 1 || selected.length > 500
        || selected.some((id) => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
        || new Set(selected).size !== selected.length)) {
        throw new ApiError(422, "invalid_selection", "Seleciona entre 1 e 500 encomendas válidas.");
      }

      // A lista enviada pelo browser não constitui autorização. Revalidar no servidor.
      let query = client.from("orders")
        .select("id,order_number,is_test,order_status,payment_status,paid_at,stripe_payment_intent_id,stripe_checkout_session_id,customer_name,total_amount,payments(id,status,provider_payment_id,provider_charge_id,refunded_amount)")
        .eq("is_test", false).eq("order_status", "draft").eq("payment_status", "unpaid")
        .order("created_at", { ascending: false });
      query = selected ? query.in("id", selected) : query.limit(501);
      const { data: orders, error: ordersError } = await query;
      if (ordersError) throw ordersError;
      if (!selected && (orders || []).length > 500) throw new ApiError(422, "too_many_drafts", "Existem mais de 500 rascunhos. Faz a limpeza por seleção.");
      if (selected && orders?.length !== selected.length) {
        throw new ApiError(409, "selection_changed", "Uma das encomendas já não é um rascunho por pagar. Atualiza a lista.");
      }

      const neutralPayments = new Set(["unpaid", "failed", "cancelled"]);
      const prelim = (orders || []).filter((order) => !order.paid_at
        && !order.stripe_payment_intent_id && !order.stripe_checkout_session_id
        && (order.payments || []).every((payment) => neutralPayments.has(payment.status)
          && !payment.provider_payment_id && !payment.provider_charge_id
          && Number(payment.refunded_amount || 0) === 0));
      let linkedCodes = new Set<string>();
      if (prelim.length) {
        const { data: codes, error: codesError } = await client.from("one_time_checkout_codes")
          .select("order_id").in("order_id", prelim.map((order) => order.id));
        if (codesError) throw codesError;
        linkedCodes = new Set((codes || []).map((code) => code.order_id));
      }
      const eligible = prelim.filter((order) => !linkedCodes.has(order.id));
      const skippedCount = (orders || []).length - eligible.length;

      if (preview) return json(req, {
        eligibleIds: eligible.map((order) => order.id), eligibleCount: eligible.length,
        skippedCount, totalCount: (orders || []).length,
      });
      if (!selected) throw new ApiError(422, "selection_required", "Primeiro confirma os rascunhos a eliminar.");
      if (!eligible.length) return json(req, { deletedCount: 0, skippedCount });

      const { error: auditError } = await client.from("audit_log").insert(eligible.map((order) => ({
        actor_user_id: admin.userId, action: "order.draft.bulk_delete", entity_type: "order", entity_id: order.id,
        before_data: { order_number: order.order_number, customer_name: order.customer_name,
          order_status: order.order_status, payment_status: order.payment_status,
          total_amount: order.total_amount, is_test: false },
        after_data: { deleted: true, method: "bulk" },
      })));
      if (auditError) throw auditError;

      const { data: deleted, error: deleteError } = await client.from("orders").delete()
        .in("id", eligible.map((order) => order.id))
        .eq("is_test", false).eq("order_status", "draft").eq("payment_status", "unpaid")
        .is("paid_at", null).is("stripe_payment_intent_id", null)
        .is("stripe_checkout_session_id", null).select("id");
      if (deleteError) throw deleteError;
      return json(req, {
        deletedCount: deleted?.length || 0,
        skippedCount: (orders || []).length - (deleted?.length || 0),
      });
    }

    if (action === "mark-seen") {
      const id = cleanText(body.id, 80, true)!;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new ApiError(422, "invalid_id", "A referência indicada não é válida.");
      }
      const kind = body.kind;
      if (kind !== "order" && kind !== "project") {
        throw new ApiError(422, "invalid_kind", "O tipo de registo não é válido.");
      }
      const table = kind === "order" ? "orders" : "project_requests";
      const { data, error } = await client.from(table)
        .update({ admin_seen_at: new Date().toISOString() })
        .eq("id", id).is("admin_seen_at", null).select("id");
      if (error) throw error;
      return json(req, { ok: true, updated: (data || []).length > 0 });
    }

    if (action === "list-projects") {
      const { data, error } = await client.from("project_requests").select("id,project_number,status,admin_seen_at,customer_name,customer_email,occasion,project_type,event_date,created_at,quotes(id,status,total_amount,currency,valid_until)").order("created_at", { ascending: false }).limit(100);
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
      const { data: before, error: beforeError } = await client.from("project_requests").select("status,admin_seen_at").eq("id", id).single();
      if (beforeError || !before) throw new ApiError(404, "project_not_found", "O projeto não foi encontrado.");
      const projectUpdate = body.status === "completed"
        ? { status: body.status, admin_seen_at: before.admin_seen_at || new Date().toISOString() }
        : { status: body.status };
      const { error: updateError } = await client.from("project_requests").update(projectUpdate).eq("id", id);
      if (updateError) throw updateError;
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
      if (project.customer_email) await queueEmail("quote_ready", project.customer_email, { projectNumber: project.project_number, quoteUrl, totalAmount: subtotal - discount + shipping });
      return json(req, { ok: true, quoteId: quote.id, quoteUrl });
    }


    // Encomendas registadas pela equipa (Instagram, WhatsApp ou outro canal).
    // Não cria pagamentos Stripe; um pagamento marcado como pago é manual.
    if (action === "create-manual-order") {
      if (admin.role === "viewer") throw new ApiError(403, "forbidden", "Não tens permissão para criar encomendas.");
      const channel = cleanText(body.channel, 20, true)!;
      if (!["whatsapp", "instagram", "other"].includes(channel)) {
        throw new ApiError(422, "invalid_channel", "Seleciona um canal válido.");
      }
      const customerName = cleanText(body.customerName, 160, true)!;
      const customerEmail = cleanText(body.customerEmail, 254);
      if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
        throw new ApiError(422, "invalid_email", "O email indicado não é válido.");
      }
      const customerPhone = cleanText(body.customerPhone, 50);
      const description = cleanText(body.description, 240, true)!;
      const notes = cleanText(body.notes, 3000);
      const quantity = Number(body.quantity);
      const totalAmount = Number(body.totalAmount);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) {
        throw new ApiError(422, "invalid_quantity", "Indica uma quantidade válida.");
      }
      if (!Number.isSafeInteger(totalAmount) || totalAmount < 0 || totalAmount > 100000000) {
        throw new ApiError(422, "invalid_total", "O total da encomenda não é válido.");
      }
      if (body.paymentStatus !== "paid" && body.paymentStatus !== "unpaid") {
        throw new ApiError(422, "invalid_payment_status", "Seleciona um estado de pagamento válido.");
      }
      if (body.isTest !== undefined && typeof body.isTest !== "boolean") {
        throw new ApiError(422, "invalid_test", "O tipo de encomenda não é válido.");
      }
      const paid = body.paymentStatus === "paid";
      const now = new Date().toISOString();
      const token = randomToken();
      const { data: order, error: orderError } = await client.from("orders").insert({
        source: "catalog",
        order_status: paid ? "confirmed" : "draft",
        payment_status: paid ? "paid" : "unpaid",
        payment_provider: "manual",
        sales_channel: channel,
        customer_name: customerName,
        customer_email: customerEmail?.toLowerCase() || null,
        customer_phone: customerPhone,
        subtotal_amount: totalAmount,
        discount_amount: 0,
        shipping_amount: 0,
        total_amount: totalAmount,
        notes,
        is_test: body.isTest === true,
        paid_at: paid ? now : null,
        access_token_hash: await sha256(token),
      }).select("id,order_number,total_amount").single();
      if (orderError || !order) throw orderError || new Error("Could not create manual order");

      // O valor introduzido no painel é o total acordado para a quantidade
      // completa. Nem sempre há um preço unitário exato em cêntimos.
      const { error: itemError } = await client.from("order_items").insert({
        order_id: order.id,
        product_code: "MANUAL",
        variant_code: "PERSONALIZADO",
        name: description,
        quantity,
        unit_amount: Math.round(totalAmount / quantity),
        line_amount: totalAmount,
        personalization: {},
        product_snapshot: { manual: true, priceType: "negotiated_total", description, quantity },
      });
      if (itemError) throw itemError;

      if (paid) {
        const { error: paymentError } = await client.from("payments").insert({
          order_id: order.id,
          provider: "manual",
          status: "paid",
          currency: "eur",
          gross_amount: totalAmount,
          processing_fee_amount: 0,
          net_amount: totalAmount,
          refunded_amount: 0,
          payment_method_type: "manual",
          provider_data: { salesChannel: channel, recordedByAdmin: true },
        });
        if (paymentError) throw paymentError;
      }

      const { error: historyError } = await client.from("order_status_history").insert({
        order_id: order.id,
        order_status: paid ? "confirmed" : "draft",
        payment_status: paid ? "paid" : "unpaid",
        note: "Encomenda registada manualmente",
        actor_user_id: admin.userId,
      });
      if (historyError) throw historyError;
      const { error: auditError } = await client.from("audit_log").insert({
        actor_user_id: admin.userId,
        action: "order.manual.create",
        entity_type: "order",
        entity_id: order.id,
        after_data: {
          order_number: order.order_number,
          sales_channel: channel,
          quantity,
          total_amount: totalAmount,
          payment_status: paid ? "paid" : "unpaid",
          is_test: body.isTest === true,
        },
      });
      if (auditError) throw auditError;
      return json(req, { ok: true, orderId: order.id, orderNumber: order.order_number });
    }

    if (action === "prepare-order-photo") {
      if (admin.role === "viewer") throw new ApiError(403, "forbidden", "Não tens permissão para adicionar fotografias.");
      const orderId = cleanText(body.orderId, 80, true)!;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
        throw new ApiError(422, "invalid_id", "A referência da encomenda não é válida.");
      }
      const { data: order, error: orderError } = await client.from("orders")
        .select("id,payment_provider").eq("id", orderId).single();
      if (orderError || !order || order.payment_provider !== "manual") {
        throw new ApiError(404, "order_not_found", "A encomenda manual não foi encontrada.");
      }
      const { count, error: countError } = await client.from("attachments")
        .select("id", { count: "exact", head: true }).eq("order_id", orderId);
      if (countError) throw countError;
      if ((count || 0) >= 10) throw new ApiError(422, "too_many_files", "Podes anexar até 10 fotografias por encomenda.");
      const descriptors = validateUploads([{
        name: body.fileName, type: body.mimeType, size: body.sizeBytes,
      }], 1);
      if (!["image/png", "image/jpeg"].includes(descriptors[0].type)) {
        throw new ApiError(422, "invalid_file_type", "Escolhe uma fotografia JPG ou PNG.");
      }
      const prepared = await createSignedUploads(descriptors, { orderId });
      return json(req, prepared[0]);
    }

    if (action === "finish-order-photo") {
      if (admin.role === "viewer") throw new ApiError(403, "forbidden", "Não tens permissão para confirmar fotografias.");
      const attachmentId = cleanText(body.attachmentId, 80, true)!;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attachmentId)) {
        throw new ApiError(422, "invalid_id", "O anexo indicado não é válido.");
      }
      const { data: attachment, error: attachmentError } = await client.from("attachments")
        .select("id,order_id,object_path,mime_type,size_bytes,status").eq("id", attachmentId).single();
      if (attachmentError || !attachment?.order_id) {
        throw new ApiError(404, "attachment_not_found", "O anexo não foi encontrado.");
      }
      const { data: order, error: orderError } = await client.from("orders")
        .select("id,payment_provider").eq("id", attachment.order_id).single();
      if (orderError || !order || order.payment_provider !== "manual") {
        throw new ApiError(404, "order_not_found", "A encomenda manual não foi encontrada.");
      }
      if (attachment.status === "verified") return json(req, { ok: true });
      if (attachment.status !== "pending_upload" && attachment.status !== "uploaded") {
        throw new ApiError(422, "invalid_attachment", "O anexo não pode ser confirmado.");
      }
      const { data: blob, error: downloadError } = await client.storage.from(PRIVATE_BUCKET)
        .download(attachment.object_path);
      if (downloadError || !blob) throw new ApiError(422, "upload_missing", "A fotografia ainda não foi carregada.");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const valid = bytes.length === Number(attachment.size_bytes)
        && bytes.length <= 10 * 1024 * 1024
        && ["image/jpeg", "image/png"].includes(attachment.mime_type)
        && hasValidMagic(bytes, attachment.mime_type);
      if (!valid) {
        await client.storage.from(PRIVATE_BUCKET).remove([attachment.object_path]);
        await client.from("attachments").update({
          status: "rejected", rejection_reason: "content_mismatch",
        }).eq("id", attachment.id);
        throw new ApiError(422, "invalid_file_content", "A fotografia não corresponde ao ficheiro indicado.");
      }
      const { error: updateError } = await client.from("attachments").update({
        status: "verified", sha256: await sha256(bytes), verified_at: new Date().toISOString(),
      }).eq("id", attachment.id);
      if (updateError) throw updateError;
      return json(req, { ok: true });
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
