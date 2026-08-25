import { ApiError, cleanText, createSignedUploads, enforceRateLimit, handleError, json, queueEmail, randomToken, readJson, serviceClient, sha256, validEmail, validateUploads, verifyAccessToken, verifyTurnstile } from "../_shared/core.ts";

type ProjectPayload = {
  action?: "prepare" | "finalize";
  projectId?: string;
  projectToken?: string;
  name?: string;
  email?: string;
  phone?: string;
  occasion?: string;
  projectType?: string;
  approximateQuantity?: string;
  eventDate?: string;
  approximateBudget?: string;
  idea?: string;
  attachments?: Array<{ name: string; type: string; size: number }>;
  privacyAccepted?: boolean;
  turnstileToken?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json(req, {}, 204);
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  try {
    const body = await readJson<ProjectPayload>(req);
    const client = serviceClient();
    if (body.action === "finalize") {
      const { data: project, error } = await client.from("project_requests").select("*,attachments(id,status)").eq("id", body.projectId || "").single();
      if (error || !project) throw new ApiError(404, "project_not_found", "O pedido não foi encontrado.");
      await verifyAccessToken(project.access_token_hash, project.access_token_expires_at, body.projectToken);
      if ((project.attachments || []).some((file: { status: string }) => file.status !== "verified")) throw new ApiError(422, "unverified_files", "Confirma o envio de todos os ficheiros.");
      if (project.status === "draft") {
        await client.from("project_requests").update({ status: "submitted" }).eq("id", project.id);
        await client.from("project_status_history").insert({ project_request_id: project.id, status: "submitted", note: "Pedido submetido pela cliente" });
        await queueEmail("project_received", project.customer_email, { projectNumber: project.project_number });
        const adminEmail = Deno.env.get("ADMIN_NOTIFICATION_EMAIL");
        if (adminEmail) await queueEmail("admin_project_received", adminEmail, { projectNumber: project.project_number });
      }
      return json(req, { ok: true, projectNumber: project.project_number });
    }

    await enforceRateLimit(req, "project_submit", 6, 60);
    await verifyTurnstile(body.turnstileToken, req);
    if (!body.privacyAccepted) throw new ApiError(422, "privacy_required", "É necessário aceitar a Política de Privacidade.");
    const allowedOccasions = ["Casamento","Batizado","Aniversário","Comunhão","Baby Shower","Empresa","Outro"];
    const allowedTypes = ["Lembranças","Presentes","Sabonetes","Velas","Difusores","Papelaria/embalagem","Conjunto personalizado","Outro"];
    const occasion = cleanText(body.occasion, 80, true)!;
    const projectType = cleanText(body.projectType, 100, true)!;
    if (!allowedOccasions.includes(occasion) || !allowedTypes.includes(projectType)) throw new ApiError(422, "invalid_option", "Seleciona opções válidas para o projeto.");
    const uploads = validateUploads(body.attachments, 5);
    const eventDate = body.eventDate ? new Date(`${body.eventDate}T00:00:00Z`) : null;
    if (eventDate && Number.isNaN(eventDate.getTime())) throw new ApiError(422, "invalid_date", "A data do evento não é válida.");
    const token = randomToken();
    const { data: project, error } = await client.from("project_requests").insert({
      customer_name: cleanText(body.name, 140, true), customer_email: validEmail(body.email), customer_phone: cleanText(body.phone, 40),
      occasion, project_type: projectType, approximate_quantity: cleanText(body.approximateQuantity, 120),
      event_date: body.eventDate || null, approximate_budget: cleanText(body.approximateBudget, 120), idea: cleanText(body.idea, 4000, true),
      access_token_hash: await sha256(token), consent_at: new Date().toISOString(),
    }).select("id,project_number").single();
    if (error || !project) throw error || new Error("Could not create project");
    const signedUploads = await createSignedUploads(uploads, { projectId: project.id });
    if (!signedUploads.length) {
      await client.from("project_requests").update({ status: "submitted" }).eq("id", project.id);
      await client.from("project_status_history").insert({ project_request_id: project.id, status: "submitted", note: "Pedido submetido pela cliente" });
      await queueEmail("project_received", validEmail(body.email), { projectNumber: project.project_number });
      const adminEmail = Deno.env.get("ADMIN_NOTIFICATION_EMAIL");
      if (adminEmail) await queueEmail("admin_project_received", adminEmail, { projectNumber: project.project_number });
    }
    return json(req, { projectId: project.id, projectNumber: project.project_number, projectToken: token, uploads: signedUploads, submitted: !signedUploads.length });
  } catch (error) { return handleError(req, error); }
});

