import { ApiError, cleanText, createSignedUploads, enforceRateLimit, handleError, json, randomToken, readJson, serviceClient, sha256, validateUploads, verifyTurnstile } from "../_shared/core.ts";

type CartItem = {
  lineKey: string;
  productCode: string;
  variantCode: string;
  quantity: number;
  personalization?: Record<string, unknown>;
  addonCodes?: string[];
  attachments?: Array<{ name: string; type: string; size: number }>;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json(req, {}, 204);
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  try {
    await enforceRateLimit(req, "checkout_prepare", 12, 30);
    const body = await readJson<{ items?: CartItem[]; shippingDestination?: string; turnstileToken?: string }>(req);
    await verifyTurnstile(body.turnstileToken, req);
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 25) throw new ApiError(422, "invalid_cart", "O carrinho está vazio ou contém demasiadas linhas.");
    if ((body.shippingDestination || "mainland") !== "mainland") throw new ApiError(422, "shipping_unavailable", "Nesta fase, o checkout direto está disponível para Portugal Continental. Contacta-nos para outros destinos.");

    const client = serviceClient();
    const variantCodes = [...new Set(body.items.map((item) => cleanText(item.variantCode, 100, true)!))];
    const { data: variants, error: variantError } = await client.from("product_variants")
      .select("id,code,label,unit_amount,minimum_quantity,active,product_id,products!inner(id,code,name,image_path,active,metadata)")
      .in("code", variantCodes).eq("active", true);
    if (variantError) throw variantError;
    const variantMap = new Map((variants || []).map((variant) => [variant.code, variant]));

    const requestedAddonCodes = [...new Set(body.items.flatMap((item) => Array.isArray(item.addonCodes) ? item.addonCodes : []))];
    const addonMap = new Map<string, Record<string, unknown>>();
    if (requestedAddonCodes.length) {
      const { data: addons, error: addonError } = await client.from("product_addons").select("id,code,label,unit_amount,product_id,active").in("code", requestedAddonCodes).eq("active", true);
      if (addonError) throw addonError;
      for (const addon of addons || []) addonMap.set(addon.code, addon);
    }

    let subtotal = 0;
    let adultQty = 0;
    let childQty = 0;
    let adultSubtotal = 0;
    let childSubtotal = 0;
    const childTypes = new Set<string>();
    const normalized: Array<Record<string, unknown>> = [];
    const allUploads: Array<{ name: string; type: string; size: number; lineKey: string }> = [];

    for (const raw of body.items) {
      const lineKey = cleanText(raw.lineKey, 80, true)!;
      const productCode = cleanText(raw.productCode, 80, true)!;
      const variant = variantMap.get(raw.variantCode);
      const product = variant?.products as unknown as { id: string; code: string; name: string; image_path: string; active: boolean; metadata: Record<string, unknown> };
      const quantity = Number(raw.quantity);
      if (!variant || !product?.active || product.code !== productCode) throw new ApiError(422, "invalid_product", "Um produto do carrinho deixou de estar disponível.");
      if (!Number.isInteger(quantity) || quantity < Number(variant.minimum_quantity) || quantity > 500) throw new ApiError(422, "invalid_quantity", `A quantidade de ${product.name} não é válida.`);
      const personalization = raw.personalization && typeof raw.personalization === "object" ? raw.personalization : {};
      const serialized = JSON.stringify(personalization);
      if (serialized.length > 6000) throw new ApiError(422, "personalization_too_large", "Os dados de personalização são demasiado extensos.");
      const addonCodes = Array.isArray(raw.addonCodes) ? [...new Set(raw.addonCodes)] : [];
      let unitAmount = Number(variant.unit_amount);
      const addonSnapshot = [];
      for (const code of addonCodes) {
        const addon = addonMap.get(code) as { product_id?: string; unit_amount?: number; label?: string } | undefined;
        if (!addon || addon.product_id !== product.id) throw new ApiError(422, "invalid_addon", "Uma opção adicional não é válida para este produto.");
        unitAmount += Number(addon.unit_amount || 0);
        addonSnapshot.push({ code, label: addon.label, unitAmount: addon.unit_amount });
      }
      const lineAmount = unitAmount * quantity;
      subtotal += lineAmount;
      const group = String(product.metadata?.discount_group || "");
      if (group === "child_event") { childQty += quantity; childSubtotal += lineAmount; childTypes.add(product.code); }
      if (group === "adult_event") { adultQty += quantity; adultSubtotal += lineAmount; }
      const files = validateUploads(raw.attachments, 3);
      files.forEach((file) => allUploads.push({ ...file, lineKey }));
      normalized.push({
        line_key: lineKey, product_id: product.id, variant_id: variant.id, product_code: product.code,
        variant_code: variant.code, name: `${product.name}${variant.label === "Único" ? "" : ` (${variant.label})`}`,
        quantity, unit_amount: unitAmount, line_amount: lineAmount, personalization,
        product_snapshot: { productName: product.name, variantLabel: variant.label, imagePath: product.image_path, addons: addonSnapshot },
      });
    }

    let discount = 0;
    let promotionSnapshot: Record<string, unknown> | null = null;
    const eventSubtotal = adultSubtotal + childSubtotal;
    if (adultQty > 0 && childQty > 0 && adultQty + childQty >= 50) {
      discount = Math.round(eventSubtotal * 0.08);
      promotionSnapshot = { code: "event-adult-child", label: "Desconto lembranças adulto + infantil", percentage: 8 };
    } else if (childTypes.size >= 2) {
      discount = Math.round(childSubtotal * 0.05);
      promotionSnapshot = { code: "child-kit", label: "Desconto kit infantil", percentage: 5 };
    }
    const shipping = subtotal >= 6000 ? 0 : 590;
    const token = randomToken();
    const { data: order, error: orderError } = await client.from("orders").insert({
      source: "catalog", order_status: "draft", payment_status: "unpaid", payment_provider: "stripe",
      subtotal_amount: subtotal, discount_amount: discount, shipping_amount: shipping,
      total_amount: subtotal - discount + shipping, shipping_destination: "mainland", shipping_method: "Envio Expresso",
      access_token_hash: await sha256(token), promotion_snapshot: promotionSnapshot,
    }).select("id,order_number,total_amount").single();
    if (orderError || !order) throw orderError || new Error("Could not create order");

    const rows = normalized.map(({ line_key: _lineKey, ...row }) => ({ ...row, order_id: order.id }));
    const { data: items, error: itemsError } = await client.from("order_items").insert(rows).select("id,product_code,variant_code");
    if (itemsError) throw itemsError;
    const itemIdsByKey: Record<string, string> = {};
    normalized.forEach((line, index) => { itemIdsByKey[String(line.line_key)] = items![index].id; });
    const uploads = await createSignedUploads(allUploads, { orderId: order.id, itemIdsByKey });

    return json(req, { orderId: order.id, orderNumber: order.order_number, orderToken: token, totalAmount: order.total_amount, currency: "eur", uploads });
  } catch (error) { return handleError(req, error); }
});

