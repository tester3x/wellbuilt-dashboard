import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { createHash } from 'crypto';
import { requireSecureDriver } from '../requireDriverAuth';
import { loadCanonicalDriverAuthority, productionCanonicalDriverReaders } from '../canonicalDriverAuthority';
import { tankInfoAuthority, tankInfoPatch, tankInfoProjection, type Row } from './tankInfoModel';

function requestData(raw: any, keys: string[]): Row {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !keys.includes(k)))
    throw new https.HttpsError('invalid-argument', 'invalid_request');
  if (typeof raw.wellName !== 'string' || !raw.wellName.trim() || raw.wellName.length > 200
    || /[.$#[\]\/]/.test(raw.wellName)) throw new https.HttpsError('invalid-argument', 'invalid_well');
  return raw;
}
async function context(request: any, keys: string[]) {
  const raw = requestData(request.data, keys);
  const driver = await requireSecureDriver(request, { allowLegacyHash: false });
  const authority = await loadCanonicalDriverAuthority(driver.driverId, productionCanonicalDriverReaders());
  if (!authority?.active) throw new https.HttpsError('permission-denied', 'driver_inactive');
  const db = admin.database();
  const profile = (await db.ref('drivers/profiles/' + driver.driverId).once('value')).val() || {};
  if (profile.active === false || profile.companyId !== authority.companyId)
    throw new https.HttpsError('permission-denied', 'driver_inactive');
  const ref = db.ref('well_config/' + raw.wellName);
  const well = (await ref.once('value')).val();
  if (!well) throw new https.HttpsError('not-found', 'well_not_found');
  const permissions = tankInfoAuthority(profile, { ...well, wellName: raw.wellName }, driver.driverId, authority.companyId);
  if (!permissions.canView) throw new https.HttpsError('permission-denied', 'well_not_assigned');
  return { raw, driver, authority, profile, ref, well, permissions, db };
}
async function present(ctx: Awaited<ReturnType<typeof context>>, well = ctx.well) {
  const profiles: Row = (await ctx.db.ref('drivers/profiles').once('value')).val() || {};
  const inCompany = Object.entries(profiles).filter(([, p]: any) => p?.companyId === ctx.authority.companyId && p.active !== false);
  const owners = inCompany.filter(([, p]: any) => p.primaryAllRoutes === true || (Array.isArray(p.primaryRoutes) && p.primaryRoutes.includes(well.route)));
  return { ok: true, wellName: ctx.raw.wellName, config: tankInfoProjection(well), ...ctx.permissions,
    primaryDrivers: owners.map(([id, p]: any) => ({ id, name: p.displayName || id, allRoutes: p.primaryAllRoutes === true })),
    };
}
const options = { timeoutSeconds: 30, memory: '256MiB' as const, enforceAppCheck: false };
export const getWbmTankInfo = https.onCall(options, async request => present(await context(request, ['wellName'])));

export const saveWbmTankInfo = https.onCall(options, async request => {
  const ctx = await context(request, ['wellName', 'operationId', 'expectedRevision', 'patch']);
  const { operationId, expectedRevision, patch } = ctx.raw;
  if (typeof operationId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(operationId)
    || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new https.HttpsError('invalid-argument', 'invalid_operation');
  const digest = createHash('sha256').update(JSON.stringify([expectedRevision,
    Object.entries(patch || {}).sort(([a], [b]) => a.localeCompare(b))])).digest('hex');
  const receipt = ctx.well.tankInfoEdits?.[operationId];
  if (receipt?.digest === digest && receipt.driverId === ctx.driver.driverId)
    return { ...await present(ctx), operationId };
  if (!ctx.permissions.canEdit) throw new https.HttpsError('permission-denied', 'tank_info_edit_forbidden');
  let refusal = 'tank_info_conflict';
  const now = Date.now();
  const listener = () => {}; ctx.ref.on('value', listener);
  let result: { committed: boolean; snapshot: admin.database.DataSnapshot };
  try {
    await ctx.ref.once('value');
    result = await ctx.ref.transaction((current: Row | null) => {
      if (!current) { refusal = 'well_not_found'; return; }
      if (current.route !== ctx.well.route || !tankInfoAuthority(ctx.profile, current, ctx.driver.driverId, ctx.authority.companyId).canEdit) {
        refusal = 'tank_info_edit_forbidden'; return;
      }
      const previous = current.tankInfoEdits?.[operationId];
      if (previous) {
        if (previous.digest === digest && previous.driverId === ctx.driver.driverId) return current;
        refusal = 'operation_reused'; return;
      }
      if ((current.tankInfoRevision || 0) !== expectedRevision) return;
      let updated: Row;
      try { updated = tankInfoPatch(current, patch); } catch (e) { refusal = (e as Error).message; return; }
      const revision = expectedRevision + 1;
      return { ...current, ...updated, tankInfoRevision: revision, tankInfoUpdatedAt: now,
        tankInfoUpdatedBy: ctx.profile.displayName || ctx.driver.driverId,
        ...(updated.bblPerFoot !== undefined && updated.bblPerFoot !== current.bblPerFoot
          ? { tankCalibrationChangedAt: now } : {}),
        tankInfoEdits: { ...current.tankInfoEdits, [operationId]: { digest, driverId: ctx.driver.driverId,
          actorUid: ctx.driver.uid, at: now, revision, before: tankInfoProjection(current), patch: updated } } };
    });
  } finally { ctx.ref.off('value', listener); }
  if (!result.committed) throw new https.HttpsError(refusal === 'tank_info_conflict' ? 'aborted'
    : refusal === 'tank_info_edit_forbidden' ? 'permission-denied' : 'invalid-argument', refusal);
  return { ...await present(ctx, result.snapshot.val()), operationId };
});
