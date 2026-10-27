import { canonicalFreshWaterGroups } from './canonicalFreshWater';
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from '../requireDriverAuth';
import { requireTrustedCompanyCapability } from '../trustedStaffAuthority';
import { loadCanonicalDriverAuthority, productionCanonicalDriverReaders } from '../canonicalDriverAuthority';
import { assertWbmWriter } from './viewerWriteGuard';
import { wellBelongsToDriverCompany } from './wbmWellScope';
import { evaluateFreshWaterRouteScope } from './freshWaterRouteScope';
import { applyFreshWaterDelivery, freshWaterAt, projectFreshWaterFeet, validFreshWaterConfig,
  type FreshWaterConfig, type FreshWaterDelivery,
  type FreshWaterState } from './freshWaterSupplyCore';

type TankGroup = { routeName: string; name: string; wellNames: string[]; config: FreshWaterConfig };
const unsafeKey = /[.#$\[\]/]/;
const validKey = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 150 && !unsafeKey.test(value);
const groupPath = (company: string) => `fresh_water_groups/${company}`;
const statePath = (company: string, id: string) => `fresh_water_supply/${company}/${id}`;
const validGroup = (value: unknown): value is TankGroup => !!value && typeof value === 'object'
  && !Array.isArray(value) && typeof (value as TankGroup).routeName === 'string'
  && (value as TankGroup).routeName.trim().length > 0
  && typeof (value as TankGroup).name === 'string'
  && (value as TankGroup).name.trim().length > 0
  && Array.isArray((value as TankGroup).wellNames)
  && (value as TankGroup).wellNames.length > 0
  && (value as TankGroup).wellNames.every(validKey)
  && validFreshWaterConfig((value as TankGroup).config);

async function authorizedGroups(request: httpsV2.CallableRequest, write: boolean) {
  const driver = await requireSecureDriver(request, { allowLegacyHash: false });
  const authority = await loadCanonicalDriverAuthority(driver.driverId, productionCanonicalDriverReaders());
  if (!authority?.active || !authority.companyId) throw new httpsV2.HttpsError('permission-denied', 'driver_inactive_or_unbound');
  const rtdb = admin.database();
  const profileSnap = await rtdb.ref(`drivers/profiles/${driver.driverId}`).once('value');
  if (!profileSnap.exists()) throw new httpsV2.HttpsError('failed-precondition', 'profile_missing');
  const profile = (profileSnap.val() || {}) as Record<string, unknown>;
  if (write) assertWbmWriter(profile, driver.roles);
  const freshScope = evaluateFreshWaterRouteScope(profile.assignedRoutes);
  if (!freshScope.ok) throw new httpsV2.HttpsError('permission-denied', freshScope.reason);
  const assignedFreshWaterRoutes = freshScope.routes;
  const [groupsSnap, wellsSnap] = await Promise.all([
    rtdb.ref(groupPath(authority.companyId)).once('value'), rtdb.ref('well_config').once('value'),
  ]);
  const legacyGroups = (groupsSnap.val() || {}) as Record<string, TankGroup>;
  const wells = (wellsSnap.val() || {}) as Record<string, Record<string, unknown>>;
  const groups = { ...legacyGroups, ...canonicalFreshWaterGroups(wells, authority.companyId) };
  const visible = Object.entries(groups).flatMap(([groupId, group]) => {
    if (!validKey(groupId) || !validGroup(group) || !assignedFreshWaterRoutes.has(group.routeName)
      || !group.wellNames.every(name => wells[name]
      && wellBelongsToDriverCompany(wells[name], authority.companyId))) return [];
    return [{ groupId, ...group }];
  });
  return { driver, companyId: authority.companyId, groups: visible };
}

/** A physical tank group has one inventory even when it supplies multiple wells. */
export const ingestWbmFreshWaterGroupDelivery = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false }, async request => {
    const data = request.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).some(key => !['groupId', 'deliveryId', 'deliveredAtUTC', 'deliveredBbl', 'measuredBeforeFeet', 'wellDown'].includes(key)))
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_delivery');
    const { groupId, deliveryId, deliveredAtUTC, deliveredBbl, measuredBeforeFeet, wellDown } = data;
    if (!validKey(groupId) || !validKey(deliveryId) || deliveryId.length > 128
      || typeof deliveredAtUTC !== 'string' || !Number.isFinite(Date.parse(deliveredAtUTC))
      || Date.parse(deliveredAtUTC) > Date.now() + 3_600_000
      || Date.parse(deliveredAtUTC) < Date.now() - 30 * 86_400_000
      || typeof deliveredBbl !== 'number' || !Number.isFinite(deliveredBbl) || deliveredBbl < 0 || deliveredBbl > 500
      || (wellDown !== undefined && typeof wellDown !== 'boolean')
      || (measuredBeforeFeet !== undefined && (typeof measuredBeforeFeet !== 'number' || !Number.isFinite(measuredBeforeFeet))))
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_delivery');
    const context = await authorizedGroups(request, true);
    const group = context.groups.find(item => item.groupId === groupId);
    if (!group) throw new httpsV2.HttpsError('permission-denied', 'tank_group_out_of_scope');
    const delivery: FreshWaterDelivery = { deliveryId, driverId: context.driver.driverId,
      deliveredAtUTC, deliveredBbl, ...(wellDown === undefined ? {} : {wellDown: wellDown as boolean}), ...(measuredBeforeFeet === undefined ? {} : { measuredBeforeFeet }) };
    let reason = '';
    let duplicate = false;
    const result = await admin.database().ref(statePath(context.companyId, groupId)).transaction(current => {
      const decision = applyFreshWaterDelivery(current as FreshWaterState | null, group.config, delivery);
      if (!decision.ok) { reason = decision.reason; return; }
      duplicate = decision.duplicate;
      return decision.state;
    });
    if (!result.committed) throw new httpsV2.HttpsError('failed-precondition', reason || 'delivery_conflict');
    const state = result.snapshot.val() as FreshWaterState;
    return { ok: true, duplicate, groupId, deliveryId, levelFeet: state.levelFeet,
      asOfUTC: state.asOfUTC, dailyUseBbl: state.dailyUseBbl ?? null };
  });

/** Empty request lists groups; groupId reads that group's current level. */
export const getWbmFreshWaterTankGroups = httpsV2.onCall(
  { timeoutSeconds: 20, memory: '256MiB', enforceAppCheck: false }, async request => {
    const data = request.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).some(key => !['groupId','atUTC'].includes(key))
      || (data.atUTC !== undefined && (typeof data.atUTC !== 'string' || !Number.isFinite(Date.parse(data.atUTC)))))
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_request');
    const context = await authorizedGroups(request, false);
    if (data.groupId === undefined) return { ok: true, groups: context.groups };
    const group = context.groups.find(item => item.groupId === data.groupId);
    if (!group) throw new httpsV2.HttpsError('permission-denied', 'tank_group_out_of_scope');
    const snap = await admin.database().ref(statePath(context.companyId, group.groupId)).once('value');
    const rawState = snap.exists() ? snap.val() as FreshWaterState : null;
    const atUTC = typeof data.atUTC === 'string' ? data.atUTC : new Date().toISOString();
    const state = rawState ? freshWaterAt(rawState,group.config,atUTC) : null;
    return { ok: true, ...group, status: state ? {
      isDown: state.isDown === true, levelFeet: state.levelFeet, asOfUTC: state.asOfUTC, dailyUseBbl: state.dailyUseBbl ?? null,
      projectedFeet: state.projectedFeet,
      lastMeasuredFeet: state.lastMeasuredFeet ?? null,
      lastMeasuredAtUTC: state.lastMeasuredAtUTC ?? null,
    } : null };
  });

/** Create/edit one tank group. A well cannot belong to two groups. */
export const staffConfigureFreshWaterTankGroup = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false }, async request => {
    await requireTrustedCompanyCapability(request.auth?.uid, 'manageWells');
    throw new httpsV2.HttpsError('failed-precondition', 'Use Add/Edit Well in the shared route builder.');
  });

/** Dispatch sees each tank group once, plus unlinked wells for setup. */
export const staffListFreshWaterTankGroups = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false }, async request => {
    const staff = await requireTrustedCompanyCapability(request.auth?.uid, 'viewDispatch');
    const rtdb = admin.database();
    const [wellsSnap, groupsSnap, statesSnap] = await Promise.all([
      rtdb.ref('well_config').once('value'), rtdb.ref(groupPath(staff.companyId)).once('value'),
      rtdb.ref(`fresh_water_supply/${staff.companyId}`).once('value'),
    ]);
    const wells = (wellsSnap.val() || {}) as Record<string, Record<string, unknown>>;
    const legacyGroups = (groupsSnap.val() || {}) as Record<string, TankGroup>;
    const states = (statesSnap.val() || {}) as Record<string, FreshWaterState>;
    const availableWells = Object.entries(wells).flatMap(([wellName, well]) =>
      well && wellBelongsToDriverCompany(well, staff.companyId)
        ? [{ wellName, route: String(well.route || ''), operator: String(well.operator || '') }] : []);
    const groups = { ...legacyGroups, ...canonicalFreshWaterGroups(wells, staff.companyId) };
    const now = new Date().toISOString();
    const tankGroups = Object.entries(groups).flatMap(([groupId, group]) => {
      if (!validKey(groupId) || !validGroup(group)
        || !group.wellNames.every(name => wells[name] && wellBelongsToDriverCompany(wells[name], staff.companyId))) return [];
      const status = states[groupId];
      const projectedFeet = status ? projectFreshWaterFeet(status, group.config, now) : null;
      const usableBbl = projectedFeet === null ? null : projectedFeet * group.config.tankCount * group.config.bblPerFootPerTank;
      const daysRemaining = usableBbl === null || status.dailyUseBbl == null || status.dailyUseBbl <= 0
        ? null : usableBbl / status.dailyUseBbl;
      return [{ groupId, routeName: group.routeName, name: group.name, wellNames: group.wellNames,
        producedWaterRoute: String(wells[group.wellNames[0]].route || ''),
        operator: String(wells[group.wellNames[0]].operator || ''),
        config: group.config, status: status ? { levelFeet: status.levelFeet, asOfUTC: status.asOfUTC,
          projectedFeet, dailyUseBbl: status.dailyUseBbl ?? null, daysRemaining } : null }];
    });
    return { ok: true, asOfUTC: now, wells: availableWells, groups: tankGroups };
  });
