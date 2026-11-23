import { ApiError, cleanText, enforceRateLimit, handleError, hasValidMagic, json, randomToken, readJson, requireAdmin, serviceClient, sha256 } from "../_shared/core.ts";
const SITE = "https://love-essences.pt";
const ensure = (ok:unknown,message:string) => { if(!ok) throw new ApiError(422,"invalid_request",message); };
Deno.serve(async (req:Request) => {
 if(req.method==="OPTIONS") return json(req,{},204);
 try {
  if(req.method!=="POST") throw new ApiError(405,"method","Método inválido.");
  const body=await readJson<Record<string,unknown>>(req);
  const action=String(body.action||"");
  const db=serviceClient();
  if(action==="create" || action==="list" || action==="moderate"){
   const admin=await requireAdmin(req,["owner","manager","viewer"]);
   if(action==="create"){
    if(admin.role==="viewer") throw new ApiError(403,"forbidden","Sem autorização.");
    const customer_name=cleanText(body.customerName,100,true)!;
    const product_name=cleanText(body.productName,140,true)!;
    const channel=String(body.channel||"instagram");
    ensure(["instagram","whatsapp","website","other"].includes(channel),"Canal inválido.");
    const product_image_url=cleanText(body.productImageUrl,500);
    if(product_image_url) ensure(product_image_url.startsWith(SITE+"/")||product_image_url.startsWith("https://www.love-essences.pt/"),"A fotografia deve pertencer à Love Essences.");
    const token=randomToken();
    const token_hash=await sha256(token);
    const row={customer_name,product_name,channel,product_image_url,token_hash};
    const {data,error}=await db.from("review_invitations").insert(row).select("id").single();
    if(error) throw error;
    return json(req,{id:data.id,url:SITE+"/avaliar/?convite="+encodeURIComponent(token)});
   }
   if(action==="list"){
    const {data,error}=await db.from("review_invitations").select("id,customer_name,product_name,product_image_url,channel,created_at,customer_reviews(id,product_rating,experience_rating,comment,public_name,photo_path,publish_photo,publication_consent,status,created_at)").order("created_at",{ascending:false}).limit(250);
    if(error) throw error;
    return json(req,{data:data||[]});
   }
   if(admin.role==="viewer") throw new ApiError(403,"forbidden","Sem autorização.");
   const id=cleanText(body.reviewId,80,true)!;
   const status=String(body.status||"");
   ensure(["pending","published","rejected"].includes(status),"Estado inválido.");
   const {data,error}=await db.from("customer_reviews").update({status,reviewed_at:new Date().toISOString()}).eq("id",id).select("id,status").maybeSingle();
   if(error) throw error;
   if(!data) throw new ApiError(404,"missing","Avaliação não encontrada.");
   return json(req,{ok:true});
  }
  if(action==="view" || action==="submit"){
   await enforceRateLimit(req,"customer_review_"+action,action==="submit"?6:40,60);
   const token=cleanText(body.token,200,true)!;
   const hash=await sha256(token);
   const {data:invite,error}=await db.from("review_invitations").select("id,customer_name,product_name,product_image_url,expires_at").eq("token_hash",hash).maybeSingle();
   if(error) throw error;
   if(!invite) throw new ApiError(404,"invalid_invite","Este convite não é válido.");
   const {data:existing,error:lookupError}=await db.from("customer_reviews").select("id").eq("invitation_id",invite.id).maybeSingle();
   if(lookupError) throw lookupError;
   if(action==="view") return json(req,{customerName:invite.customer_name,productName:invite.product_name,productImageUrl:invite.product_image_url,submitted:!!existing,expired:new Date(invite.expires_at).getTime()<Date.now()});
   if(existing) throw new ApiError(409,"already_sent","Esta avaliação já foi enviada. Obrigada!");
   if(new Date(invite.expires_at).getTime()<Date.now()) throw new ApiError(410,"expired","Este convite expirou.");
   const product_rating=Number(body.productRating),experience_rating=Number(body.experienceRating);
   ensure(Number.isInteger(product_rating)&&product_rating>=1&&product_rating<=5&&Number.isInteger(experience_rating)&&experience_rating>=1&&experience_rating<=5,"Indica as duas classificações.");
   const comment=cleanText(body.comment,1500,true)!;
   ensure(comment.length>=10,"Escreve pelo menos 10 caracteres.");
   const public_name=cleanText(body.publicName,65,true)!;
   ensure(body.publicationConsent===true,"Confirma a autorização para publicar a avaliação.");
   let photo_path:string|null=null;
   if(body.photoData){
    const match=String(body.photoData).match(/^data:(image\/jpeg|image\/png);base64,([a-zA-Z0-9+/=]+)$/);
    ensure(!!match,"Fotografia inválida. Usa JPG ou PNG.");
    ensure(match![2].length<2900000,"A fotografia deve ter até 2 MB.");
    const bytes=Uint8Array.from(atob(match![2]),c=>c.charCodeAt(0));
    ensure(bytes.length<=2097152&&hasValidMagic(bytes,match![1]),"Formato de fotografia inválido.");
    photo_path=crypto.randomUUID()+(match![1]==="image/png"?".png":".jpg");
    const {error:uploadError}=await db.storage.from("customer-review-photos").upload(photo_path,bytes,{contentType:match![1],upsert:false});
    if(uploadError) throw uploadError;
   }
   const {error:saveError}=await db.from("customer_reviews").insert({invitation_id:invite.id,product_rating,experience_rating,comment,public_name,photo_path,publish_photo:!!photo_path && body.publishPhoto===true,publication_consent:true,status:"pending"});
   if(saveError){
     if(photo_path) await db.storage.from("customer-review-photos").remove([photo_path]);
     if(saveError.code==="23505") throw new ApiError(409,"already_sent","Esta avaliação já foi enviada.");
     throw saveError;
   }
   return json(req,{ok:true});
  }
  if(action==="published"){
   const {data,error}=await db.from("customer_reviews").select("id,public_name,product_rating,experience_rating,comment,photo_path,publish_photo,created_at,review_invitations(product_name,product_image_url)").eq("status","published").order("created_at",{ascending:false}).limit(60);
   if(error) throw error;
   return json(req,{data:data||[]});
  }
  throw new ApiError(404,"invalid_action","Operação desconhecida.");
 }catch(e){return handleError(req,e);}
});
