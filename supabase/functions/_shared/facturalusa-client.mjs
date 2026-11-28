// Preview only: no fiscal issuance, no email, no customer data.
import { planSandboxInvoice } from "./facturalusa-sandbox.mjs";
export async function previewSandboxInvoice(input, { token, fetcher = fetch } = {}) {
  if (typeof token !== "string" || !token.trim()) throw new Error("Sandbox credential required");
  if (input.priorInvoice) throw new Error("Final invoice adjustment requires verified fiscal workflow");
  const plan = planSandboxInvoice(input);
  const {items, document_type, vat_type} = plan.payload;
  const response = await fetcher("https://facturalusa.pt/api/v2/sales/summary", {
    method:"POST", redirect:"error",
    headers:{Authorization:"Bearer "+token, Accept:"application/json", "Content-Type":"application/json"},
    body:JSON.stringify({items,document_type,vat_type})
  });
  if (!response.ok) throw new Error("Facturalusa summary failed: "+response.status);
  const result=await response.json();
  const total=Number(result.grand_total);
  if (!Number.isFinite(total)||Math.round(total*100)!==plan.amountCents) throw new Error("Unexpected invoice total");
  if (result.total_vat==null||Number(result.total_vat)!==0) throw new Error("Unexpected VAT");
  return {phase:plan.phase, amountCents:plan.amountCents, series:62439, preview:true};
}
