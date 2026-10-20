import * as admin from 'firebase-admin';
import * as httpsV2 from 'firebase-functions/v2/https';
import {buildSsoDeps,SSO_CALLABLE_OPTIONS} from '../sso/ssoCallables';
import {SsoError} from '../sso/ssoDeps';
import {checkRateLimit,hashIp} from '../security/rateLimit';
import {issueDeviceAccount,exchangeDeviceAccount,revokeDeviceAccount,type DeviceAccountDeps} from './deviceAccount';
function deps():DeviceAccountDeps{return {...buildSsoDeps(),getAuthStatus:async uid=>{const u=await admin.auth().getUser(uid);return {disabled:u.disabled,validAfterMs:u.tokensValidAfterTime?Date.parse(u.tokensValidAfterTime):0};}};}
function error(e:unknown):never{if(e instanceof SsoError)throw new httpsV2.HttpsError(e.code,e.publicCode);throw new httpsV2.HttpsError('unavailable','Account service unavailable');}
export const platformIssueDeviceAccount=httpsV2.onCall(SSO_CALLABLE_OPTIONS,async req=>{
 if(!req.auth?.uid)throw new httpsV2.HttpsError('unauthenticated','driver_required');
 if(!await checkRateLimit({bucket:'platform_account_issue',key:req.auth.uid,limit:60,windowMs:600000}))throw new httpsV2.HttpsError('resource-exhausted','retry_later');
 try{return await issueDeviceAccount(deps(),{uid:req.auth.uid,claims:req.auth.token},req.data);}catch(e){return error(e);}
});
export const platformExchangeDeviceAccount=httpsV2.onCall(SSO_CALLABLE_OPTIONS,async req=>{
 if(!await checkRateLimit({bucket:'platform_account_exchange',key:hashIp(req.rawRequest.ip),limit:120,windowMs:600000}))throw new httpsV2.HttpsError('resource-exhausted','retry_later');
 try{return await exchangeDeviceAccount(deps(),req.data);}catch(e){return error(e);}
});
export const platformRevokeDeviceAccount=httpsV2.onCall(SSO_CALLABLE_OPTIONS,async req=>{
 try{return await revokeDeviceAccount(deps(),{uid:req.auth?.uid||null,claims:req.auth?.token||{}},req.data);}catch(e){return error(e);}
});
