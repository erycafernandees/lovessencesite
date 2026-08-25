import { ApiError, handleError, hasValidMagic, json, PRIVATE_BUCKET, readJson, serviceClient, sha256, verifyAccessToken } from "../_shared/core.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json(req, {}, 204);
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  try {
    const body = await readJson<{ attachmentId?: string; ownerToken?: string }>(req);
    const client = serviceClient();
    const { data: attachment, error } = await client.from("attachments")
      .select("id,object_path,mime_type,size_bytes,status,order_id,project_request_id,orders(access_token_hash,access_token_expires_at),project_requests(access_token_hash,access_token_expires_at)")
      .eq("id", body.attachmentId || "").single();
    if (error || !attachment) throw new ApiError(404, "attachment_not_found", "O ficheiro não foi encontrado.");
    if (attachment.status === "verified") return json(req, { ok: true });
    const owner = attachment.order_id ? attachment.orders : attachment.project_requests;
    await verifyAccessToken(owner.access_token_hash, owner.access_token_expires_at, body.ownerToken);
    const { data: blob, error: downloadError } = await client.storage.from(PRIVATE_BUCKET).download(attachment.object_path);
    if (downloadError || !blob) throw new ApiError(422, "upload_missing", "O ficheiro ainda não foi carregado.");
    if (blob.size !== Number(attachment.size_bytes) || blob.size > 10 * 1024 * 1024) {
      await client.storage.from(PRIVATE_BUCKET).remove([attachment.object_path]);
      await client.from("attachments").update({ status: "rejected", rejection_reason: "size_mismatch" }).eq("id", attachment.id);
      throw new ApiError(422, "invalid_file_size", "O tamanho do ficheiro não corresponde ao declarado.");
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!hasValidMagic(bytes, attachment.mime_type)) {
      await client.storage.from(PRIVATE_BUCKET).remove([attachment.object_path]);
      await client.from("attachments").update({ status: "rejected", rejection_reason: "content_mismatch" }).eq("id", attachment.id);
      throw new ApiError(422, "invalid_file_content", "O conteúdo do ficheiro não corresponde a JPG, PNG ou PDF.");
    }
    await client.from("attachments").update({ status: "verified", sha256: await sha256(bytes), verified_at: new Date().toISOString() }).eq("id", attachment.id);
    return json(req, { ok: true });
  } catch (error) { return handleError(req, error); }
});

