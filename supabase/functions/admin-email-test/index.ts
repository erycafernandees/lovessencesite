
import { handleError, json, requireAdmin } from "../_shared/core.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json(req, {}, 204);
  if (req.method !== "POST") {
    return new Response("Método não permitido", { status: 405 });
  }

  try {
  await requireAdmin(req, ["owner", "manager"]);
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const recipient = Deno.env.get("ADMIN_NOTIFICATION_EMAIL");
  const from = Deno.env.get("EMAIL_FROM");

  if (!apiKey || !recipient || !from) {
    return Response.json(
      { error: "Falta configurar um dos secrets de e-mail." },
      { status: 500 }
    );
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      reply_to: "love-essences@outlook.com",
      from,
      to: [recipient],
      subject: "Teste de notificações — Love Essences",
      html: `
        <div style="font-family:Arial,sans-serif;padding:24px">
          <h2 style="color:#75166d">Love Essences ♡</h2>
          <p>O envio de e-mails está a funcionar!</p>
          <p>Esta é uma mensagem de teste, não uma encomenda real.</p>
        </div>
      `,
    }),
  });

  const result = await response.json();

  return Response.json(
    {
      success: response.ok,
      message: response.ok
        ? "E-mail aceite pelo Resend."
        : "Falha no envio.",
      result: response.ok ? { id: result.id } : result,
    },
    { status: response.ok ? 200 : 502 }
  );
  } catch (error) { return handleError(req, error); }
});
