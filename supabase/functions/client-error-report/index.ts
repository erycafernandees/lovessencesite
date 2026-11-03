import { ApiError, enforceRateLimit, handleError, json, queueEmail, readJson, serviceClient } from "../_shared/core.ts";

const ALLOWED_ORIGINS = new Set(["https://love-essences.pt", "https://www.love-essences.pt"]);
const CATEGORIES = new Set(["form_submit", "checkout", "upload", "script_error", "promise_rejection"]);
const AREAS = new Set(["contact", "cart", "checkout", "shop", "other"]);

// Only report functional areas, never names, emails, URLs, IPs, messages, stacks or order data.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json(req, {}, 204);
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);

  try {
    const origin = req.headers.get("origin") || "";
    if (!ALLOWED_ORIGINS.has(origin)) throw new ApiError(403, "invalid_origin", "Origem não autorizada.");
    const body = await readJson<{ category?: unknown; area?: unknown }>(req);
    if (typeof body?.category !== "string" || !CATEGORIES.has(body.category) ||
        typeof body?.area !== "string" || !AREAS.has(body.area)) {
      throw new ApiError(422, "invalid_event", "Evento de monitorização inválido.");
    }

    await enforceRateLimit(req, "client_error_report", 6, 60);
    const client = serviceClient();
    const { error: writeError } = await client.from("site_error_events")
      .insert({ category: body.category, area: body.area });
    if (writeError) throw writeError;

    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count, error: countError } = await client.from("site_error_events")
      .select("id", { head: true, count: "exact" })
      .eq("category", body.category).gte("created_at", since);
    if (countError) throw countError;

    // Alert only for recurring errors, and at most once per category and UTC day.
    if ((count || 0) >= 3) {
      const today = new Date().toISOString().slice(0, 10);
      const { error: lockError } = await client.from("site_alert_locks")
        .insert({ category: body.category, alert_day: today });
      if (!lockError) {
        const adminEmail = Deno.env.get("ADMIN_NOTIFICATION_EMAIL");
        if (adminEmail) {
          try { await queueEmail("site_error_alert", adminEmail, { category: body.category }); }
          catch (error) { console.error("Site error alert could not be sent", error); }
        }
      } else if (lockError.code !== "23505") {
        console.error("Site error alert lock failed", lockError);
      }
    }

    return json(req, { received: true }, 202);
  } catch (error) { return handleError(req, error); }
});
