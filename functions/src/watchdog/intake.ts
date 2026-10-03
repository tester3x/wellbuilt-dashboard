import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {createHash} from 'crypto';
import {verifyHmacHeaders} from './auth';
import {parsePullChat,findPullChatNotices} from '../imports/pullParser';
import {reviewPulls,digest,type JsonRecord} from '../imports/pullImportModel';
const options={region:'us-central1',timeoutSeconds:60,memory:'256MiB' as const,secrets:['WATCHDOG_HMAC_KEY_V1']};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const root='watchdog_v2_deliveries';
async function authenticate(req:any,endpoint:string){
 if(req.method!=='POST')throw Error('method_not_allowed');
 if(req.headers['x-watchdog-key-id']!=='V1')throw Error('unknown_key');
 if(!/^[a-f0-9]{32}$/.test(req.headers['x-watchdog-nonce']||''))throw Error('invalid_nonce');
 const raw=req.rawBody as Buffer;if(!raw||raw.length>12000)throw Error('body_limit');
 const verified=verifyHmacHeaders({endpointName:endpoint,method:'POST',headers:req.headers,rawBody:raw});
 if(!verified.ok)throw Error(verified.error||'authentication_failed');
 const nonce=admin.firestore().collection('watchdog_v2_nonces').doc(req.headers['x-watchdog-nonce']);
 const rate=admin.firestore().doc('watchdog_v2_rates/'+Math.floor(Date.now()/3600000));
 await admin.firestore().runTransaction(async tx=>{const [seen,bucket]=await Promise.all([tx.get(nonce),tx.get(rate)]);if(seen.exists)throw Error('replay_detected');const count=Number(bucket.data()?.count||0);if(count>=10000)throw Error('rate_limit');tx.create(nonce,{createdAt:Date.now()});tx.set(rate,{count:count+1});});
}
export const ingestWatchdogPullV2=https.onRequest(options,async(req,res)=>{
 try{
 await authenticate(req,'ingestWatchdogPullV2');
 const body=req.body as JsonRecord;
 if(!body||Object.keys(body).some(k=>!['chatId','messageId','chat','rowIndex'].includes(k))||typeof body.chatId!=='string'||typeof body.messageId!=='string'||typeof body.chat!=='string'||body.chat.length>6000||!Number.isInteger(body.rowIndex)||body.rowIndex<0||body.rowIndex>10)throw Error('invalid_observation');
 const policy=(await admin.firestore().doc('watchdog_v2_config/laptop').get()).data();
 if(!policy?.enabled)throw Error('transport_disabled');
 const channel=policy.channels?.[body.chatId];if(!channel)throw Error('channel_not_allowed');
 const rows=parsePullChat(body.chat,{defaultWell:channel.defaultWell||'',defaultBbls:channel.defaultBbls===165?165:undefined});
 const row=rows[body.rowIndex];if(!row)throw Error('missing_pull');
 if(Date.parse(row.postedAt)<policy.enabledAt||Date.parse(row.dateTimeUTC)<policy.enabledAt) {res.json({ok:true,status:'before_activation'});return;}
 if(findPullChatNotices(body.chat).length||row.issues.length||row.bottomLevelFeet===null) {res.json({ok:true,status:'review',issues:row.issues.length?row.issues:['Bottom level or tank setup needs review']});return;}
 const db=admin.database();const configs=(await db.ref('well_config').once('value')).val()||{};
 const mapped=reviewPulls([row],configs,{}, {},new Set())[0];
 if(!channel.wells?.includes(mapped.wellName)||configs[mapped.wellName]?.companyId&&configs[mapped.wellName].companyId!=='liquid-gold')throw Error('well_not_allowed');
 const [processed,incoming]=await Promise.all([db.ref('packets/processed').orderByChild('wellName').equalTo(mapped.wellName).once('value'),db.ref('packets/incoming').orderByChild('wellName').equalTo(mapped.wellName).once('value')]);
 const history={[mapped.wellName]:{...(processed.val()||{}),...(incoming.val()||{})}};
 const checked=reviewPulls([row],configs,history,{},new Set())[0];
 const identity=digest([mapped.wellName,row.dateTimeUTC,row.tankLevelFeet,row.bottomLevelFeet,row.bblsTaken]);
 const entryRef=admin.firestore().collection(root).doc(identity);
 const prior=(await entryRef.get()).data();
 if(!prior&&checked.status!=='ready'){res.json({ok:true,status:checked.status,issues:checked.issues});return;}
 const stamp=new Date(row.dateTimeUTC).toISOString().replace(/[-:]/g,'').slice(0,15).replace('T','_');
 const packetId=stamp+'_'+mapped.wellName.replace(/\s+/g,'')+'_'+identity.slice(0,6);
 const packet={packetId,idempotencyKey:packetId,requestType:'pull',wellName:mapped.wellName,tankLevelFeet:row.tankLevelFeet,bottomLevelFeet:row.bottomLevelFeet,bblsTaken:row.bblsTaken,dateTimeUTC:row.dateTimeUTC,timezone:'America/Chicago',companyId:'liquid-gold',source:'whatsapp_watchdog',driverId:null,driverName:null,wellDownIsAuthoritative:false,watchdogProvenance:{principalId:'laptop-watchdog-v2',observationDigest:identity}};
 const payloadDigest=digest(packet);
 await admin.firestore().runTransaction(async tx=>{const previous=await tx.get(entryRef);if(previous.exists){if(previous.data()?.payloadDigest!==payloadDigest)throw Error('payload_conflict');return;}tx.create(entryRef,{identity,packetId,payloadDigest,wellName:mapped.wellName,dateTimeUTC:row.dateTimeUTC,top:row.tankLevelFeet,bottom:row.bottomLevelFeet,bbl:row.bblsTaken,principalId:'laptop-watchdog-v2',messageHash:sha(body.chatId+':'+body.messageId),createdAt:Date.now()});});
 const done=await db.ref('packets/processed/'+packetId).once('value');
 if(!done.exists()){const transaction=await db.ref('packets/incoming/'+packetId).transaction(current=>{if(current){if(digest(current)!==payloadDigest)return;return current;}return packet;});if(!transaction.committed)throw Error('incoming_conflict');}
 res.json({ok:true,status:'queued',identity,packetId});
 }catch(e){res.status(400).json({ok:false,error:String((e as Error).message)});}
});
export const getWatchdogPullReceiptV2=https.onRequest(options,async(req,res)=>{
 try{await authenticate(req,'getWatchdogPullReceiptV2');const identity=req.body?.identity;if(typeof identity!=='string'||!/^[a-f0-9]{64}$/.test(identity)||Object.keys(req.body).some(k=>k!=='identity'))throw Error('invalid_receipt');
 const entry=(await admin.firestore().collection(root).doc(identity).get()).data();if(!entry||entry.principalId!=='laptop-watchdog-v2')throw Error('receipt_not_owned');
 const db=admin.database();const packet=(await db.ref('packets/processed/'+entry.packetId).once('value')).val();
 const matched=packet&&packet.wellName===entry.wellName&&packet.dateTimeUTC===entry.dateTimeUTC&&Number(packet.tankLevelFeet)===entry.top&&Number(packet.bblsTaken)===entry.bbl&&Math.abs(Number(packet.tankAfterInches)-entry.bottom*12)<0.01;
 res.json({ok:true,identity,packetId:entry.packetId,status:matched&&packet.canonicalProcessingComplete===true?'complete':packet?'incomplete':'queued'});
 }catch(e){res.status(400).json({ok:false,error:String((e as Error).message)});}
});
