// Sandbox-only payload planner. Does not issue documents or contact customers.
export const SERIES_ID = 62439;
export function planSandboxInvoice(input) {
  const {orderRef, totalCents, paidCents, priorInvoice, customerId, articleId, issueDate, lines} = input;
  if (!/^TEST-[A-Za-z0-9-]{1,60}$/.test(orderRef)) throw Error("Use a synthetic TEST order");
  if (![totalCents,paidCents].every(Number.isSafeInteger)||totalCents<=0||paidCents<=0||paidCents>totalCents) throw Error("Invalid amounts");
  if (!Number.isSafeInteger(customerId)||customerId<=0||!Number.isSafeInteger(articleId)||articleId<=0) throw Error("Sandbox customer and article IDs required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) throw Error("Issue date required");
  const deposit = Math.round(totalCents/2);
  if (priorInvoice && (!/^FS LE\/\d+$/.test(priorInvoice.number)||priorInvoice.amountCents!==deposit||paidCents!==totalCents)) throw Error("Invalid previous deposit");
  if (!priorInvoice && paidCents!==deposit && paidCents!==totalCents) throw Error("Only 50% or full payment");
  const phase=priorInvoice?"final":paidCents===totalCents?"full":"deposit";
  const amount=paidCents-(priorInvoice?.amountCents??0);
  if(amount<=0) throw Error("No remaining amount");
  const item=(id,details,cents,quantity=1)=>({id,details,price:cents/100,quantity,vat:0,vat_exemption:"M10"});
  let items;
  if(phase==="deposit") items=[item(articleId,"Adiantamento de 50% - "+orderRef,amount)];
  else {
    if(!Array.isArray(lines)||!lines.length||lines.length>100) throw Error("Actual product lines required");
    if(lines.some(l=>!Number.isSafeInteger(l.id)||l.id<=0||!Number.isSafeInteger(l.unitCents)||l.unitCents<=0||!Number.isSafeInteger(l.quantity)||l.quantity<=0||typeof l.description!=="string"||!l.description.trim()||l.description.length>255)) throw Error("Invalid item");
    if(lines.reduce((sum,l)=>sum+l.unitCents*l.quantity,0)!==totalCents) throw Error("Product total mismatch");
    items=lines.map(l=>item(l.id,l.description,l.unitCents,l.quantity));
  }
  return {phase,amountCents:amount,duplicateKey:orderRef+":"+phase,payload:{issue_date:issueDate,document_type:"Factura Simplificada",serie:SERIES_ID,customer:customerId,vat_number:"999999990",address:"Desconhecido",city:"Desconhecido",postal_code:"Desconhecido",country:"Portugal",vat_type:"Não fazer nada",observations:orderRef+(priorInvoice?" | Adiantamento documentado em "+priorInvoice.number:""),items, ...(priorInvoice?{final_discount_financial:priorInvoice.amountCents/100}:{}),status:"Rascunho",language:"PT",format:"A4",force_send_email:false,force_send_sms:false}};
}
