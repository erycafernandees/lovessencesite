import { handleError, readBodyText, serviceClient } from "../_shared/core.ts";
const reply=(status:number,body:unknown)=>Response.json(body,{status});
const encoder=new TextEncoder();
function timingSafe(a:Uint8Array,b:Uint8Array){if(a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a[i]^b[i];return x===0;}
function decoded(x:string){try{return Uint8Array.from(atob(x),c=>c.charCodeAt(0));}catch{return new Uint8Array();}}
const categories:Record<string,string>={"inforeceived":"info_received","intransit":"in_transit","outfordelivery":"out_for_delivery","availableforpickup":"available_for_pickup","delivered":"delivered","failedattempt":"failed_attempt","exception":"exception","expired":"expired"};
type TrackedRecord={id:string;delivery_tracking_updated_at:string|null;delivery_tracking_status:string|null;is_test?:boolean;order_status?:string;fulfillment_status?:string};
Deno.serve(async(req:Request)=>{
 if(req.method!=="POST")return reply(405,{error:"method_not_allowed"});
 const secret=Deno.env.get("AFTERSHIP_WEBHOOK_SECRET");
 if(!secret)return reply(503,{error:"webhook_secret_missing"});
 let raw:string;
 try { raw=await readBodyText(req,200000); } catch(error) { return handleError(req,error); }
 const hmac=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const signature=new Uint8Array(await crypto.subtle.sign("HMAC",hmac,encoder.encode(raw)));
 if(!timingSafe(signature,decoded(req.headers.get("aftership-hmac-sha256")||"")))return reply(401,{error:"invalid_signature"});
 let event:any;try{event=JSON.parse(raw);}catch{return reply(400,{error:"invalid_json"});}
 if(event?.event!=="tracking_update")return reply(200,{ok:true,ignored:"event"});
 // AfterShip webhook v2026-07 uses msg as the tracking itself, not necessarily msg.tracking.
 const t=event?.msg?.tracking||event?.msg||{};
 const tracking=String(t.tracking_number||"").trim().toUpperCase();
 const rawStatus=String(t.tag||t.delivery_status||"").replace(/[^a-z]/gi,"").toLowerCase();
 const status=categories[rawStatus];
 if(!/^[A-Z0-9-]{8,60}$/.test(tracking)||!status)return reply(200,{ok:true,ignored:"unsupported_tracking"});
 // Reject implausibly stale webhooks to reduce replay risk; only accept signed, recent events.
 const received=Number(event.ts),now=Math.floor(Date.now()/1000);
 if(!Number.isFinite(received)||received<now-7*86400||received>now+300)return reply(200,{ok:true,ignored:"stale_event"});
 const eventTime=new Date(received*1000).toISOString();
 const db=serviceClient();
 const details=String(t.checkpoints?.[0]?.message||t.subtag_message||"").slice(0,500)||null;
 let count=0;
 for(const config of [
  {table:"orders",column:"order_status",source:"order",active:["shipped","completed"]},
  {table:"project_requests",column:"fulfillment_status",source:"project",active:["shipped","completed"]},
 ] as const){
   const {data,error}=await db.from(config.table).select("id,delivery_tracking_updated_at,delivery_tracking_status,"+config.column+(config.source==="order"?",is_test":""))
    .eq("delivery_method","ctt").eq("delivery_tracking_code",tracking).in(config.column,[...config.active]).returns<TrackedRecord[]>();
   if(error)return reply(500,{error:"lookup_failed"});
   for(const record of data||[]){
     if(config.source==="order" && (record as any).is_test === true)continue;
     if(record.delivery_tracking_updated_at && new Date(record.delivery_tracking_updated_at)>new Date(eventTime))continue;
     const patch:Record<string,unknown>={delivery_tracking_status:status,delivery_tracking_updated_at:eventTime,delivery_tracking_details:details,
       delivery_aftership_id:t.id||null};
     if(status==="delivered")patch.delivery_confirmed_at=t.delivery_time||eventTime;
     // Transition the order lifecycle ONLY after carrier confirms delivery.
     if(status==="delivered")patch[config.column]="completed";
     let update=db.from(config.table).update(patch).eq("id",record.id).eq("delivery_tracking_code",tracking);
     if(record.delivery_tracking_updated_at)update=update.lte("delivery_tracking_updated_at",eventTime);
     const saved=await update.select("id");
     if(saved.error)return reply(500,{error:"update_failed"});
     if(saved.data?.length){
       count++;
       if(status==="delivered" && (record as any)[config.column]==="shipped"){
         if(config.source==="order")await db.from("order_status_history").insert({order_id:record.id,order_status:"completed",note:"Entrega confirmada pela AfterShip (CTT)."});
         else await db.from("project_status_history").insert({project_request_id:record.id,status:"completed",note:"Entrega confirmada pela AfterShip (CTT)."});
       }
     }
   }
 }
 return reply(200,{ok:true,updated:count});
});
