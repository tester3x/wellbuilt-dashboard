import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {createHmac,timingSafeEqual} from 'crypto';
import {authenticate} from './intake';
import {authorizeWatchdogOffice} from './remoteReview';

const agentId='hp-watchdog',companyId='liquid-gold';
export const recoveryActions=['refresh','reconnect','retry_pending','resume','restart_worker'] as const;
const devicePath='watchdog_agents/'+agentId;
const commandsPath=devicePath+'/commands/';
const TTL=10*60*1000;
function seal(command:any){const secret=process.env.WATCHDOG_HMAC_KEY_V1;if(!secret)throw Error('Recovery signing configuration unavailable');return createHmac('sha256',secret).update(JSON.stringify([command.id,command.action,command.companyId,command.agentId,command.actorUid,command.reason,command.requestedAt,command.expiresAt])).digest('hex');}
function verifiedCommand(command:any){if(!command||!recoveryActions.includes(command.action)||command.companyId!==companyId||command.agentId!==agentId||typeof command.seal!=='string'||!/^[a-f0-9]{64}$/.test(command.seal))return false;return timingSafeEqual(Buffer.from(command.seal,'hex'),Buffer.from(seal(command),'hex'));}
function officeScope(scope:string){if(scope!==companyId)throw new https.HttpsError('not-found','No Watchdog receiver configured for this company');}
function fields(value:any,allowed:string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw Error('invalid_agent_payload');}
function text(value:any,max=300){if(typeof value!=='string'||value.length>max)throw Error('invalid_agent_text');return value;}
export function agentHealth(value:any){
 fields(value,['workerReachable','state','paused','lastReceiverCheck','transportStatus','pending','reviews','channels','version','error']);
 if(typeof value.workerReachable!=='boolean'||typeof value.paused!=='boolean')throw Error('invalid_agent_health');
 for(const key of ['pending','reviews','channels'])if(!Number.isInteger(value[key])||value[key]<0||value[key]>100000)throw Error('invalid_agent_count');
 return {workerReachable:value.workerReachable,state:text(value.state,80),paused:value.paused,lastReceiverCheck:text(value.lastReceiverCheck,40),transportStatus:text(value.transportStatus,120),pending:value.pending,reviews:value.reviews,channels:value.channels,version:text(value.version,80),error:text(value.error)};
}
function displayCommand(command:any,now:number){return command?{id:command.id,action:command.action,state:command.state==='pending'&&command.expiresAt<=now?'expired':command.state,requestedAt:command.requestedAt,expiresAt:command.expiresAt,finishedAt:command.finishedAt||null,error:command.error||''}:null;}

export const getWatchdogAgentHealth=https.onCall({region:'us-central1'},async request=>{
 officeScope(await authorizeWatchdogOffice(request));
 let canRecover=false;try{officeScope(await authorizeWatchdogOffice(request,true));canRecover=true;}catch{}
 const db=admin.firestore(),device=(await db.doc(devicePath).get()).data(),now=Date.now();
 const command=device?.activeCommandId?(await db.doc(commandsPath+device.activeCommandId).get()).data():null;
 return {agentId,installed:!!device?.seenAt,seenAt:device?.seenAt||null,stale:!device?.seenAt||now-device.seenAt>180000,health:device?.health||null,command:displayCommand(command,now),canRecover,serverTime:now};
});

export const requestWatchdogRecovery=https.onCall({region:'us-central1',secrets:['WATCHDOG_HMAC_KEY_V1']},async request=>{
 officeScope(await authorizeWatchdogOffice(request,true));const b=request.data;
 try{fields(b,['companyId','action','requestId','reason']);text(b.reason);if(b.reason.trim().length<3||!recoveryActions.includes(b.action)||typeof b.requestId!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(b.requestId))throw Error('Choose a recovery action and enter a reason');}
 catch(e){throw new https.HttpsError('invalid-argument',(e as Error).message);}
 const db=admin.firestore(),ref=db.doc(devicePath),commandRef=db.doc(commandsPath+b.requestId);
 return db.runTransaction(async tx=>{
  const [deviceSnap,existing]=await Promise.all([tx.get(ref),tx.get(commandRef)]),device=deviceSnap.data(),prior=existing.data(),now=Date.now();
  if(prior){if(prior.action!==b.action||prior.actorUid!==request.auth!.uid)throw new https.HttpsError('already-exists','Recovery request ID already used');return {ok:true,command:displayCommand(prior,now)};}
  if(!device?.seenAt)throw new https.HttpsError('failed-precondition','Install the remote recovery helper on the HP first');
  if(device.activeCommandId){const active=(await tx.get(db.doc(commandsPath+device.activeCommandId))).data();if(active?.state==='pending'&&active.expiresAt>now)throw new https.HttpsError('failed-precondition','A recovery request is already waiting; refresh its result');}
  const command:any={id:b.requestId,action:b.action,state:'pending',companyId,agentId,actorUid:request.auth!.uid,reason:b.reason.trim(),requestedAt:now,expiresAt:now+TTL};command.seal=seal(command);
  tx.create(commandRef,command);tx.update(ref,{activeCommandId:command.id});
  return {ok:true,command:displayCommand(command,now)};
 });
});

export const syncWatchdogAgentV2=https.onRequest({region:'us-central1',timeoutSeconds:30,secrets:['WATCHDOG_HMAC_KEY_V1']},async(req,res)=>{
 try{
  await authenticate(req,'syncWatchdogAgentV2');const b=req.body;fields(b,['agentId','health','result']);if(b.agentId!==agentId)throw Error('agent_not_allowed');const health=agentHealth(b.health);
  if(b.result){fields(b.result,['id','ok','error']);if(typeof b.result.id!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(b.result.id)||typeof b.result.ok!=='boolean')throw Error('invalid_agent_result');text(b.result.error);}
  const db=admin.firestore(),ref=db.doc(devicePath);
  const command=await db.runTransaction(async tx=>{
   const device=(await tx.get(ref)).data();const commandRef=device?.activeCommandId?db.doc(commandsPath+device.activeCommandId):null;
   const active=commandRef?(await tx.get(commandRef)).data():null,now=Date.now();
   const resultRef=b.result?db.doc(commandsPath+b.result.id):null;
   const resultCommand=resultRef?(await tx.get(resultRef)).data():null;
   if(b.result&&(!resultCommand||resultCommand.agentId!==agentId||resultCommand.companyId!==companyId))throw Error('result_not_owned');
   if(resultCommand?.state==='pending')tx.update(resultRef!,{state:b.result.ok?'applied':'failed',finishedAt:now,error:b.result.error});
   let next=null;
   if(active?.state==='pending'){
    if(!verifiedCommand(active))tx.update(commandRef!,{state:'failed',finishedAt:now,error:'Invalid server authorization seal; no action issued'});
    else if(b.result?.id===active.id){/* Result was recorded above, once. */}
    else if(active.expiresAt<=now)tx.update(commandRef!,{state:'expired',finishedAt:now,error:'HP did not receive this request before it expired'});
    else next={id:active.id,action:active.action,expiresAt:active.expiresAt};
   }
   tx.set(ref,{companyId,agentId,principalId:'laptop-watchdog-v2',seenAt:now,health},{merge:true});
   return next;
  });res.json({ok:true,command});
 }catch(e){res.status(400).json({ok:false,error:String((e as Error).message).slice(0,300)});}
});
