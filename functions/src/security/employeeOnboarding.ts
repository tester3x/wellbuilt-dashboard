/** Company-code employee onboarding: pending until a trusted employer approves.
 * Web and app identities are linked to one canonical employee UUID. No role,
 * company ID, authority or app access is accepted from a signup client. */
import * as admin from 'firebase-admin';
import {onCall,HttpsError} from 'firebase-functions/v2/https';
import {createHash,randomBytes,randomUUID} from 'crypto';
import {resolveCompanyJoinCode} from './companyOnboarding';
import {checkRateLimit,hashIp} from './rateLimit';
import {validateRegistrationFields,hashPasscodeScrypt,normalizeDisplayName} from './passcode';
import {requireTrustedCompanyCapability,parseTrustedStaffAuthorityRecord} from './trustedStaffAuthority';
import {ensureDriverAuthUser,driverAuthUid} from './tokenMint';
import {ensureInitializedEmptyShiftAuthority,assertEnsureAuthorityOk} from './operational/ensureEmptyShiftAuthority';
import {employeeRoleGrant,exactEmployeeInput} from './employeeOnboardingPolicy';
const fs=()=>admin.firestore();
const requests=()=>fs().collection('employee_join_requests');
const options={timeoutSeconds:120,memory:'512MiB' as const,enforceAppCheck:false};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const refuse=():never=>{throw new HttpsError('failed-precondition','This account already belongs to another setup. Sign in with its existing account.');};
const safe=(row:any)=>({ok:true,status:row.state,companyName:row.companyName,displayName:row.displayName});
async function rate(request:any,bucket:string){
 if(!await checkRateLimit({bucket,key:hashIp(request.rawRequest?.ip||'unknown'),limit:30,windowMs:3600000}))throw new HttpsError('resource-exhausted','Too many requests. Please try later.');
}
async function actor(request:any){
 const access=await requireTrustedCompanyCapability(request.auth?.uid,'manageDrivers');
 await requireTrustedCompanyCapability(request.auth?.uid,'manageRolesAndCapabilities');
 const record=parseTrustedStaffAuthorityRecord((await fs().collection('trusted_staff_authority').doc(access.uid).get()).data(),access.uid);
 if(!record.ok||record.companyId!==access.companyId)throw new HttpsError('permission-denied','Company authority is unavailable');
 return {...access,capabilities:record.capabilities};
}
async function invitation(token:unknown){
 if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw new HttpsError('invalid-argument','Invitation is invalid or expired');
 const ref=fs().collection('employee_invitations').doc(digest(token));const row=(await ref.get()).data();
 if(!row||row.expiresAtMs<=Date.now()||row.active!==true)throw new HttpsError('failed-precondition','Invitation is invalid or expired');
 const company=(await fs().collection('companies').doc(row.companyId).get()).data();
 if(!company||company.status==='archived')throw new HttpsError('failed-precondition','Company is unavailable');
 return {ref,row,companyId:String(row.companyId),companyName:String(company.name)};
}
export const createEmployeeInvitation=onCall(options,async request=>{
 exactEmployeeInput(request.data,[]);const access=await actor(request);
 const company=(await fs().collection('companies').doc(access.companyId).get()).data();
 if(!company||company.status==='archived')throw new HttpsError('failed-precondition','Company is unavailable');
 const token=randomBytes(32).toString('hex');const expiresAtMs=Date.now()+7*86400000;
 await fs().collection('employee_invitations').doc(digest(token)).create({companyId:access.companyId,active:true,expiresAtMs,createdBy:access.uid});
 // Fragment keeps the private invitation out of HTTP request URLs/referrers.
 return {ok:true,url:`https://wellbuilt-sync.web.app/join/#invite=${token}`,companyName:company.name,expiresAtMs};
});
export const getEmployeeInvitation=onCall(options,async request=>{
 await rate(request,'employee_invitation');const data=exactEmployeeInput(request.data,['invitationToken']);
 const invite=await invitation(data.invitationToken);return {ok:true,companyName:invite.companyName};
});
export const requestEmployeeJoin=onCall(options,async request=>{
 if(!request.auth?.uid)throw new HttpsError('unauthenticated','Create your account or sign in first');
 await rate(request,'employee_join');
 const data=exactEmployeeInput(request.data,['companyCode','invitationToken','displayName','legalName','passcode']);
 if(!!data.companyCode===!!data.invitationToken)throw new HttpsError('invalid-argument','Use a company code or an invitation');
 let fields:ReturnType<typeof validateRegistrationFields>;
 try{fields=validateRegistrationFields(data as any);}catch{throw new HttpsError('invalid-argument','Enter an app sign-in name and a password of 6–128 characters');}
 const authUser=await admin.auth().getUser(request.auth.uid);
 if(authUser.disabled||!authUser.email||!authUser.providerData.some(p=>p.providerId==='password'))throw new HttpsError('permission-denied','An email/password account is required');
 const invite=data.invitationToken?await invitation(data.invitationToken):null;
 const company=invite||await resolveCompanyJoinCode(data.companyCode as string);
 const uid=request.auth.uid,ref=requests().doc(uid);
 const existingUser=(await admin.database().ref(`users/${uid}`).get()).val();
 if(existingUser?.companyId && (existingUser.companyId!==company.companyId||existingUser.employeeJoinUid!==uid))return refuse();
 const credential=await hashPasscodeScrypt(fields.passcode);
 const proposed={uid,email:authUser.email,companyId:company.companyId,companyName:company.companyName,
  displayName:fields.displayName,legalName:fields.legalName||fields.displayName,nameNorm:normalizeDisplayName(fields.displayName),
  driverId:randomUUID(),state:'pending',requestedAtMs:Date.now()};
 const row=await fs().runTransaction(async tx=>{
  const [prior,authority,appIndex,inv]=await Promise.all([tx.get(ref),tx.get(fs().collection('trusted_staff_authority').doc(uid)),
   tx.get(fs().collection('driver_name_index').doc(proposed.nameNorm)),invite?tx.get(invite.ref):Promise.resolve(null)]);
  if(prior.exists){const value=prior.data()!;if(value.companyId!==proposed.companyId||value.nameNorm!==proposed.nameNorm)return refuse();return value;}
  if(authority.exists||appIndex.exists)return refuse();
  if(invite&&(!inv?.exists||inv.data()?.active!==true||inv.data()!.expiresAtMs<=Date.now()||(inv.data()?.claimedBy&&inv.data()?.claimedBy!==uid)))throw new HttpsError('failed-precondition','Invitation is no longer available');
  tx.create(ref,proposed);tx.create(fs().collection('employee_join_credentials').doc(uid),{passcode:credential});
  tx.create(fs().collection('driver_name_index').doc(proposed.nameNorm),{driverId:proposed.driverId,employeeJoinUid:uid});
  if(invite)tx.update(invite.ref,{claimedBy:uid});return proposed;
 });
 if(row.state==='pending'){
  const result=await admin.database().ref(`users/${uid}`).transaction(prior=>{
   if(prior&&prior.employeeJoinUid!==uid&&(prior.companyId||prior.status==='active'))return undefined;
   if(prior?.status==='active')return prior;
   return {email:row.email,displayName:row.displayName,companyId:row.companyId,companyName:row.companyName,role:'driver',roles:['driver'],status:'pending',onboardingStatus:'pending_employee_approval',employeeJoinUid:uid};
  });
  if(!result.committed)return refuse();
 }
 return safe(row);
});
export const getEmployeeJoinStatus=onCall(options,async request=>{
 exactEmployeeInput(request.data,[]);if(!request.auth?.uid)throw new HttpsError('unauthenticated','Sign in first');
 const row=(await requests().doc(request.auth.uid).get()).data();return row?safe(row):{ok:true,status:'none'};
});
export const listEmployeeJoinRequests=onCall(options,async request=>{
 exactEmployeeInput(request.data,[]);const access=await actor(request);
 const snap=await requests().where('companyId','==',access.companyId).get();
 return {ok:true,requests:snap.docs.map(doc=>doc.data()).filter(r=>['pending','approving','ready'].includes(r.state))
  .map(r=>({uid:r.uid,displayName:r.displayName,legalName:r.legalName,email:r.email,status:r.state,requestedAtMs:r.requestedAtMs,roles:r.grant?.roles||['driver']}))};
});
export const resolveEmployeeJoin=onCall(options,async request=>{
 const access=await actor(request);const data=exactEmployeeInput(request.data,['uid','action','roles']);
 const uid=String(data.uid||'');if(!/^[A-Za-z0-9_-]{1,128}$/.test(uid)||uid===access.uid)throw new HttpsError('invalid-argument','Choose another employee');
 if(!['approve','reject'].includes(String(data.action)))throw new HttpsError('invalid-argument','Choose approve or reject');
 const grant=data.action==='approve'?employeeRoleGrant(data.roles,access.capabilities):null;
 const ref=requests().doc(uid);
 const row=await fs().runTransaction(async tx=>{
  const snap=await tx.get(ref);const prior=snap.data();
  if(!prior||prior.companyId!==access.companyId)throw new HttpsError('permission-denied','Request belongs to another company');
  if(prior.state==='complete'||prior.state==='rejected')return prior;
  if(data.action==='reject'){
   if(prior.state!=='pending')throw new HttpsError('failed-precondition','Approval is already in progress; retry it');
   const index=fs().collection('driver_name_index').doc(prior.nameNorm);const ix=await tx.get(index);
   if(ix.data()?.employeeJoinUid===uid&&ix.data()?.driverId===prior.driverId)tx.delete(index);
   tx.update(ref,{state:'rejected'});tx.delete(fs().collection('employee_join_credentials').doc(uid));return {...prior,state:'rejected'};
  }
  if(prior.state==='pending'){tx.update(ref,{state:'approving',grant,approvedBy:access.uid});return {...prior,state:'approving',grant};}
  if(JSON.stringify(prior.grant)!==JSON.stringify(grant))throw new HttpsError('failed-precondition','Retry approval with the original responsibilities');
  return prior;
 });
 if(row.state==='complete'||row.state==='rejected')return safe(row); // Never restore a later revoked membership on replay.
 const driverId=String(row.driverId),appUid=driverAuthUid(driverId);
 const credRef=fs().collection('driver_credentials').doc(driverId);
 if(row.state==='approving'){
  await fs().runTransaction(async tx=>{
   const index=fs().collection('driver_name_index').doc(row.nameNorm),pending=fs().collection('employee_join_credentials').doc(uid);
   const [ix,existing,secret]=await Promise.all([tx.get(index),tx.get(credRef),tx.get(pending)]);
   if(ix.exists&&ix.data()?.driverId!==driverId)throw new HttpsError('already-exists','App sign-in name is already registered');
   if(existing.exists&&existing.data()?.employeeJoinUid!==uid)return refuse();
   if(!secret.exists)return refuse();
   if(!ix.exists)tx.create(index,{driverId,displayName:row.displayName});
   if(!existing.exists)tx.create(credRef,{passcode:secret.data()!.passcode,displayNameNorm:row.nameNorm,active:false,employeeJoinUid:uid});
  });
  const profile=admin.database().ref(`drivers/profiles/${driverId}`);
  const result=await profile.transaction(prior=>{
   if(prior)return prior.employeeJoinUid===uid&&prior.companyId===row.companyId?prior:undefined;
   return {displayName:row.displayName,legalName:row.legalName,name:row.displayName,companyId:row.companyId,companyName:row.companyName,
    active:false,roles:row.grant.roles,isAdmin:row.grant.roles.includes('admin'),isViewer:row.grant.roles.includes('viewer'),employeeJoinUid:uid,dashboardUid:uid,employeeJoinState:'preparing'};
  });
  if(!result.committed)return refuse();
  assertEnsureAuthorityOk(await ensureInitializedEmptyShiftAuthority(fs(),{driverId,companyId:row.companyId}));
  if(await ensureDriverAuthUser(driverId,row.displayName)!==appUid)return refuse();
  await fs().runTransaction(async tx=>{
   const current=(await tx.get(ref)).data()!;
   const refs=[uid,appUid].map(id=>fs().collection('trusted_staff_authority').doc(id));
   const values=await Promise.all(refs.map(r=>tx.get(r)));
   if(current.state!=='approving')return;
   if(values.some(r=>r.exists))return refuse();
   refs.forEach((r,i)=>tx.create(r,{schemaVersion:1,uid:i===0?uid:appUid,companyId:row.companyId,active:true,capabilities:row.grant.capabilities}));
   tx.update(credRef,{active:true});tx.update(ref,{state:'ready'});
  });
 }
 // Ready means this request created these identities. Do not reactivate any
 // authority or credential that an administrator has since revoked.
 for(const id of [uid,appUid]){
  const auth=parseTrustedStaffAuthorityRecord((await fs().collection('trusted_staff_authority').doc(id).get()).data(),id);
  if(!auth.ok||auth.companyId!==row.companyId)return refuse();
 }
 if((await credRef.get()).data()?.active!==true)return refuse();
 const profile=admin.database().ref(`drivers/profiles/${driverId}`);
 const activated=await profile.transaction(prior=>{
  if(prior===null)return null;
  if(prior?.employeeJoinUid!==uid||prior.companyId!==row.companyId)return undefined;
  return {...prior,active:true,employeeJoinState:'complete'};
 });
 if(!activated.committed||activated.snapshot.val()?.active!==true)return refuse();
 const user=admin.database().ref(`users/${uid}`);
 const bound=await user.transaction(prior=>{
  if(prior&&prior.employeeJoinUid!==uid)return undefined;
  return {email:row.email,displayName:row.displayName,companyId:row.companyId,companyName:row.companyName,
   role:row.grant.role,roles:row.grant.roles,status:'active',onboardingStatus:'active',driverId,dashboardUid:uid,employeeJoinUid:uid};
 });
 if(!bound.committed)return refuse();
 await ref.update({state:'complete'});await fs().collection('employee_join_credentials').doc(uid).delete();
 return safe({...row,state:'complete'});
});

/** Keep later role edits on newly onboarded employees in step with server grants.
 * Legacy identities are untouched; a revoked grant is never reactivated here. */
export async function syncEmployeeResponsibilities(actorUid:string,targetUid:string,roles:unknown){
 const ref=requests().doc(targetUid),row=(await ref.get()).data();if(!row)return;
 const access=await actor({auth:{uid:actorUid}});
 if(row.state!=='complete'||row.companyId!==access.companyId||targetUid===actorUid)throw new HttpsError('permission-denied','Employee membership cannot be changed');
 const grant=employeeRoleGrant(roles,access.capabilities),appUid=driverAuthUid(row.driverId);
 await fs().runTransaction(async tx=>{
  const refs=[targetUid,appUid].map(id=>fs().collection('trusted_staff_authority').doc(id));
  const values=await Promise.all(refs.map(r=>tx.get(r)));
  const parsed=values.map((v,i)=>parseTrustedStaffAuthorityRecord(v.data(),i===0?targetUid:appUid));
  if(parsed.some(p=>!p.ok||p.companyId!==access.companyId))return refuse();
  refs.forEach(r=>tx.update(r,{capabilities:grant.capabilities}));tx.update(ref,{grant});
 });
 await admin.database().ref(`drivers/profiles/${row.driverId}`).update({roles:grant.roles,isAdmin:grant.roles.includes('admin'),isViewer:grant.roles.includes('viewer')});
}
