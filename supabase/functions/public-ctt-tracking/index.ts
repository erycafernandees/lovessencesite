import { enforceRateLimit, handleError, readJson, serviceClient } from "../_shared/core.ts";
const cors = {"Access-Control-Allow-Origin":"https://love-essences.pt","Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"content-type, apikey, authorization","Vary":"Origin"};
const reply=(status:number,body:unknown)=>Response.json(body,{status,headers:{...cors,"Cache-Control":"no-store"}});
const states:Record<string,string>={info_received:"Informação de envio recebida",in_transit:"Em transporte",out_for_delivery:"Em distribuição",available_for_pickup:"Disponível para levantamento",delivered:"Entregue",failed_attempt:"Tentativa de entrega",exception:"Incidência no transporte",expired:"Acompanhamento expirado",pending:"A aguardar atualização"};
Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
  if(req.method!=="POST")return reply(405,{error:"method_not_allowed"});
  if(req.headers.get("origin") && req.headers.get("origin")!=="https://love-essences.pt")return reply(403,{error:"origin_not_allowed"});
  let body:any;
  try { body=await readJson(req); await enforceRateLimit(req,"public_ctt_tracking",40,60); } catch(error) { return handleError(req,error); }
  const code=String(body?.code||"").trim().replace(/\s+/g,"").toUpperCase();
  if(!/^[A-Z]{2}[0-9]{9}[A-Z]{2}$/.test(code))return reply(422,{error:"invalid_code"});
  const db=serviceClient();
  let record:any=null;
  for(const table of ["orders","project_requests"]){
    const fields="delivery_tracking_code,delivery_tracking_status,delivery_tracking_details,delivery_tracking_updated_at,delivery_aftership_id";
    const q=await db.from(table).select(fields+(table==="orders"?",is_test":"")).eq("delivery_method","ctt").eq("delivery_tracking_code",code).limit(2);
    if(q.error)return reply(503,{error:"unavailable"});
    record=(q.data||[]).find((v:any)=>v.is_test!==true)||null;
    if(record)break;
  }
  if(!record)return reply(404,{error:"not_found"});
  let rawStatus=String(record.delivery_tracking_status||"pending");
  let updatedAt=record.delivery_tracking_updated_at||null;
  let detail=record.delivery_tracking_details||null;
  let checkpoints:any[]=[];
  let expectedDelivery:null|string=null;
  let source="last_update";
  const apiKey=Deno.env.get("AFTERSHIP_API_KEY");
  let aftershipId=record.delivery_aftership_id;
  if(!aftershipId){
    const reg=await db.from("ctt_tracking_registration").select("aftership_id").eq("tracking_code",code).not("aftership_id","is",null).limit(1).maybeSingle();
    aftershipId=reg.data?.aftership_id;
  }
  if(apiKey&&aftershipId){
    try{
      const resp=await fetch("https://api.aftership.com/tracking/2026-07/trackings/"+encodeURIComponent(String(aftershipId)),{headers:{"as-api-key":apiKey},signal:AbortSignal.timeout(8500)});
      if(resp.ok){
        const payload=await resp.json();
        const t=payload?.data?.tracking||payload?.data||{};
        if(String(t.tracking_number||"").replace(/\s+/g,"").toUpperCase()===code){
          rawStatus=String(t.tag||t.delivery_status||rawStatus).toLowerCase();
          updatedAt=t.updated_at||updatedAt;
          expectedDelivery=t.expected_delivery||t.estimated_delivery_date||null;
          checkpoints=(Array.isArray(t.checkpoints)?t.checkpoints:[]).slice(0,35).map((c:any)=>({
            message:String(c.message||c.subtag_message||"Atualização do envio").slice(0,220),
            time:c.checkpoint_time||c.created_at||null,
            location:String(c.location||c.city||"").slice(0,90),
            status:String(c.tag||c.subtag||"").slice(0,50)
          }));
          if(checkpoints.length && !detail)detail=checkpoints[0].message;
          source="aftership";
        }
      }
    }catch{/* Show last validated webhook update if carrier cannot be reached. */}
  }
  const norm=rawStatus.replace(/[^a-z]/g,"");
  const keyStatus=Object.keys(states).find(k=>k.replace(/_/g,"")===norm)||"pending";
  return reply(200,{code,status:keyStatus,statusLabel:states[keyStatus],detail,updatedAt,expectedDelivery,checkpoints,source});
});
