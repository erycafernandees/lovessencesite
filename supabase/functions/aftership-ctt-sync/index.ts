import { handleError, requireAdmin, serviceClient } from "../_shared/core.ts";
const cors={"Access-Control-Allow-Origin":"https://love-essences.pt","Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info","Access-Control-Allow-Methods":"POST, OPTIONS","Vary":"Origin"};
const output=(status:number,data:unknown)=>Response.json(data,{status,headers:{"Cache-Control":"no-store",...cors}});
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
 if(req.method!=="POST")return output(405,{error:"method_not_allowed"});
 try { await requireAdmin(req,["owner","manager"]); } catch(error) { return handleError(req,error); }
 const db=serviceClient();
 const apiKey=Deno.env.get("AFTERSHIP_API_KEY");
 if(!apiKey)return output(503,{error:"aftership_api_key_missing"});
 const sources=[
  {table:"orders",column:"order_status",kind:"order"},
  {table:"project_requests",column:"fulfillment_status",kind:"project"}
 ];
 const invalidCodes:string[]=[];
 const candidates: {kind:string,id:string,number:string,code:string}[]=[];
 for(const source of sources){
   const result=await db.from(source.table).select(source.kind==="order"?"id,order_number,delivery_tracking_code":"id,project_number,delivery_tracking_code")
     .eq("delivery_method","ctt").eq(source.column,"shipped").not("delivery_tracking_code","is",null).limit(100);
   if(result.error)return output(500,{error:"unable_to_load_shipments"});
   for(const row of (result.data||[]) as any[]){
     const code=String(row.delivery_tracking_code||"").toUpperCase().trim();
     if(/^[A-Z]{2}[0-9]{9}[A-Z]{2}$/.test(code))candidates.push({kind:source.kind,id:row.id,number:row.order_number||row.project_number,code});
     else invalidCodes.push(row.order_number||row.project_number);
   }
 }
 const {data:registered,error:registeredError}=await db.from("ctt_tracking_registration")
   .select("kind,entity_id,tracking_code,registration_state,last_attempt_at,attempt_count,aftership_id").limit(1000);
 if(registeredError)return output(500,{error:"unable_to_load_registrations"});
 const map=new Map((registered||[]).map((x:any)=>[x.kind+":"+x.entity_id,x]));
 let added=0,existing=0,errors=0,skipped=0,refreshed=0;
 for(const candidate of candidates){
  const last:any=map.get(candidate.kind+":"+candidate.id);
  if(last?.tracking_code===candidate.code&&last?.registration_state==="registered"&&last.aftership_id){
    try {
      const resp=await fetch("https://api.aftership.com/tracking/2026-07/trackings/"+encodeURIComponent(last.aftership_id),{headers:{"as-api-key":apiKey},signal:AbortSignal.timeout(8500)});
      if(!resp.ok){errors++;continue;}
      const j=await resp.json();const t=j?.data?.tracking||j?.data;
      if(String(t?.tracking_number||"").trim().toUpperCase()!==candidate.code){errors++;continue;}
      const states:Record<string,string>={inforeceived:"info_received",intransit:"in_transit",outfordelivery:"out_for_delivery",availableforpickup:"available_for_pickup",delivered:"delivered",failedattempt:"failed_attempt",exception:"exception",expired:"expired"};
      const status=states[String(t.tag||"").replace(/[^a-z]/gi,"").toLowerCase()];
      const at=t.updated_at;
      if(!status||!at||!Number.isFinite(Date.parse(at))){errors++;continue;}
      const source=sources.find(x=>x.kind===candidate.kind)!;
      const q=await db.from(source.table).select("delivery_tracking_updated_at,delivery_tracking_status").eq("id",candidate.id).single();
      if(q.error){errors++;continue;}
      if(q.data.delivery_tracking_updated_at&&Date.parse(q.data.delivery_tracking_updated_at)>Date.parse(at)){skipped++;continue;}
      const patch:Record<string,unknown>={delivery_tracking_status:status,delivery_tracking_updated_at:at,delivery_tracking_details:String(t.subtag_message||t.checkpoints?.at(-1)?.message||"").slice(0,500)||null,delivery_aftership_id:last.aftership_id};
      if(status==="delivered"){patch[source.column]="completed";patch.delivery_confirmed_at=t.delivery_time||at;}
      let update=db.from(source.table).update(patch).eq("id",candidate.id).eq(source.column,"shipped").eq("delivery_tracking_code",candidate.code);
      if(source.kind==="order")update=update.eq("is_test",false);
      if(q.data.delivery_tracking_updated_at)update=update.lte("delivery_tracking_updated_at",at);else update=update.is("delivery_tracking_updated_at",null);
      const saved=await update.select("id");
      if(saved.error){errors++;continue;}
      if(saved.data?.length){refreshed++;if(status==="delivered"){if(source.kind==="order")await db.from("order_status_history").insert({order_id:candidate.id,order_status:"completed",note:"Entrega confirmada pela AfterShip (CTT)."});else await db.from("project_status_history").insert({project_request_id:candidate.id,status:"completed",note:"Entrega confirmada pela AfterShip (CTT)."});}}
    }catch{errors++;}
    continue;
  }
  if(last?.tracking_code===candidate.code&&last?.last_attempt_at){
    const age=Date.now()-Date.parse(last.last_attempt_at);
    if(age<15*60*1000){skipped++;continue;}
  }
  const body={tracking_number:candidate.code,slug:"portugal-ctt",title:candidate.number,order_number:candidate.number};
  let success=false,aftershipId:string|null=null,message:string|null=null,duplicate=false;
  try{
   const resp=await fetch("https://api.aftership.com/tracking/2026-07/trackings",{
    method:"POST",headers:{"Content-Type":"application/json","as-api-key":apiKey},
    body:JSON.stringify(body),signal:AbortSignal.timeout(12000)
   });
   const json=await resp.json().catch(()=>({}));
   if(resp.ok){
     success=true;aftershipId=String(json?.data?.id||json?.data?.tracking?.id||"")||null;
   }else{
     const msg=JSON.stringify(json).slice(0,500);
     // Duplicate tracking can be reported as 400/409 by the provider; a separate GET verification is needed.
     duplicate=resp.status===409||/already.exist|already been added|duplicate/i.test(msg);
     if(duplicate)success=true;else message="API HTTP "+resp.status+": "+msg;
   }
  }catch(e){message=e instanceof Error?e.message:"external_request_failed";}
  const previousAttempts=last?.tracking_code===candidate.code?Number(last.attempt_count||0):0;
  const save=await db.from("ctt_tracking_registration").upsert({
   kind:candidate.kind,entity_id:candidate.id,tracking_code:candidate.code,
   aftership_id:aftershipId,registration_state:success?"registered":"error",
   error_details:message,attempt_count:previousAttempts+1,last_attempt_at:new Date().toISOString(),updated_at:new Date().toISOString()
  },{onConflict:"kind,entity_id"});
  if(save.error)return output(500,{error:"unable_to_store_registration"});
  if(success){if(duplicate)existing++;else added++;}else errors++;
 }
 return output(200,{ok:true,tracked:candidates.length,added,alreadyInAfterShip:existing,failed:errors,unchanged:skipped,refreshed,invalidCodes});
});