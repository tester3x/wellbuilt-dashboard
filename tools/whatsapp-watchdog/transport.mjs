import {heldReportAllowed} from './monitoring-hold.mjs';
import {canReviewPost} from './core.mjs';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
export function orderedDeliveryRows(messages){return Object.values(messages).filter(m=>!m.deleted&&!m.edited&&!m.id.startsWith('export:')).flatMap(message=>message.rows.map((row,index)=>({message,row,index}))).sort((a,b)=>(Date.parse(a.row.dateTimeUTC)||0)-(Date.parse(b.row.dateTimeUTC)||0)||a.row.id.localeCompare(b.row.id));}
export function repeatedSenderReport(queue,message,row){
 if(!message.senderId)return null;
 const at=Date.parse(row.postedAt||row.dateTimeUTC);
 for(const prior of Object.values(queue.data.messages)){
  if(prior.id===message.id||prior.deleted||prior.edited||prior.senderId!==message.senderId)continue;
  for(const candidate of prior.rows){
   const gap=at-Date.parse(candidate.postedAt||candidate.dateTimeUTC);
   const receipt=queue.data.deliveries?.[candidate.id];
   if(gap>0&&gap<=90000&&receipt?.status==='complete'&&!receipt.needsReview&&
      candidate.wellName===row.wellName&&candidate.tankLevelFeet===row.tankLevelFeet&&
      candidate.bottomLevelFeet===row.bottomLevelFeet&&candidate.bblsTaken===row.bblsTaken)
    return {rowId:candidate.id,packetId:receipt.packetId};
  }
 }
 return null;
}
const origin='https://us-central1-wellbuilt-sync.cloudfunctions.net/';
export function signedRequest(endpoint,body,secret){const raw=JSON.stringify(body),timestamp=String(Date.now()),nonce=randomBytes(16).toString('hex');const digest=createHash('sha256').update(raw).digest('hex');return {method:'POST',headers:{'Content-Type':'application/json','x-watchdog-key-id':'V1','x-watchdog-timestamp':timestamp,'x-watchdog-nonce':nonce,'x-watchdog-signature':createHmac('sha256',secret).update(`v1:${endpoint}:POST:${timestamp}:${nonce}:${digest}`).digest('hex')},body:raw,signal:AbortSignal.timeout(20000)};}
export class Transport{
 constructor(queue){this.queue=queue;this.channelOptions={};this.busy=false;this.secret=null;this.status='Not configured';}
 configure(){const file=path.join(this.queue.directory,'transport.json');try{this.config=JSON.parse(readFileSync(file,'utf8'));if(!this.config.enabled){this.status='Disabled';return;}const protectedFile=path.join(this.queue.directory,'hmac-key.dpapi');const script="$s=(Get-Content -LiteralPath $env:WBC_KEY_FILE -Raw).Trim() | ConvertTo-SecureString; $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{[Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}";this.secret=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,env:{...process.env,PSModulePath:process.env.SystemRoot+'\\System32\\WindowsPowerShell\\v1.0\\Modules',WBC_KEY_FILE:protectedFile},stdio:['ignore','pipe','pipe']});if(this.secret.length<16)throw Error('Credential unavailable');this.status='Ready';}catch{this.status='Not configured';}}
 async request(endpoint,body){const response=await fetch(origin+endpoint,signedRequest(endpoint,body,this.secret));const result=await response.json();if(!response.ok||!result.ok){const error=new Error(result.error||'Intake request failed');error.httpStatus=response.status;throw error;}return result;}
 async lifecycle(){const result=await this.request('getWatchdogWellLifecycleV2',{});this.wells=result.wells;return result;}
 async reconcileReceipts(){
  if(this.busy)throw Error('Delivery in progress; try again');
  if(!this.secret||!this.config?.enabled)throw Error('Transport unavailable');
  this.busy=true;let refreshed=0,errors=0;
  try{
   const entries=Object.entries(this.queue.data.deliveries||{}).filter(([,d])=>d.identity&&(['queued','incomplete','review'].includes(d.status)||(d.status==='complete'&&d.needsReview)));
   for(const [id,previous] of entries){
    try{
     const receipt=await this.request('getWatchdogPullReceiptV2',{identity:previous.identity});
     if(receipt.identity!==previous.identity||receipt.packetId!==previous.packetId){errors++;continue;}
     const current=this.queue.data.deliveries?.[id];
     if(current?.identity!==previous.identity||current?.packetId!==previous.packetId||current?.correctionPending)continue;
     this.queue.data.deliveries[id]={...current,...receipt};
     this.receiptChecks??={};this.receiptChecks[id]=Date.now();this.queue.save();refreshed++;
    }catch{errors++;}
   }
   return {ok:true,refreshed,errors,pending:Object.values(this.queue.data.deliveries||{}).filter(d=>['queued','incomplete'].includes(d.status)).length};
  }finally{this.busy=false;}
 }
 async stopWell(wellName,reason){if(this.busy)throw Error('Delivery in progress; try again');this.busy=true;try{const result=await this.request('stopWatchdogWellV2',{wellName,reason});await this.lifecycle();return result;}finally{this.busy=false;}}
 async review(rowId,decision,dateTimeUTC,reason,corrections={}){
  if(this.busy)throw Error('Delivery in progress; try again in a moment');
  const message=Object.values(this.queue.data.messages).find(m=>m.rows.some(r=>r.id===rowId));
  const index=message?.rows.findIndex(r=>r.id===rowId),row=message?.rows[index];
  const previous=this.queue.data.deliveries?.[rowId];
  if(!row||!canReviewPost(message,this.queue.data.deliveries,rowId)||!(previous?.status==='review'||previous?.needsReview))throw Error('This entry is not available for review');
  if(previous.identity&&previous.needsReview){
   if(!this.secret||!this.config?.enabled)throw Error('Transport unavailable');
   this.busy=true;try{const value=await this.request('reviewWatchdogDeliveredPullV2',{identity:previous.identity,decision,review:{...Object.fromEntries(Object.entries(corrections).filter(([k])=>['tankLevelFeet','bottomLevelFeet','bblsTaken','actorUid'].includes(k))),confirmed:true,dateTimeUTC,reason}});
    this.queue.data.deliveries[rowId]={...previous,...value,review:{dateTimeUTC,reason,at:new Date().toISOString()}};this.queue.save();return;
   }finally{this.busy=false;}
  }
  if(decision==='exclude'){this.queue.data.deliveries[rowId]={...previous,status:'excluded',review:{reason,at:new Date().toISOString()}};this.queue.save();return;}
  if(decision!=='confirm'||!this.secret||!this.config?.enabled)throw Error('Transport unavailable');
  this.busy=true;try{
   const delivery=await this.request('ingestWatchdogPullV2',{chatId:message.channel,messageId:message.id,chat:message.chat,rowIndex:index,...(message.senderId?{senderId:message.senderId}:{}),defaultBbls:this.channelOptions[message.channel]?.defaultBbls??null,review:{...Object.fromEntries(Object.entries(corrections).filter(([k])=>['tankLevelFeet','bottomLevelFeet','bblsTaken','actorUid'].includes(k))),confirmed:true,dateTimeUTC,reason}});
   this.queue.data.deliveries[rowId]={...delivery,review:{dateTimeUTC,reason,at:new Date().toISOString()}};this.queue.save();
  }finally{this.busy=false;}
 }
 async tick(paused){if(paused||this.busy||!this.secret||!this.config?.enabled)return;this.busy=true;try{if(!this.lastLifecycleCheck||Date.now()-this.lastLifecycleCheck>60000){await this.lifecycle();this.lastLifecycleCheck=Date.now();}this.queue.reparseChannels(Object.fromEntries(Object.entries(this.channelOptions).map(([id,options])=>[id,{...options,wellNames:(this.wells||[]).filter(w=>w.channels?.includes(id)).map(w=>w.wellName)}])));let sent=0,retryError='';const blockedWells=new Set();for(const {message,row,index} of orderedDeliveryRows(this.queue.data.messages)){if(blockedWells.has(row.wellName))continue;if(Date.parse(row.postedAt)<this.config.enabledAt||Date.parse(row.dateTimeUTC)<this.config.enabledAt)continue;if(this.wells?.some(w=>w.wellName===row.wellName&&w.archive))continue;if(!heldReportAllowed(this.wells,message,row))continue;const key=row.id;this.queue.data.deliveries??={};let delivery=this.queue.data.deliveries[key];if(!delivery){const duplicate=repeatedSenderReport(this.queue,message,row);if(duplicate){this.queue.data.deliveries[key]={status:'review',duplicateOf:duplicate,issues:['Possible duplicate of the same sender’s confirmed load; confirm or exclude the repeat']};this.queue.save();continue;}}if(row.levelOnly&&delivery?.status==='review'&&!delivery.identity&&!delivery.review&&!delivery.topOnlyPolicyChecked){delete this.queue.data.deliveries[key];delivery=undefined;}if(delivery&&((['duplicate','excluded','archived','before_activation','ignored'].includes(delivery.status)||(delivery.status==='review'&&!delivery.identity))||(delivery.status==='complete'&&!delivery.needsReview)))continue;if(delivery?.identity){if(['queued','incomplete'].includes(delivery.status))blockedWells.add(row.wellName);this.receiptChecks??={};if(Date.now()-(this.receiptChecks[key]||0)<60000)continue;this.receiptChecks[key]=Date.now();}if(!delivery?.identity&&((!row.levelOnly&&row.issues.some(issue=>issue!=='Inferred level separator needs historical validation'&&issue!=='Missing barrels'&&!(row.levelOnly&&issue==='Confirm measurement time for top-only reading')))||message.notices.length)){this.queue.data.deliveries[key]={status:'review',issues:row.issues.length?row.issues:['Tank setup needs review']};this.queue.save();continue;}try{if(!delivery?.identity){delivery=await this.request('ingestWatchdogPullV2',{chatId:message.channel,messageId:message.id,chat:message.chat,rowIndex:index,...(message.senderId?{senderId:message.senderId}:{}),defaultBbls:this.channelOptions[message.channel]?.defaultBbls??null,...(row.combinedTimeResolved?{review:{confirmed:true,dateTimeUTC:row.dateTimeUTC,reason:row.timeEstimate?'Earlier combined load time estimated from recent back-to-back loads':'Last combined load uses message post time',...(row.timeEstimate?{timeEstimate:row.timeEstimate}:{})}}:{})});if(delivery.status==='duplicate'&&!delivery.alreadyRecorded)delivery={...delivery,status:'review',duplicateCandidate:true,issues:[...(delivery.issues||[]),'Possible duplicate report; office review required']};if(row.levelOnly)delivery={...delivery,topOnlyPolicyChecked:true};this.queue.data.deliveries[key]=delivery;this.queue.save();}if(delivery.identity){const receipt=await this.request('getWatchdogPullReceiptV2',{identity:delivery.identity});this.queue.data.deliveries[key]=receipt;this.queue.save();if(['queued','incomplete'].includes(receipt.status))blockedWells.add(row.wellName);else blockedWells.delete(row.wellName);}}catch(e){const code=String(e.message||e);const reviewable=new Set(['sender_well_out_of_scope','sender_driver_unavailable','sender_binding_invalid','well_not_allowed','missing_pull','invalid_observation','invalid_barrel_fallback']);if(reviewable.has(code)){this.queue.data.deliveries[key]={...delivery,status:'review',needsReview:true,topOnlyPolicyChecked:true,issues:[code],rejectedAt:new Date().toISOString()};}else{this.queue.data.deliveries[key]={...delivery,status:delivery?.status||'retry',lastError:code,lastAttemptAt:new Date().toISOString()};retryError=code;}this.queue.save();}if(++sent>=10)break;}this.status=retryError?'Retry pending: '+retryError:'Ready';}catch(e){this.status='Retry pending: '+e.message;}finally{this.busy=false;}}
}
