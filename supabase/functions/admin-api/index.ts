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

    if (action === "list-checkout-errors") {
      const { data, error } = await client.from("site_error_events")
        .select("id,created_at,category,area,page_path,error_message,resolved_at")
        .eq("category", "checkout").order("created_at", { ascending: false }).limit(150);
      if (error) throw error;
      return json(req, { data: data || [], count: (data || []).length });
    }

    if (action === "resolve-checkout-error") {
      if (admin.role === "viewer") throw new ApiError(403, "forbidden", "Não tens permissão para alterar o estado das falhas.");
      const id = cleanText(body.id, 80, true)!;
      if (!/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n)
        throw new ApiError(422, "invalid_id", "Identificador inválido.");
      if (typeof body.resolved !== "boolean") throw new ApiError(422, "invalid_status", "Estado inválido.");
      const { data, error } = await client.from("site_error_events")
        .update({ resolved_at: body.resolved ? new Date().toISOString() : null, resolved_by: body.resolved ? admin.userId : null })
        .eq("id", id).eq("category", "checkout").select("id,resolved_at").maybeSingle();
      if (error) throw error;
      if (!data) throw new ApiError(404, "not_found", "Falha não encontrada.");
      return json(req, { ok: true, ...data });
    }

    if (action === "list-orders") {
      const page = Math.max(1, Number(url.searchParams.get("page") || body.page || 1));
      const status = cleanText(url.searchParams.get("status") || body.status, 40);
      let query = client.from("orders").select("id,order_number,source,order_status,payment_status,payment_provider,manual_received_amount,total_amount,currency,customer_name,customer_email,delivery_method,delivery_tracking_code,delivery_meeting_place,delivery_meeting_at,expected_delivery_date,created_at,paid_at,sales_channel,is_test,admin_seen_at,payments(gross_amount,processing_fee_amount,net_amount,refunded_amount,provider_payment_id)", { count: "exact" })
        .is("project_request_id", null)
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

    // Opção de entrega privada, independente de pagamento e fase de execução.
    if (action === "set-delivery") {
      if (admin.role === "viewer") throw new ApiError(403, "forbidden", "Não tens permissão para editar entregas.");
      const kind = String(body.kind || "");
      if (kind !== "order" && kind !== "project") throw new ApiError(422, "invalid_delivery_kind", "Tipo de encomenda inválido.");
      const id = cleanText(body.id, 80, true)!;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
        throw new ApiError(422, "invalid_delivery_id", "Identificador inválido.");
      const rawMethod = body.deliveryMethod == null ? "" : String(body.deliveryMethod);
      if (!["","ctt","hand_delivery"].includes(rawMethod)) throw new ApiError(422, "invalid_delivery_method", "Seleciona CTT ou entrega em mãos.");
      const method = rawMethod || null;
      const tracking = method === "ctt" ? String(body.trackingCode || "").trim().replace(/\s+/g,"").toUpperCase() : "";
      if (tracking.length > 60 || (tracking && !/^[A-Z0-9-]+$/.test(tracking)))
        throw new ApiError(422, "invalid_tracking", "O código CTT deve conter apenas letras, números ou hífen.");
      const place = method === "hand_delivery" ? cleanText(body.meetingPlace, 250) : null;
      const notes = method ? cleanText(body.deliveryNotes, 1000) : null;
      let meetingAt: string | null = null;
      if (method === "hand_delivery" && body.meetingAt) {
        const rawAt = String(body.meetingAt);
        const timestamp = Date.parse(rawAt);
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(rawAt) || !Number.isFinite(timestamp))
          throw new ApiError(422, "invalid_delivery_date", "A data da entrega não é válida.");
        meetingAt = new Date(timestamp).toISOString();
      }
      const table = kind === "order" ? "orders" : "project_requests";
      const { data: before, error: fetchError } = await client.from(table)
        .select("id,delivery_method,delivery_tracking_code,delivery_meeting_place,delivery_meeting_at,delivery_notes")
        .eq("id", id).single();
      if (fetchError || !before) throw new ApiError(404, "delivery_not_found", "Encomenda não encontrada.");
      const patch = {
        delivery_method: method,
        delivery_tracking_code: method === "ctt" ? tracking || null : null,
        delivery_meeting_place: method === "hand_delivery" ? place || null : null,
        delivery_meeting_at: meetingAt,
        delivery_notes: notes || null,
      };
      const { data: updated, error: saveError } = await client.from(table).update(patch)
        .eq("id", id).select("id").single();
      if (saveError || !updated) throw saveError || new ApiError(409, "delivery_save_failed", "Não foi possível guardar a entrega.");
      await client.from("audit_log").insert({
        actor_user_id: admin.userId,
        action: kind === "order" ? "order.delivery.update" : "project.delivery.update",
        entity_type: kind === "order" ? "order" : "project_request", entity_id: id,
        before_data: before, after_data: patch,
      });
      return json(req, { ok: true, delivery: patch });
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
        .select("id,order_number,order_status,payment_status,paid_at,customer_name,total_amount,manual_received_amount,payments(id,status,provider_payment_id,provider_charge_id,refunded_amount)")
        .eq("id", id).single();
      if (orderError || !order) throw new ApiError(404, "order_not_found", "A encomenda não foi encontrada.");
      const payments = order.payments || [];
      const blocked = !["unpaid","failed","cancelled"].includes(order.payment_status) || Boolean(order.paid_at) || Number(order.manual_received_amount || 0) > 0
        || payments.some((payment) => !["unpaid","failed","cancelled"].includes(payment.status)
          || Boolean(payment.provider_charge_id) || Number(payment.refunded_amount || 0) > 0);
      if (blocked) throw new ApiError(409, "paid_order_protected", "Esta encomenda tem informação de pagamento que deve ser preservada e não pode ser eliminada.");
      const { error: auditError } = await client.from("audit_log").insert({
        actor_user_id: admin.userId, action: "order.delete", entity_type: "order", entity_id: id,
        before_data: { order_number: order.order_number, order_status: order.order_status, payment_status: order.payment_status, customer_name: order.customer_name, total_amount: order.total_amount },
        after_data: { deleted: true }
      });
      if (auditError) throw auditError;
      const { error: deleteError } = await client.from("orders").delete().eq("id", id).in("payment_status", ["unpaid","failed","cancelled"]).is("paid_at", null).eq("manual_received_amount", 0).select("id").single();
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
        .select("id,order_number,is_test,payment_status,paid_at,stripe_payment_intent_id,stripe_checkout_session_id,customer_name,total_amount,manual_received_amount,payments(id,status,provider_payment_id,provider_charge_id,refunded_amount)")
        .eq("is_test", true).order("created_at", { ascending: false });
      query = selected ? query.in("id", selected) : query.limit(501);
      const { data: orders, error: ordersError } = await query;
      if (ordersError) throw ordersError;
      if (!selected && (orders || []).length > 500) throw new ApiError(422, "too_many_tests", "Existem mais de 500 testes. Faz a limpeza por seleção.");
      if (selected && orders?.length !== selected.length) throw new ApiError(409, "selection_changed", "A lista de testes foi alterada. Atualiza a página e tenta novamente.");

      const allowedStates = new Set(["unpaid", "failed", "cancelled"]);
      const eligible = (orders || []).filter((order) => allowedStates.has(order.payment_status)
        && !order.paid_at && Number(order.manual_received_amount || 0) === 0 && !order.stripe_payment_intent_id && !order.stripe_checkout_session_id
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
        .is("paid_at", null).eq("manual_received_amount", 0).is("stripe_payment_intent_id", null).is("stripe_checkout_session_id", null)
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
        .select("id,order_number,is_test,order_status,payment_status,paid_at,stripe_payment_intent_id,stripe_checkout_session_id,customer_name,total_amount,manual_received_amount,payments(id,status,provider_payment_id,provider_charge_id,refunded_amount)")
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
      const prelim = (orders || []).filter((order) => !order.paid_at && Number(order.manual_received_amount || 0) === 0
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
        .is("paid_at", null).eq("manual_received_amount", 0).is("stripe_payment_intent_id", null)
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
      const { data, error } = await client.from("project_requests").select("id,project_number,status,fulfillment_status,payment_received_amount,payment_needs_confirmation,admin_seen_at,customer_name,customer_email,delivery_method,delivery_tracking_code,delivery_meeting_place,delivery_meeting_at,occasion,project_type,event_date,created_at,quotes(id,version,status,total_amount,currency,valid_until,created_at),orders(id,payment_status,payment_provider,total_amount,manual_received_amount,created_at,payments(gross_amount,refunded_amount)),project_status_history(status)").order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      return json(req, { data });
    }

    if (action === "get-project") {
      const id = cleanText(body.id || url.searchParams.get("id"), 80, true)!;
      const { data, error } = await client.from("project_requests").select("*,attachments(*),quotes(*,quote_items(*)),orders(id,payment_status,payment_provider,total_amount,manual_received_amount,created_at,payments(gross_amount,refunded_amount)),project_status_history(*)").eq("id", id).single();
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

    // A fase de execução é independente do estado do orçamento e do pagamento.
    if (action === "set-project-fulfillment") {
      if (admin.role === "viewer") throw new ApiError(403, "forbidden", "Não tens permissão para alterar encomendas.");
      const id = cleanText(body.id, 80, true)!;
      const next = String(body.fulfillmentStatus || "");
      const allowed = ["confirmed","review","awaiting_details","production","ready_to_ship","shipped","completed","cancelled"];
      if (!allowed.includes(next)) throw new ApiError(422, "invalid_fulfillment", "Seleciona um estado de encomenda válido.");
      const { data: previous, error: beforeError } = await client.from("project_requests")
        .select("fulfillment_status,admin_seen_at").eq("id", id).single();
      if (beforeError || !previous) throw new ApiError(404, "project_not_found", "Projeto não encontrado.");
      const { data: updated, error: updateError } = await client.from("project_requests")
        .update({ fulfillment_status: next,
          ...(next === "completed" ? { admin_seen_at: previous.admin_seen_at || new Date().toISOString() } : {}) })
        .eq("id", id).eq("fulfillment_status", previous.fulfillment_status).select("id").maybeSingle();
      if (updateError) throw updateError;
      if (!updated) throw new ApiError(409, "project_changed", "O projeto mudou entretanto. Atualiza a página.");
      await client.from("audit_log").insert({
        actor_user_id: admin.userId, action: "project.fulfillment.update",
        entity_type: "project_request", entity_id: id,
        before_data: { fulfillment_status: previous.fulfillment_status }, after_data: { fulfillment_status: next }
      });
      return json(req, { ok: true, fulfillmentStatus: next });
    }

    // Montante efetivamente registado como recebido: 0, sinal, parcial ou integral.
    if (action === "set-project-payment") {
      if (admin.role === "viewer") throw new ApiError(403, "forbidden", "Não tens permissão para atualizar pagamentos.");
      const id = cleanText(body.id, 80, true)!;
      const receivedAmount = Number(body.receivedAmount);
      if (!Number.isSafeInteger(receivedAmount) || receivedAmount < 0 || receivedAmount > 100000000)
        throw new ApiError(422, "invalid_payment", "Introduz o valor recebido em euros.");
      const { data: previous, error: readError } = await client.from("project_requests")
        .select("id,status,payment_received_amount,payment_needs_confirmation").eq("id", id).single();
      if (readError || !previous) throw new ApiError(404, "project_not_found", "Projeto não encontrado.");
      const { data: quotes, error: quotesError } = await client.from("quotes")
        .select("id,version,status,total_amount,order_id").eq("project_request_id", id)
        .order("version", { ascending: false }).limit(30);
      if (quotesError) throw quotesError;
      const latest = (quotes || []).find(q => !["cancelled","expired"].includes(q.status));
      if (!latest) throw new ApiError(409, "no_quote", "Guarda primeiro um orçamento com valor.");
      const totalAmount = Number(latest.total_amount);
      if (receivedAmount > totalAmount) throw new ApiError(422, "amount_too_high", "O valor recebido não pode ultrapassar o orçamento.");
      if (receivedAmount < Number(previous.payment_received_amount || 0) && body.confirmReduction !== true)
        throw new ApiError(409, "confirm_correction", "Confirma a correção de um montante recebido mais baixo.");
      // Não substituir movimentos confirmados automaticamente por pagamentos manuais.
      const { data: linkedOrders, error: linkedError } = await client.from("orders")
        .select("id").eq("project_request_id", id).limit(1);
      if (linkedError) throw linkedError;
      if ((linkedOrders || []).length || (quotes || []).some(q => Boolean(q.order_id)))
        throw new ApiError(409, "linked_checkout", "Este projeto já tem um pagamento associado a uma encomenda. Consulta o registo dessa encomenda.");
      // Manter o estado histórico de orçamento/pagamento consistente com o novo registo.
      // Este campo não controla a produção, que agora é independente.
      const legacyStatus = receivedAmount === totalAmount && totalAmount > 0 ? "paid"
        : ["paid","payment_pending"].includes(previous.status) ? "payment_pending" : previous.status;
      const { data: updated, error: updateError } = await client.from("project_requests")
        .update({ payment_received_amount: receivedAmount, payment_needs_confirmation: false,
          status: legacyStatus })
        .eq("id", id).eq("payment_received_amount", previous.payment_received_amount)
        .select("id").maybeSingle();
      if (updateError) throw updateError;
      if (!updated) throw new ApiError(409, "project_changed", "O pagamento mudou entretanto. Atualiza a página.");
      await client.from("audit_log").insert({
        actor_user_id: admin.userId, action: "project.payment.update",
        entity_type: "project_request", entity_id: id,
        before_data: { payment_received_amount: previous.payment_received_amount,
          payment_needs_confirmation: previous.payment_needs_confirmation, legacy_status: previous.status },
        after_data: { payment_received_amount: receivedAmount, payment_needs_confirmation: false,
          quote_id: latest.id, quote_total_amount: totalAmount, legacy_status: legacyStatus }
      });
      return json(req, { ok: true, receivedAmount });
    }

    if (action === "update-project-notes") {
      if (admin.role === "viewer") throw new ApiError(403, "forbidden", "Não tens permissão para alterar notas.");
      const id = cleanText(body.id, 80, true)!;
      if (typeof body.notes !== "string") throw new ApiError(422, "invalid_notes", "As notas devem ser texto.");
      const notes = body.notes.trim().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
      if (notes.length > 4000) throw new ApiError(422, "notes_too_long", "As notas não podem ultrapassar 4000 caracteres.");
      const { data: existing, error: beforeError } = await client.from("project_requests")
        .select("admin_notes").eq("id", id).single();
      if (beforeError || !existing) throw new ApiError(404, "project_not_found", "O projeto não foi encontrado.");
      const { error: updateError } = await client.from("project_requests")
        .update({ admin_notes: notes || null }).eq("id", id);
      if (updateError) throw updateError;
      await client.from("audit_log").insert({
        actor_user_id: admin.userId, action: "project.internal_notes.update",
        entity_type: "project_request", entity_id: id,
        before_data: { admin_notes: existing.admin_notes },
        after_data: { admin_notes: notes || null },
      });
      return json(req, { ok: true });
    }

    if (action === "create-quote") {
      if (admin.role === "viewer") throw new ApiError(403, "forbidden", "Não tens permissão para criar orçamentos.");
      if (!Array.isArray(body.items) || !body.items.length || body.items.length > 30) throw new ApiError(422, "invalid_quote", "Adiciona pelo menos uma linha ao orçamento.");
      const projectId = cleanText(body.projectId, 80, true)!;
      const { data: project, error: projectError } = await client.from("project_requests").select("id,project_number,customer_email,payment_received_amount").eq("id", projectId).single();
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
      if (Number(project.payment_received_amount || 0) > subtotal - discount + shipping)
        throw new ApiError(409, "quote_below_received", "O novo orçamento não pode ser inferior ao valor já recebido. Corrige primeiro o pagamento.");
      // Guardar não publica o orçamento nem envia mensagens.
      const { data: quote, error: quoteError } = await client.from("quotes").insert({
        project_request_id: projectId, version: Number(versions?.[0]?.version || 0) + 1, status: "draft",
        subtotal_amount: subtotal, discount_amount: discount, shipping_amount: shipping, total_amount: subtotal - discount + shipping,
        notes: cleanText(body.notes, 2000), valid_until: body.validUntil || null,
      }).select("id").single();
      if (quoteError || !quote) throw quoteError || new Error("Could not create quote");
      const { error: itemsError } = await client.from("quote_items")
        .insert(normalizedItems.map((item) => ({ ...item, quote_id: quote.id })));
      if (itemsError) {
        await client.from("quotes").delete().eq("id", quote.id);
        throw itemsError;
      }
      await client.from("audit_log").insert({
        actor_user_id: admin.userId, action: "quote.draft.create", entity_type: "quote",
        entity_id: quote.id, after_data: { status: "draft", total_amount: subtotal - discount + shipping },
      });
      return json(req, { ok: true, quoteId: quote.id, status: "draft" });
    }


    if (action === "delete-draft-quote") {
      if (admin.role === "viewer") throw new ApiError(403, "forbidden", "Não tens permissão para eliminar orçamentos.");
      const id = cleanText(body.id, 80, true)!;
      const { data: quote, error: quoteError } = await client.from("quotes")
        .select("id,project_request_id,version,status,total_amount,order_id,access_token_hash")
        .eq("id", id).single();
      if (quoteError || !quote) throw new ApiError(404, "quote_not_found", "O orçamento não foi encontrado.");
      if (quote.status !== "draft" || quote.order_id || quote.access_token_hash) {
        throw new ApiError(409, "quote_protected", "Só podes eliminar rascunhos nunca enviados e sem encomendas associadas.");
      }
      // Não eliminar o último orçamento com valores já recebidos.
      const { data: projectPayment, error: projectPaymentError } = await client.from("project_requests")
        .select("payment_received_amount").eq("id", quote.project_request_id).single();
      if (projectPaymentError) throw projectPaymentError;
      const received = Number(projectPayment?.payment_received_amount || 0);
      if (received > 0) {
        const { data: alternatives, error: alternativesError } = await client.from("quotes")
          .select("total_amount,status,version").eq("project_request_id", quote.project_request_id)
          .neq("id", id).order("version", { ascending: false });
        if (alternativesError) throw alternativesError;
        const latestRemaining = (alternatives || []).find(item => !["expired","cancelled"].includes(item.status));
        if (!latestRemaining || Number(latestRemaining.total_amount) < received)
          throw new ApiError(409, "quote_has_receipt", "Mantém um orçamento que cubra o valor recebido antes de eliminar este rascunho.");
      }
      const { data: deleted, error: deleteError } = await client.from("quotes").delete()
        .eq("id", id).eq("status", "draft").is("order_id", null).is("access_token_hash", null)
        .select("id").maybeSingle();
      if (deleteError) throw deleteError;
      if (!deleted) throw new ApiError(409, "quote_changed", "O orçamento foi alterado. Atualiza a página e confirma novamente.");
      const { error: auditError } = await client.from("audit_log").insert({
        actor_user_id: admin.userId, action: "quote.draft.delete", entity_type: "quote", entity_id: id,
        before_data: { project_request_id: quote.project_request_id, version: quote.version, total_amount: quote.total_amount, status: "draft" },
        after_data: { deleted: true },
      });
      if (auditError) console.error("Could not audit quote draft deletion", auditError);
      return json(req, { ok: true });
    }

    if (action === "send-quote") {
      if (admin.role === "viewer") throw new ApiError(403, "forbidden", "Não tens permissão para enviar orçamentos.");
      const id = cleanText(body.id, 80, true)!;
      const { data: quote, error: quoteError } = await client.from("quotes")
        .select("id,project_request_id,status,valid_until,total_amount,project_requests(project_number,customer_email)")
        .eq("id", id).single();
      if (quoteError || !quote) throw new ApiError(404, "quote_not_found", "O orçamento não foi encontrado.");
      if (quote.status !== "draft") throw new ApiError(409, "quote_not_draft", "Este orçamento já não é um rascunho e não pode ser enviado novamente.");
      if (quote.valid_until && new Date(`${quote.valid_until}T23:59:59Z`).getTime() < Date.now()) {
        throw new ApiError(410, "quote_expired", "A validade do orçamento já terminou.");
      }
      const token = randomToken();
      const expiresAt = quote.valid_until
        ? new Date(`${quote.valid_until}T23:59:59Z`).toISOString()
        : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      // Só o envio explícito torna a proposta acessível ao cliente.
      const { data: sent, error: sendError } = await client.from("quotes")
        .update({ status: "sent", access_token_hash: await sha256(token), access_token_expires_at: expiresAt })
        .eq("id", id).eq("status", "draft").select("id").maybeSingle();
      if (sendError) throw sendError;
      if (!sent) throw new ApiError(409, "quote_already_sent", "O orçamento foi alterado. Atualiza a página antes de tentar novamente.");
      await client.from("project_requests").update({ status: "quoted" }).eq("id", quote.project_request_id);
      await client.from("project_status_history").insert({
        project_request_id: quote.project_request_id, status: "quoted",
        note: "Orçamento enviado", actor_user_id: admin.userId,
      });
      await client.from("audit_log").insert({
        actor_user_id: admin.userId, action: "quote.send", entity_type: "quote", entity_id: id,
        after_data: { status: "sent", total_amount: quote.total_amount },
      });
      const siteUrl = Deno.env.get("SITE_URL") || "http://127.0.0.1:4176";
      const quoteUrl = `${siteUrl}/projeto/orcamento/?quote=${id}&token=${encodeURIComponent(token)}`;
      const project = quote.project_requests as { project_number: string; customer_email: string | null } | null;
      let emailQueued = false;
      let emailError: string | null = null;
      if (project?.customer_email) {
        try {
          await queueEmail("quote_ready", project.customer_email, {
            projectNumber: project.project_number, quoteUrl, totalAmount: quote.total_amount,
          });
          emailQueued = true;
        } catch (error) {
          emailError = error instanceof Error ? error.message : "O envio do email falhou.";
        }
      }
      return json(req, { ok: true, quoteUrl, emailQueued, emailError });
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
      const notes = cleanText(body.notes, 3000);
      const rawItems = Array.isArray(body.items) ? body.items : [{description:body.description,quantity:body.quantity,lineAmount:body.totalAmount}];
      if (!rawItems.length || rawItems.length > 50) throw new ApiError(422,"items","São permitidos 1 a 50 artigos.");
      const manualItems = rawItems.map((entry: any) => {
        const description = cleanText(entry.description,240,true)!;
        const quantity = Number(entry.quantity), lineAmount = Number(entry.lineAmount);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000 || !Number.isSafeInteger(lineAmount) || lineAmount < 0 || lineAmount > 100000000)
          throw new ApiError(422,"invalid_items","Verifica a quantidade e o valor de cada artigo.");
        return {description,quantity,lineAmount};
      });
      const sum = manualItems.reduce((t:number,x:any)=>t+x.lineAmount,0);
      const totalAmount = Number(body.totalAmount);
      if (totalAmount !== sum) throw new ApiError(422,"total_mismatch","O total não coincide com a soma dos artigos.");
      if (!Number.isSafeInteger(totalAmount) || totalAmount < 0 || totalAmount > 100000000) {
        throw new ApiError(422, "invalid_total", "O total da encomenda não é válido.");
      }
      if (body.paymentStatus !== "paid" && body.paymentStatus !== "unpaid") {
        throw new ApiError(422, "invalid_payment_status", "Seleciona um estado de pagamento válido.");
      }
      if (body.isTest !== undefined && typeof body.isTest !== "boolean") {
        throw new ApiError(422, "invalid_test", "O tipo de encomenda não é válido.");
      }
      const expectedDeliveryDate = body.expectedDeliveryDate == null || body.expectedDeliveryDate === "" ? null : String(body.expectedDeliveryDate);
      if (expectedDeliveryDate && (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDeliveryDate) || !Number.isFinite(Date.parse(expectedDeliveryDate)) || new Date(expectedDeliveryDate).toISOString().slice(0,10) !== expectedDeliveryDate))
        throw new ApiError(422,"invalid_expected_delivery_date","A data prevista de entrega não é válida.");
      const paid = body.paymentStatus === "paid";
      const now = new Date().toISOString();
      const token = randomToken();
      const { data: order, error: orderError } = await client.from("orders").insert({
        source: "catalog",
        order_status: paid ? "confirmed" : "draft",
        payment_status: paid ? "paid" : "unpaid",
        payment_provider: "manual",
        sales_channel: channel,
        expected_delivery_date: expectedDeliveryDate,
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
        manual_received_amount: paid ? totalAmount : 0,
        access_token_hash: await sha256(token),
      }).select("id,order_number,total_amount").single();
      if (orderError || !order) throw orderError || new Error("Could not create manual order");

      // O valor introduzido no painel é o total acordado para a quantidade
      // completa. Nem sempre há um preço unitário exato em cêntimos.
      const { error: itemError } = await client.from("order_items").insert(manualItems.map((item:any)=>({
        order_id:order.id, product_code:"MANUAL", variant_code:"PERSONALIZADO",
        name:item.description, quantity:item.quantity, unit_amount:Math.round(item.lineAmount/item.quantity),
        line_amount:item.lineAmount, personalization:{},
        product_snapshot:{manual:true,priceType:"negotiated_total",description:item.description,quantity:item.quantity},
      })));
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

    // Pagamentos manuais parciais: registo acumulado, independente da produção.
    if (action === "set-manual-payment") {
      if (admin.role === "viewer") throw new ApiError(403, "forbidden", "Não tens permissão para alterar pagamentos.");
      const id = cleanText(body.id, 80, true)!;
      const received = Number(body.receivedAmount);
      const fullyPaid = body.fullyPaid === true;
      const method = cleanText(body.paymentMethod, 80) || "outro";
      if (!Number.isSafeInteger(received) || received < 0 || received > 100000000) throw new ApiError(422, "invalid_amount", "Indica um valor recebido válido.");
      if (!["mbway","transferencia","numerario","outro"].includes(method)) throw new ApiError(422, "invalid_method", "Método de pagamento inválido.");
      const { data: before, error: readError } = await client.from("orders")
        .select("id,order_status,payment_provider,payment_status,paid_at,total_amount,manual_received_amount,sales_channel")
        .eq("id", id).single();
      if (readError || !before) throw new ApiError(404, "order_not_found", "A encomenda não foi encontrada.");
      if (before.payment_provider !== "manual") throw new ApiError(403, "stripe_locked", "Os pagamentos Stripe não podem ser alterados aqui.");
      const total = Number(before.total_amount);
      const previous = Number(before.manual_received_amount || 0);
      if (received > total) throw new ApiError(422, "amount_exceeds_total", "O recebido não pode superar o total do pedido.");
      if (before.payment_status === "paid") {
        if (fullyPaid && received === total) return json(req, { ok: true, receivedAmount: received, paymentStatus: "paid" });
        throw new ApiError(409, "already_paid", "Este pedido já está totalmente pago.");
      }
      if (before.payment_status !== "unpaid") throw new ApiError(409, "payment_locked", "O pagamento está bloqueado.");
      if (fullyPaid && received !== total) throw new ApiError(422, "amount_mismatch", "O valor total deve estar recebido para marcar como pago.");
      if (!fullyPaid && received === total && total > 0) throw new ApiError(422, "stage_mismatch", "Seleciona Pago quando o valor estiver totalmente recebido.");
      if (received < previous && body.confirmReduction !== true) throw new ApiError(409, "confirm_correction", "Confirma a redução do valor recebido.");
      const { data: priorPayments, error: priorError } = await client.from("payments").select("id").eq("order_id", id);
      if (priorError) throw priorError;
      if (priorPayments?.length) throw new ApiError(409, "payment_exists", "Já existe um pagamento processado nesta encomenda.");
      if (received === previous && !fullyPaid) return json(req, { ok: true, receivedAmount: received, paymentStatus: "unpaid" });
      const patch = { manual_received_amount: received,
        ...(fullyPaid ? { payment_status: "paid", paid_at: new Date().toISOString() } : {}) };
      const { data: updated, error: updateError } = await client.from("orders").update(patch)
        .eq("id", id).eq("payment_status", "unpaid").eq("manual_received_amount", previous).select("id").maybeSingle();
      if (updateError) throw updateError;
      if (!updated) throw new ApiError(409, "payment_changed", "O pagamento foi alterado entretanto. Atualiza o painel.");
      if (fullyPaid) {
        const { error: paymentError } = await client.from("payments").insert({
          order_id: id, provider: "manual", status: "paid", currency: "eur", gross_amount: total,
          processing_fee_amount: 0, net_amount: total, refunded_amount: 0, payment_method_type: "manual",
          provider_data: { recordedByAdmin: true, method, receivedBeforeSettlement: previous, salesChannel: before.sales_channel },
        });
        if (paymentError) {
          await client.from("orders").update({ manual_received_amount: previous, payment_status: "unpaid",
            paid_at: null }).eq("id", id).eq("manual_received_amount", received);
          throw paymentError;
        }
      }
      await client.from("order_status_history").insert({
        order_id: id, order_status: patch.order_status || before.order_status, payment_status: fullyPaid ? "paid" : "unpaid",
        note: fullyPaid ? "Pagamento manual integral confirmado" : "Montante recebido atualizado: " + (received / 100).toFixed(2) + " EUR",
        actor_user_id: admin.userId,
      });
      await client.from("audit_log").insert({
        actor_user_id: admin.userId, action: "order.manual.payment_update", entity_type: "order", entity_id: id,
        before_data: { payment_status: before.payment_status, manual_received_amount: previous },
        after_data: { payment_status: fullyPaid ? "paid" : "unpaid", manual_received_amount: received, method },
      });
      return json(req, { ok: true, paymentStatus: fullyPaid ? "paid" : "unpaid", receivedAmount: received });
    }

    // Edição reservada às encomendas manuais; pagamentos Stripe nunca são alterados.
    if (action === "edit-manual-order") {
      if (admin.role === "viewer") throw new ApiError(403, "forbidden", "Não tens permissão para editar encomendas.");
      const id = cleanText(body.id, 80, true)!;
      const { data: before, error: beforeError } = await client.from("orders")
        .select("id,payment_provider,payment_status,paid_at,order_status,total_amount,manual_received_amount,customer_name,customer_email,customer_phone,sales_channel,notes")
        .eq("id", id).single();
      if (beforeError || !before) throw new ApiError(404, "order_not_found", "A encomenda não foi encontrada.");
      if (before.payment_provider !== "manual") throw new ApiError(403, "stripe_order", "Só é possível editar encomendas manuais neste formulário.");
      const customerName = cleanText(body.customerName, 160, true)!;
      const customerEmail = cleanText(body.customerEmail, 254);
      if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) throw new ApiError(422, "invalid_email", "O email indicado não é válido.");
      const customerPhone = cleanText(body.customerPhone, 50);
      const notes = cleanText(body.notes, 3000);
      const channel = cleanText(body.channel, 20, true)!;
      if (!["instagram", "whatsapp", "other"].includes(channel)) throw new ApiError(422, "invalid_channel", "Canal inválido.");
      const rawItems = Array.isArray(body.items) ? body.items : [{description:body.description,quantity:body.quantity,lineAmount:body.totalAmount}];
      if (!rawItems.length || rawItems.length > 50) throw new ApiError(422,"items","São permitidos 1 a 50 artigos.");
      const manualItems = rawItems.map((entry: any) => {
        const description = cleanText(entry.description,240,true)!;
        const quantity = Number(entry.quantity), lineAmount = Number(entry.lineAmount);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000 || !Number.isSafeInteger(lineAmount) || lineAmount < 0 || lineAmount > 100000000)
          throw new ApiError(422,"invalid_items","Verifica a quantidade e o valor de cada artigo.");
        return {description,quantity,lineAmount};
      });
      const sum = manualItems.reduce((t:number,x:any)=>t+x.lineAmount,0);

      const totalAmount = Number(body.totalAmount);
      if (sum !== totalAmount) throw new ApiError(422,"total_mismatch","O total não coincide com a soma dos artigos.");
      if (!Number.isSafeInteger(totalAmount) || totalAmount < 0 || totalAmount > 100000000) throw new ApiError(422, "invalid_total", "Total inválido.");
      const expectedDeliveryDate = body.expectedDeliveryDate == null || body.expectedDeliveryDate === "" ? null : String(body.expectedDeliveryDate);
      if (expectedDeliveryDate && (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDeliveryDate) || !Number.isFinite(Date.parse(expectedDeliveryDate)) || new Date(expectedDeliveryDate).toISOString().slice(0,10) !== expectedDeliveryDate))
        throw new ApiError(422,"invalid_expected_delivery_date","A data prevista de entrega não é válida.");
      const markPaid = body.markPaid === true;
      const alreadyPaid = before.payment_status === "paid";
      if (!alreadyPaid && before.payment_status !== "unpaid") throw new ApiError(409, "payment_locked", "Este pagamento não pode ser alterado manualmente.");
      if (alreadyPaid && Number(before.total_amount) !== totalAmount) throw new ApiError(409, "paid_total_locked", "Não é possível alterar o valor de uma encomenda já paga.");
      if (totalAmount < Number(before.manual_received_amount || 0)) throw new ApiError(409, "partial_total_locked", "O total não pode ser inferior ao valor já recebido.");
      const { data: items, error: itemsError } = await client.from("order_items").select("id").eq("order_id", id).order("id", { ascending: true });
      if (itemsError) throw itemsError;
      if (!items?.length) throw new ApiError(409, "items_locked", "Não existem artigos editáveis.");
      const { data: existingPayments, error: paymentsError } = await client.from("payments").select("id,provider,status").eq("order_id", id);
      if (paymentsError) throw paymentsError;
      if (!alreadyPaid && existingPayments?.length) throw new ApiError(409, "payment_locked", "Já existe um registo de pagamento associado. A edição do pagamento foi bloqueada.");
      const paidNow = markPaid && !alreadyPaid;
      const paidAt = paidNow ? new Date().toISOString() : before.paid_at;
      const patch = {
        customer_name: customerName,
        customer_email: customerEmail?.toLowerCase() || null,
        customer_phone: customerPhone,
        sales_channel: channel,
        expected_delivery_date: expectedDeliveryDate,
        notes,
        subtotal_amount: totalAmount,
        total_amount: totalAmount,
        ...(paidNow ? { payment_status: "paid", paid_at: paidAt, manual_received_amount: totalAmount, order_status: before.order_status === "draft" || before.order_status === "awaiting_payment" ? "confirmed" : before.order_status } : {}),
      };
      const { error: updateError } = await client.from("orders").update(patch).eq("id", id);
      if (updateError) throw updateError;
      for (let i=0;i<manualItems.length;i++){
        const item=manualItems[i], data={
          name:item.description,quantity:item.quantity,unit_amount:Math.round(item.lineAmount/item.quantity),
          line_amount:item.lineAmount,
          product_snapshot:{manual:true,priceType:"negotiated_total",description:item.description,quantity:item.quantity},
        };
        const {error:itemError}=i<items.length
          ? await client.from("order_items").update(data).eq("id",items[i].id)
          : await client.from("order_items").insert({...data,order_id:id,product_code:"MANUAL",variant_code:"PERSONALIZADO",personalization:{}});
        if(itemError) throw itemError;
      }
      if(items.length>manualItems.length){
        const {error:removeError}=await client.from("order_items").delete().in("id",items.slice(manualItems.length).map((item:any)=>item.id));
        if(removeError) throw removeError;
      }
      if (paidNow) {
        const { error: paymentError } = await client.from("payments").insert({
          order_id: id, provider: "manual", status: "paid", currency: "eur",
          gross_amount: totalAmount, processing_fee_amount: 0, net_amount: totalAmount,
          refunded_amount: 0, payment_method_type: "manual",
          provider_data: { salesChannel: channel, recordedByAdmin: true, method: cleanText(body.paymentMethod, 80) || "outro" },
        });
        if (paymentError) throw paymentError;
        await client.from("order_status_history").insert({
          order_id: id, order_status: patch.order_status || before.order_status,
          payment_status: "paid", note: "Pagamento manual confirmado no painel",
          actor_user_id: admin.userId,
        });
      }
      await client.from("audit_log").insert({
        actor_user_id: admin.userId, action: "order.manual.edit", entity_type: "order",
        entity_id: id, before_data: before,
        after_data: { ...patch, items: manualItems, payment_method: paidNow ? cleanText(body.paymentMethod, 80) || "outro" : null },
      });
      return json(req, { ok: true, paymentStatus: paidNow || alreadyPaid ? "paid" : "unpaid" });
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
