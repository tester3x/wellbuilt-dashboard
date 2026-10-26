import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireTrustedCompanyCapability, TRUSTED_CAPABILITY_MANAGE_DRIVERS } from '../trustedStaffAuthority';
import { loadCanonicalDriverAuthority, productionCanonicalDriverReaders } from '../canonicalDriverAuthority';
import { primaryRouteUpdate } from './primaryRouteModel';
const ALLOWED = ['driverId', 'primaryRoutes', 'primaryAllRoutes', 'expectedRevision'];
export const staffGetPrimaryRouteAssignments = https.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false }, async request => {
    const staff = await requireTrustedCompanyCapability(request.auth?.uid, TRUSTED_CAPABILITY_MANAGE_DRIVERS);
    if (request.data && (typeof request.data !== 'object' || Object.keys(request.data).length))
      throw new https.HttpsError('invalid-argument', 'unexpected_field');
    const profiles = (await admin.database().ref('drivers/profiles').once('value')).val() || {};
    return { ok: true, profiles: Object.fromEntries(Object.entries(profiles)
      .filter(([, profile]: any) => profile.companyId === staff.companyId)
      .map(([id, profile]: any) => [id, { primaryRoutes: Array.isArray(profile.primaryRoutes) ? profile.primaryRoutes : [],
        primaryAllRoutes: profile.primaryAllRoutes === true, primaryRouteRevision: profile.primaryRouteRevision || 0 }])) };
  });
export const staffWritePrimaryRouteAssignment = https.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false }, async request => {
    const staff = await requireTrustedCompanyCapability(request.auth?.uid, TRUSTED_CAPABILITY_MANAGE_DRIVERS);
    const data = request.data;
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => !ALLOWED.includes(k))
      || typeof data.driverId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.driverId))
      throw new https.HttpsError('invalid-argument', 'invalid_primary_assignment');
    const authority = await loadCanonicalDriverAuthority(data.driverId, productionCanonicalDriverReaders());
    if (!authority?.active || authority.companyId !== staff.companyId)
      throw new https.HttpsError('permission-denied', 'driver_unavailable');
    const ref = admin.database().ref('drivers/profiles/' + data.driverId);
    const listener = () => {}; ref.on('value', listener);
    let result: { committed: boolean; snapshot: admin.database.DataSnapshot }, reason = 'driver_unavailable';
    try {
      await ref.once('value');
      result = await ref.transaction(current => {
        if (!current) return;
        try { return primaryRouteUpdate(current, staff.companyId, data, staff.uid, Date.now()); }
        catch (e) { reason = (e as Error).message; return; }
      });
    } finally { ref.off('value', listener); }
    if (!result.committed) throw new https.HttpsError(reason === 'primary_routes_changed' ? 'aborted' : 'failed-precondition', reason);
    const profile = result.snapshot.val();
    return { ok: true, driverId: data.driverId, primaryRoutes: profile.primaryRoutes || [],
      primaryAllRoutes: profile.primaryAllRoutes === true, primaryRouteRevision: profile.primaryRouteRevision };
  });
