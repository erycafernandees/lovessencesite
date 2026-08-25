import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import Stripe from "npm:stripe@22.5.0";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "application/pdf"]);
export const PRIVATE_BUCKET = "private-references";

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function allowedOrigins(): string[] {
  return (Deno.env.get("ALLOWED_ORIGINS") || "http://127.0.0.1:4176,http://localhost:4176")
    .split(",").map((value) => value.trim()).filter(Boolean);
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowed = allowedOrigins();
  const selected = allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": selected,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function handleError(req: Request, error: unknown): Response {
  if (error instanceof ApiError) return json(req, { error: error.code, message: error.message }, error.status);
  console.error(error);
  return json(req, { error: "internal_error", message: "Não foi possível concluir o pedido." }, 500);
}

export async function readJson<T>(req: Request): Promise<T> {
  if (!req.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "invalid_content_type", "É necessário enviar JSON.");
  }
  try { return await req.json() as T; }
  catch { throw new ApiError(400, "invalid_json", "O pedido contém JSON inválido."); }
}

export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase service environment is not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function stripeClient(): Stripe {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
  return new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
}

export function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function cleanText(value: unknown, max: number, required = false): string | null {
  const cleaned = typeof value === "string" ? value.trim().replace(/[\u0000-\u001f\u007f]/g, " ") : "";
  if (required && !cleaned) throw new ApiError(422, "required_field", "Falta preencher um campo obrigatório.");
  if (cleaned.length > max) throw new ApiError(422, "field_too_long", "Um dos campos ultrapassa o limite permitido.");
  return cleaned || null;
}

export function validEmail(value: unknown): string {
  const email = cleanText(value, 254, true)!.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(422, "invalid_email", "Indica um endereço de email válido.");
  return email;
}

export type UploadDescriptor = { name: string; type: string; size: number; lineKey?: string };

export function validateUploads(input: unknown, maximum: number): UploadDescriptor[] {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > maximum) throw new ApiError(422, "too_many_files", `Podes enviar até ${maximum} ficheiros.`);
  return input.map((raw) => {
    const item = raw as Record<string, unknown>;
    const name = cleanText(item.name, 180, true)!;
    const type = String(item.type || "").toLowerCase();
    const size = Number(item.size);
    if (!ALLOWED_MIME.has(type)) throw new ApiError(422, "invalid_file_type", "Apenas são aceites ficheiros JPG, PNG e PDF.");
    if (!Number.isInteger(size) || size < 1 || size > MAX_FILE_BYTES) throw new ApiError(422, "invalid_file_size", "Cada ficheiro pode ter no máximo 10 MB.");
    return { name, type, size, lineKey: cleanText(item.lineKey, 80) || undefined };
  });
}

export async function enforceRateLimit(req: Request, action: string, maximum: number, windowMinutes: number): Promise<void> {
  const client = serviceClient();
  const address = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
  const hash = await sha256(`${Deno.env.get("RATE_LIMIT_SALT") || "local-development"}:${address}`);
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const { count, error } = await client.from("api_requests").select("id", { count: "exact", head: true })
    .eq("action", action).eq("client_hash", hash).gte("created_at", since);
  if (error) throw error;
  if ((count || 0) >= maximum) throw new ApiError(429, "rate_limited", "Foram feitos demasiados pedidos. Tenta novamente mais tarde.");
  const { error: insertError } = await client.from("api_requests").insert({ action, client_hash: hash });
  if (insertError) throw insertError;
}

export async function verifyTurnstile(token: unknown, req: Request): Promise<void> {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) return;
  if (typeof token !== "string" || !token) throw new ApiError(422, "turnstile_required", "Confirma que não és um pedido automatizado.");
  const form = new FormData();
  form.set("secret", secret);
  form.set("response", token);
  const ip = req.headers.get("cf-connecting-ip");
  if (ip) form.set("remoteip", ip);
  const result = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const data = await result.json() as { success?: boolean };
  if (!data.success) throw new ApiError(422, "turnstile_failed", "Não foi possível validar o pedido. Atualiza a página e tenta novamente.");
}

export async function requireAdmin(req: Request, roles = ["owner", "manager", "viewer"]): Promise<{ userId: string; role: string }> {
  const authorization = req.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new ApiError(401, "unauthorized", "Inicia sessão para continuar.");
  const token = authorization.slice(7);
  const admin = serviceClient();
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  if (authError || !authData.user) throw new ApiError(401, "unauthorized", "A sessão já não é válida.");
  const payload = token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
  const paddedPayload = payload + "=".repeat((4 - payload.length % 4) % 4);
  const aal = (JSON.parse(atob(paddedPayload)) as Record<string, unknown>).aal || null;
  if (aal !== "aal2") throw new ApiError(403, "mfa_required", "Ativa e confirma a autenticação de dois fatores.");
  const { data, error } = await admin.from("admin_users").select("role,active").eq("user_id", authData.user.id).maybeSingle();
  if (error || !data?.active || !roles.includes(data.role)) throw new ApiError(403, "forbidden", "Não tens permissão para esta operação.");
  return { userId: authData.user.id, role: data.role };
}

export async function verifyAccessToken(expectedHash: string, expiresAt: string, token: unknown): Promise<void> {
  if (typeof token !== "string" || !token || await sha256(token) !== expectedHash) throw new ApiError(403, "invalid_access_token", "O acesso a este pedido não é válido.");
  if (new Date(expiresAt).getTime() < Date.now()) throw new ApiError(410, "expired_access_token", "Este acesso expirou.");
}

export function hasValidMagic(bytes: Uint8Array, mime: string): boolean {
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/png") return bytes.slice(0, 8).every((v, i) => v === [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a][i]);
  if (mime === "application/pdf") return new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";
  return false;
}

export async function queueEmail(template: string, recipient: string, payload: Record<string, unknown>): Promise<void> {
  const client = serviceClient();
  const { data: queued, error } = await client.from("notification_outbox").insert({ channel: "email", template, recipient, payload }).select("id").single();
  if (error || !queued) throw error || new Error("Could not queue email");
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return;
  const subjects: Record<string, string> = {
    order_paid: `Encomenda ${payload.orderNumber || ""} confirmada — Love Essences`,
    project_received: `Recebemos o teu pedido ${payload.projectNumber || ""} — Love Essences`,
    admin_order_paid: `Nova encomenda paga ${payload.orderNumber || ""}`,
    admin_project_received: `Novo projeto personalizado ${payload.projectNumber || ""}`,
    quote_ready: `A tua proposta Love Essences ${payload.projectNumber || ""}`,
  };
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: Deno.env.get("EMAIL_FROM") || "Love Essences <encomendas@love-essences.pt>",
      to: [recipient],
      subject: subjects[template] || "Love Essences",
      html: emailHtml(template, payload),
    }),
  });
  const responseBody = await response.json().catch(() => ({})) as { id?: string; message?: string };
  const update = response.ok
    ? { provider_message_id: responseBody.id || null, sent_at: new Date().toISOString(), attempts: 1 }
    : { last_error: responseBody.message || `HTTP ${response.status}`, attempts: 1 };
  await client.from("notification_outbox").update(update).eq("id", queued.id);
}

function emailHtml(template: string, payload: Record<string, unknown>): string {
  const number = String(payload.orderNumber || payload.projectNumber || "");
  const isQuote = template === "quote_ready";
  const title = isQuote ? "A tua proposta está pronta" : template.includes("project") ? "Recebemos a tua ideia" : "Pagamento confirmado";
  const body = isQuote
    ? "Consulta todos os detalhes da proposta. O checkout seguro só será criado depois de confirmares a aprovação."
    : template.includes("project")
      ? "Vamos analisar o teu pedido e entrar em contacto contigo antes de preparar qualquer orçamento ou pagamento."
      : "A tua encomenda já está confirmada. Se precisarmos de validar algum detalhe da personalização, entraremos em contacto contigo.";
  const action = isQuote && typeof payload.quoteUrl === "string" ? `<p style="margin:28px 0"><a href="${payload.quoteUrl}" style="display:inline-block;padding:13px 22px;border-radius:6px;background:#66135e;color:#fff;text-decoration:none">Consultar e aprovar proposta</a></p>` : "";
  return `<!doctype html><html lang="pt"><body style="margin:0;background:#f8f3f7;font-family:Arial,sans-serif;color:#3f073a"><div style="max-width:620px;margin:auto;padding:36px"><div style="background:#fff;border-radius:20px;padding:36px"><p style="color:#b468ab;letter-spacing:.14em;text-transform:uppercase;font-size:12px">Love Essences</p><h1 style="font-family:Georgia,serif;font-weight:400">${title}</h1><p style="line-height:1.7">${body}</p><p style="line-height:1.7"><strong>Referência:</strong> ${number}</p>${action}<p style="color:#765c73;font-size:13px">Esta mensagem foi enviada automaticamente. Podes responder a este email se precisares de ajuda.</p></div></div></body></html>`;
}

export async function createSignedUploads(
  descriptors: UploadDescriptor[],
  owner: { orderId?: string; projectId?: string; itemIdsByKey?: Record<string, string> },
): Promise<Array<{ attachmentId: string; path: string; token: string }>> {
  if (!descriptors.length) return [];
  const client = serviceClient();
  const ownerFolder = owner.orderId ? `orders/${owner.orderId}` : `projects/${owner.projectId}`;
  const rows = descriptors.map((file) => ({
    order_id: owner.orderId || null,
    order_item_id: file.lineKey ? owner.itemIdsByKey?.[file.lineKey] || null : null,
    project_request_id: owner.projectId || null,
    object_path: `${ownerFolder}/${crypto.randomUUID()}`,
    original_name: file.name,
    mime_type: file.type,
    size_bytes: file.size,
  }));
  const { data, error } = await client.from("attachments").insert(rows).select("id,object_path");
  if (error) throw error;
  const output = [];
  for (const attachment of data || []) {
    const { data: signed, error: signError } = await client.storage.from(PRIVATE_BUCKET).createSignedUploadUrl(attachment.object_path);
    if (signError || !signed) throw signError || new Error("Could not sign upload");
    output.push({ attachmentId: attachment.id, path: attachment.object_path, token: signed.token });
  }
  return output;
}
