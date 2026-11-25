import * as admin from 'firebase-admin';
import {onDocumentWritten} from 'firebase-functions/v2/firestore';
import {GoogleAuth} from 'google-auth-library';
import {createHash,createHmac,randomBytes} from 'crypto';
import {matchingPhotoReceipts} from './photoInbox';
import {runPhotoFallback,photoAiCacheKey,gaugePrompt,gaugeSchema,fallbackAuditChanged,photoFallbackSourceChanged,DWYER_AI_MODEL,DWYER_AI_VERSION,type GaugeRead,type PhotoItem} from './photoFallbackCore';

const auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']});
export async function readCloudDwyerGauge(bytes:Buffer,mimeType:string,pass:number):Promise<GaugeRead>{
 const project=process.env.GCLOUD_PROJECT||process.env.GOOGLE_CLOUD_PROJECT;
 if(!project)throw Error('missing_project');
 const client=await auth.getClient();
 const response=await client.request<any>({url:`https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${DWYER_AI_MODEL}:generateContent`,method:'POST',timeout:45000,retry:false,data:{contents:[{role:'user',parts:[{text:gaugePrompt(pass)},{inlineData:{mimeType,data:bytes.toString('base64')}}]}],generationConfig:{temperature:0,maxOutputTokens:4096,responseMimeType:'application/json',responseSchema:gaugeSchema}}});
 const candidate=response.data?.candidates?.[0];
 if(candidate?.finishReason!=='STOP')throw Error('incomplete_model_response');
 const text=candidate.content?.parts?.filter((p:any)=>typeof p.text==='string'&&!p.thought).map((p:any)=>p.text).join('');
 if(!text||text.length>3000)throw Error('invalid_model_response');
 return JSON.parse(text);
}
async function signedIntake(endpoint:string,body:any){
 const secret=process.env.WATCHDOG_HMAC_KEY_V1;if(!secret)throw Error('missing_signing_key');
 const raw=JSON.stringify(body),timestamp=String(Date.now()),nonce=randomBytes(16).toString('hex');
 const digest=createHash('sha256').update(raw).digest('hex');
 const signature=createHmac('sha256',secret).update(`v1:${endpoint}:POST:${timestamp}:${nonce}:${digest}`).digest('hex');
 const response=await fetch('https://us-central1-'+process.env.GCLOUD_PROJECT+'.cloudfunctions.net/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json','x-watchdog-key-id':'V1','x-watchdog-timestamp':timestamp,'x-watchdog-nonce':nonce,'x-watchdog-signature':signature},body:raw,signal:AbortSignal.timeout(25000)});
 const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error||'intake_failed');return result;
}

export const processWatchdogPhotoFallback=onDocumentWritten({document:'watchdog_photo_inbox/{companyId}/items/{messageHash}',region:'us-central1',timeoutSeconds:180,memory:'512MiB',maxInstances:1,concurrency:2,retry:false,secrets:['WATCHDOG_HMAC_KEY_V1']},async event=>{
 if(event.params.companyId!=='liquid-gold'||!event.data?.after.exists)return;
 const item=event.data.after.data() as PhotoItem;
 if(!photoFallbackSourceChanged(event.data.before.exists?event.data.before.data() as PhotoItem:undefined,item))return;
 const key=createHash('sha256').update(item.channel+':'+item.messageId).digest('hex');
 if(key!==event.params.messageHash||item.messageHash!==key)return;
 const db=admin.firestore(),config=(await db.doc('watchdog_v2_config/laptop').get()).data();
 if(!config?.enabled||config.cloudPhotoFallback?.enabled!==true||!config.channels?.[item.channel]?.wells?.includes('Dwyer'))return;
 const job=db.doc('watchdog_photo_fallback/liquid-gold/items/'+key);
 const imageCache=db.doc('watchdog_photo_ai_reads/'+photoAiCacheKey(item.imageDigest));
 const result=await runPhotoFallback(item,config.cloudPhotoFallback,{
  receipts:()=>matchingPhotoReceipts(key),
  claim:()=>db.runTransaction(async tx=>{
   const previous=await tx.get(job),cached=await tx.get(imageCache);
   if(previous.exists)return previous.data()?.state==='running'?'busy':'finished';
   // A shared image is never re-read or re-delivered automatically, even if it
   // was forwarded under another WhatsApp message ID.
   if(cached.exists)return 'finished';
   const limit=Math.min(50,Number(config.cloudPhotoFallback?.maxDailyPhotos)||25);
   const bucket=db.doc('watchdog_photo_ai_budgets/'+new Date().toISOString().slice(0,10));
   const budget=(await tx.get(bucket)).data();if(Number(budget?.photos||0)>=limit)return 'budget';
   const running={state:'running',messageHash:key,imageDigest:item.imageDigest,model:DWYER_AI_MODEL,promptVersion:DWYER_AI_VERSION,startedAt:Date.now()};
   tx.create(job,running);tx.create(imageCache,running);tx.set(bucket,{photos:Number(budget?.photos||0)+1});return 'claimed';
  }),
  image:async()=>{
   const expected='watchdog-review-photos/liquid-gold/'+key+'/'+item.imageDigest;
   if(item.objectPath!==expected)throw Error('unexpected_photo_object');
   const file=admin.storage().bucket().file(expected);const [metadata]=await file.getMetadata();
   if(Number(metadata.size)!==item.bytes||metadata.contentType!==item.mimeType)throw Error('photo_metadata_mismatch');
   const [bytes]=await file.download({validation:'crc32c'});return bytes;
  },
  read:(bytes,pass)=>readCloudDwyerGauge(bytes,item.mimeType,pass),
  save:async result=>{await job.set({...result,updatedAt:Date.now()},{merge:true});await imageCache.set({...result,updatedAt:Date.now()},{merge:true});},
  deliver:async bottom=>{
   const latest=(await event.data!.after.ref.get()).data();
   if(!latest||latest.sourceEdited||latest.imageDigest!==item.imageDigest||latest.caption!==item.caption||latest.postedAt!==item.postedAt)throw Error('photo_changed_during_inference');
   const chat=typeof item.chat==='string'?item.chat:item.caption;
   const result=await signedIntake('ingestWatchdogPullV2',{chatId:item.channel,messageId:item.messageId,chat,rowIndex:0,...(item.senderId?{senderId:item.senderId}:{}),dwyerPhoto:{imageDigest:item.imageDigest,tagVerified:true,bottomFeet:bottom}});
   // No reviewed barrels/top override: existing calibration, haul evidence,
   // sender scope and transactional message reservations remain authoritative.
   return result;
  },
 });
 // Small audit summary only; the original photo, local OCR and signed packets
 // are immutable. Updating this field cannot spend another model call.
 const changed=fallbackAuditChanged(item.cloudFallback,result);
 // Replace the audit map atomically: merge would retain omitted old result
 // fields (e.g. bottomFeet), making the comparison differ indefinitely.
 if(changed&&!['skipped','busy','finished'].includes(result.state))await event.data.after.ref.update({cloudFallback:{...result,model:DWYER_AI_MODEL,checkedAt:Date.now()}});
});
