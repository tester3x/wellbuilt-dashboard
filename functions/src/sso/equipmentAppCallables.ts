import * as httpsV2 from 'firebase-functions/v2/https';
import { buildSsoDeps, SSO_CALLABLE_OPTIONS } from './ssoCallables';
import { issueEquipmentAppAccess, exchangeEquipmentAppAccess } from './equipmentAppAccess';
import { checkRateLimit, hashIp } from '../security/rateLimit';
import { SsoError } from './ssoDeps';
function failure(err: unknown): httpsV2.HttpsError {
  return err instanceof SsoError ? new httpsV2.HttpsError(err.code, err.publicCode)
    : new httpsV2.HttpsError('internal', 'unavailable');
}
export const issueEquipmentAppSession = httpsV2.onCall(SSO_CALLABLE_OPTIONS, async request => {
  if (!request.auth?.uid) throw new httpsV2.HttpsError('unauthenticated', 'not_authorized');
  if (!await checkRateLimit({ bucket: 'equipment_app_issue', key: request.auth.uid, limit: 20, windowMs: 600000 })) {
    throw new httpsV2.HttpsError('resource-exhausted', 'unavailable');
  }
  try { return await issueEquipmentAppAccess(buildSsoDeps(), {
    uid: request.auth.uid, claims: request.auth.token as Record<string, unknown>,
  }, request.data); } catch (err) { throw failure(err); }
});
export const exchangeEquipmentAppSession = httpsV2.onCall(SSO_CALLABLE_OPTIONS, async request => {
  if (!await checkRateLimit({ bucket: 'equipment_app_exchange', key: hashIp(request.rawRequest.ip), limit: 30, windowMs: 600000 })) {
    throw new httpsV2.HttpsError('resource-exhausted', 'invalid_grant');
  }
  try { return await exchangeEquipmentAppAccess(buildSsoDeps(), request.data); }
  catch (err) { throw failure(err); }
});
