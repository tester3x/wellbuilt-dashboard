/** Device account exchange; no refresh token/password is copied between apps. */
import {SsoError,type SsoAuthContext,type SsoDeps} from '../sso/ssoDeps';
import {decideAppEntitlementAuthorization} from '../sso/appEntitlementAuthorization';
import {decideJsaAccess} from '../sso/jsaAuthorization';
import {decideResolve} from '../security/operational/shiftAuthority';
import {resolveWellbuiltAppKey} from '@tester3x/wellbuilt-contracts';
export const DEVICE_APPS=['suite','tickets','mobile','jsa','equipment','etc','tickettime'] as const;
export type DeviceApp=typeof DEVICE_APPS[number];
const audiences:Record<DeviceApp,string|null>={suite:null,tickets:'wbt',mobile:'wbm',jsa:'jsa',equipment:'equipment',etc:null,tickettime:null};
const keys:Record<DeviceApp,string>={suite:'wellbuilt-suite',tickets:'wellbuilt-tickets',mobile:'wellbuilt-mobile',jsa:'wellbuilt-jsa',equipment:'wellbuilt-equipment',etc:'wellbuilt-suite',tickettime:'wellbuilt-suite'};
export interface DeviceAccountDeps extends SsoDeps {
 getAuthStatus(uid:string):Promise<{disabled:boolean;validAfterMs:number}>;
}
function fail(code:'permission-denied'|'unauthenticated'|'invalid-argument',reason:string):never {throw new SsoError(code,reason,reason);}
function request(raw:unknown,fields:string[]):Record<string,unknown> {
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!fields.includes(k))||(raw as any).version!==1)fail('invalid-argument','malformed_request');
 return raw as Record<string,unknown>;
}
const secret=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v);
async function snapshot(deps:DeviceAccountDeps,owner:{uid:string;driverId:string;companyId:string},establishedAtMs:number,grantId:string){
 const [driver,status,company]=await Promise.all([deps.getDriver(owner.driverId),deps.getAuthStatus(owner.uid),deps.getCompanyContract(owner.companyId)]);
 if(!driver?.active||driver.companyId!==owner.companyId||status.disabled||status.validAfterMs>establishedAtMs)fail('permission-denied','account_unavailable');
 const plan=company.contract?await deps.getPlan(company.contract.planId):null;
 const allowedApps=DEVICE_APPS.filter(app=>{
  const d=decideAppEntitlementAuthorization({app:resolveWellbuiltAppKey(keys[app]),contractState:company.state,contract:company.contract,plan,shift:null});
  // Entry is browsing, not authorization to perform a governed shift command.
  return d.ok||d.refusal==='active_shift_required';
 });
 return {version:1 as const,grantId,owner,establishedAtMs,checkedAtMs:deps.nowMs(),allowedApps,
  profile:{displayName:driver.displayName,legalName:driver.legalName||null}};
}
export async function issueDeviceAccount(deps:DeviceAccountDeps,auth:SsoAuthContext,raw:unknown){
 request(raw,['version']);
 const c=auth.claims;
 if(!auth.uid||c.kind!=='driver'||typeof c.driverId!=='string'||!c.driverId||typeof c.companyId!=='string'||!c.companyId)fail('unauthenticated','driver_required');
 const owner={uid:auth.uid,driverId:c.driverId,companyId:c.companyId};
 const credential=deps.base64Url(deps.randomBytes(32)),grantId=deps.sha256Hex(credential),establishedAtMs=deps.nowMs();
 const access=await snapshot(deps,owner,establishedAtMs,grantId);
 const expiresAtMs=establishedAtMs+90*86400000;
 await deps.runTransaction(async tx=>tx.create('platform_device_accounts/'+grantId,{version:1,...owner,establishedAtMs,expiresAtMs,expiresAt:deps.expiresAtTimestamp(expiresAtMs),revoked:false}));
 return {credential,access};
}
export async function exchangeDeviceAccount(deps:DeviceAccountDeps,raw:unknown){
 const r=request(raw,['version','credential','app']);
 if(!secret(r.credential)||!DEVICE_APPS.includes(r.app as DeviceApp))fail('invalid-argument','malformed_request');
 const app=r.app as DeviceApp,grantId=deps.sha256Hex(r.credential);
 const row=await deps.runTransaction(async tx=>{const row=await tx.get('platform_device_accounts/'+grantId);return row.exists?row.data:null;});
 if(!row||row.version!==1||row.revoked!==false||typeof row.uid!=='string'||typeof row.driverId!=='string'||typeof row.companyId!=='string'||typeof row.establishedAtMs!=='number'||typeof row.expiresAtMs!=='number'||deps.nowMs()>=row.expiresAtMs)fail('permission-denied','device_account_unavailable');
 const owner={uid:row.uid,driverId:row.driverId,companyId:row.companyId};
 const access=await snapshot(deps,owner,row.establishedAtMs,grantId);
 if(!access.allowedApps.includes(app))fail('permission-denied','app_unavailable');
 let jsaBinding:unknown;
 if(app==='jsa'){
  const company=await deps.getCompanyContract(owner.companyId),plan=company.contract?await deps.getPlan(company.contract.planId):null;
  const jsa=decideJsaAccess({contractState:company.state,contract:company.contract,plan,shift:decideResolve(await deps.getShiftAuthority(owner.driverId),owner)});
  if(!jsa.ok)fail('permission-denied','jsa_authority_unavailable');
  jsaBinding=jsa.binding;
 }
 const marker=audiences[app];
 const customToken=await deps.mintCustomToken(owner.uid,{kind:'driver',driverId:owner.driverId,companyId:owner.companyId,...(marker?{app:marker}:{})});
 return {version:1,customToken,access,...(jsaBinding?{jsaBinding}:{})};
}
export async function revokeDeviceAccount(deps:DeviceAccountDeps,auth:SsoAuthContext,raw:unknown){
 const r=request(raw,['version','grantId','credential']);
 if(typeof r.grantId!=='string'||!/^[a-f0-9]{64}$/.test(r.grantId))fail('unauthenticated','account_required');
 const credentialMatches=secret(r.credential)&&deps.sha256Hex(r.credential)===r.grantId;
 await deps.runTransaction(async tx=>{const path='platform_device_accounts/'+r.grantId,row=await tx.get(path);if(!row.exists)return;
  if(!credentialMatches&&(!auth.uid||row.data?.uid!==auth.uid))fail('permission-denied','account_mismatch');tx.update(path,{revoked:true});});
 return {ok:true};
}

export async function refreshDeviceAccount(deps:DeviceAccountDeps,auth:SsoAuthContext,raw:unknown){
 const r=request(raw,['version','grantId']);
 if(!auth.uid||typeof r.grantId!=='string'||!/^[a-f0-9]{64}$/.test(r.grantId))fail('unauthenticated','account_required');
 const row=await deps.runTransaction(async tx=>{const found=await tx.get('platform_device_accounts/'+r.grantId);return found.exists?found.data:null;});
 if(!row||row.uid!==auth.uid||auth.claims.driverId!==row.driverId||auth.claims.companyId!==row.companyId||row.revoked!==false||typeof row.establishedAtMs!=='number'||typeof row.expiresAtMs!=='number'||deps.nowMs()>=row.expiresAtMs)fail('permission-denied','device_account_unavailable');
 return {access:await snapshot(deps,{uid:row.uid as string,driverId:row.driverId as string,companyId:row.companyId as string},row.establishedAtMs,r.grantId)};
}
