import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import {createHash} from 'crypto';
import {authenticate} from './intake';
import {authorizeAdminCall} from '../admin/authority';
import {requireTrustedCompanyCapability} from '../security/trustedStaffAuthority';
import {chatTimestamp} from '../imports/pullParser';
import {applyReviewCorrections} from './reviewCorrections';
const root='watchdog_review_inbox';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
async function authorize(request:any,write=false){
 if(!request.auth)throw new https.HttpsError('unauthenticated','Sign in required');
 const companyId=request.data?.companyId;if(typeof companyId!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(companyId))throw new https.HttpsError('invalid-argument','Select a company');
 const record=await admin.firestore().doc('platform_admins/'+request.auth.uid).get();
 if(!authorizeAdminCall(request.auth,record.data()).ok){const scope=await requireTrustedCompanyCapability(request.auth.uid,write?'manageWells':'viewDispatch');if(scope.companyId!==companyId)throw new https.HttpsError('permission-denied','Company scope mismatch');}
 return companyId;
}
export const syncWatchdogReviewV2=https.onRequest({region:'us-central1',timeoutSeconds:60,secrets:['WATCHDOG_HMAC_KEY_V1']},async(req,res)=>{try{
 await authenticate(req,'syncWatchdogReviewV2');const b=req.body;
 if(!b||typeof b.rowId!=='string'||b.rowId.length>200||typeof b.revision!=='string'||!/^[a-f0-9]{64}$/.test(b.revision)||typeof b.channel!=='string'||!['review','complete','duplicate','excluded','queued','archived','before_activation','incomplete'].includes(b.status)||typeof b.body!=='string'||b.body.length>6000||!Array.isArray(b.issues)||b.issues.length>30||b.issues.some((x:any)=>typeof x!=='string'||x.length>500))throw Error('invalid_review_snapshot');
 const policy=(await admin.firestore().doc('watchdog_v2_config/laptop').get()).data();if(!policy?.enabled||!policy.channels?.[b.channel])throw Error('channel_not_allowed');
 if(!b.row||typeof b.row.wellName!=='string'||!policy.channels[b.channel].wells?.includes(b.row.wellName))throw Error('well_not_allowed');
 const ref=admin.firestore().doc(root+'/liquid-gold/items/'+sha(b.rowId));
 const result=await admin.firestore().runTransaction(async tx=>{const snap=await tx.get(ref),old=snap.data();const fields={companyId:'liquid-gold',principalId:'laptop-watchdog-v2',rowId:b.rowId,revision:b.revision,channel:b.channel,groupName:typeof b.groupName==='string'?b.groupName.slice(0,200):'',body:b.body,author:typeof b.author==='string'?b.author.slice(0,200):'',postedAt:b.postedAt||'',row:b.row,issues:b.issues,status:b.status,editable:b.editable===true,updatedAt:Date.now()};
 if(!old||old.revision!==b.revision||old.status!==b.status)tx.set(ref,fields,{merge:true});
 const command=old?.command?.state==='pending'&&old.command.revision===b.revision&&b.status==='review'?old.command:null;
 if(b.result&&old?.command?.id===b.result.id){tx.update(ref,{'command.state':b.result.ok?'applied':'failed','command.error':typeof b.result.error==='string'?b.result.error.slice(0,300):'','command.appliedAt':Date.now()});return {command:null};}
 return {command};});res.json({ok:true,...result});
 }catch(e){res.status(400).json({ok:false,error:(e as Error).message});}});
export const listWatchdogReviews=https.onCall({region:'us-central1'},async request=>{const companyId=await authorize(request);const snap=await admin.firestore().collection(root+'/'+companyId+'/items').where('status','==','review').limit(500).get();const rows=snap.docs.map(d=>({id:d.id,...d.data()} as any)).filter(d=>d.status==='review').sort((a,b)=>Date.parse(a.postedAt)-Date.parse(b.postedAt));return {rows,truncated:snap.size===500};});
export const decideWatchdogReview=https.onCall({region:'us-central1'},async request=>{const companyId=await authorize(request,true),b=request.data;
 if(typeof b.id!=='string'||!/^[a-f0-9]{64}$/.test(b.id)||typeof b.revision!=='string'||!['confirm','exclude'].includes(b.decision)||typeof b.reason!=='string'||b.reason.trim().length<3||b.reason.length>300)throw new https.HttpsError('invalid-argument','Enter a review reason');
 const ref=admin.firestore().doc(root+'/'+companyId+'/items/'+b.id);return admin.firestore().runTransaction(async tx=>{const snap=await tx.get(ref),item=snap.data();if(!item||item.companyId!==companyId)throw new https.HttpsError('permission-denied','Review not in this company');if(item.status!=='review'||item.revision!==b.revision||!item.editable||item.command?.state==='pending')throw new https.HttpsError('failed-precondition','Review changed or already pending; refresh');
 let dateTimeUTC=b.dateTimeUTC;if(b.decision==='confirm'){if(typeof b.timeCentral!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(b.timeCentral))throw new https.HttpsError('invalid-argument','Choose measurement time');const [date,time]=b.timeCentral.split('T'),[y,m,d]=date.split('-');dateTimeUTC=chatTimestamp(m+'/'+d+'/'+y,time);}
 const review=b.decision==='confirm'?{confirmed:true,dateTimeUTC,reason:b.reason.trim(),tankLevelFeet:b.tankLevelFeet,bottomLevelFeet:b.bottomLevelFeet,bblsTaken:b.bblsTaken,actorUid:request.auth!.uid}:null;if(review)applyReviewCorrections(item.row,review);
 const command={id:sha(b.id+':'+Date.now()+':'+request.auth!.uid),state:'pending',revision:b.revision,decision:b.decision,review,reason:b.reason.trim(),actorUid:request.auth!.uid,requestedAt:Date.now()};tx.update(ref,{command});tx.create(admin.firestore().collection('watchdog_review_audit').doc(command.id),{companyId,rowId:item.rowId,...command});return {ok:true};});});
