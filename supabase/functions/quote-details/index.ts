import { ApiError, handleError, json, serviceClient, verifyAccessToken } from "../_shared/core.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json(req, {}, 204);
  if (req.method !== "GET") return json(req, { error: "method_not_allowed" }, 405);
  try {
    const url = new URL(req.url);
    const quoteId = url.searchParams.get("quote") || "";
    const token = url.searchParams.get("token") || "";
    const { data: quote, error } = await serviceClient().from("quotes")
      .select("id,version,status,currency,subtotal_amount,discount_amount,shipping_amount,total_amount,notes,valid_until,access_token_hash,access_token_expires_at,quote_items(description,quantity,unit_amount,line_amount),project_requests(project_number,occasion,project_type)")
      .eq("id", quoteId).single();
    if (error || !quote) throw new ApiError(404, "quote_not_found", "A proposta não foi encontrada.");
    await verifyAccessToken(quote.access_token_hash, quote.access_token_expires_at, token);
    if (!["sent","approved","paid"].includes(quote.status)) throw new ApiError(409, "quote_unavailable", "Esta proposta já não está disponível.");
    return json(req, {
      id: quote.id, version: quote.version, status: quote.status, currency: quote.currency,
      subtotalAmount: quote.subtotal_amount, discountAmount: quote.discount_amount,
      shippingAmount: quote.shipping_amount, totalAmount: quote.total_amount,
      notes: quote.notes, validUntil: quote.valid_until, items: quote.quote_items,
      projectNumber: quote.project_requests.project_number,
      occasion: quote.project_requests.occasion, projectType: quote.project_requests.project_type,
    });
  } catch (error) { return handleError(req, error); }
});

