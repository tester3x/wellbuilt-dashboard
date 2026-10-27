import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from '../requireDriverAuth';
import { requireTrustedCompanyCapability } from '../trustedStaffAuthority';
import { writeSecurityAudit } from '../audit';
import { loadCanonicalDriverAuthority, productionCanonicalDriverReaders } from '../canonicalDriverAuthority';
import { assertWbmWriter } from './viewerWriteGuard';
import { evaluateWbmWellScope, wellBelongsToDriverCompany, wellMatchesWbmScope } from './wbmWellScope';
import { applyFreshWaterDelivery, projectFreshWaterFeet, validFreshWaterConfig,
  type FreshWaterConfig, type FreshWaterDelivery, type FreshWaterState } from './freshWaterSupplyCore';

const unsafeKey = /[.#$\[\]/]/;

async function authorizedPad(request: httpsV2.CallableRequest, wellName: string, write: boolean) {
  if (!wellName || wellName.length > 150 || unsafeKey.test(wellName)) {
    throw new httpsV2.HttpsError('invalid-argument', 'invalid_wellName');
  }
  const driver = await requireSecureDriver(request, { allowLegacyHash: false });
  const authority = await loadCanonicalDriverAuthority(driver.driverId, productionCanonicalDriverReaders());
  if (!authority?.active || !authority.companyId) {
    throw new httpsV2.HttpsError('permission-denied', 'driver_inactive_or_unbound');
  }
  const profileSnap = await admin.database().ref(`drivers/profiles/${driver.driverId}`).once('value');
  if (!profileSnap.exists()) throw new httpsV2.HttpsError('failed-precondition', 'profile_missing');
  const profile = (profileSnap.val() || {}) as Record<string, unknown>;
  if (write) assertWbmWriter(profile, driver.roles);
  const scope = evaluateWbmWellScope(profile.assignedRoutes, profile.assignedWells);
  if (!scope.ok) throw new httpsV2.HttpsError('permission-denied', scope.reason);
  const wellSnap = await admin.database().ref(`well_config/${wellName}`).once('value');
  if (!wellSnap.exists()) throw new httpsV2.HttpsError('not-found', 'well_not_found');
  const well = (wellSnap.val() || {}) as Record<string, unknown>;
  if (!wellBelongsToDriverCompany(well, authority.companyId)
    || !wellMatchesWbmScope(wellName, well, scope)) {
    throw new httpsV2.HttpsError('permission-denied', 'well_out_of_scope');
  }
  const config = well.freshWaterSupply;
  if (!validFreshWaterConfig(config)) {
    throw new httpsV2.HttpsError('failed-precondition', 'fresh_water_pad_not_configured');
  }
  return { driver, companyId: authority.companyId, config: config as FreshWaterConfig };
}

/** A WB-M fresh-water delivery is a single load and never a PW pull packet. */
export const ingestWbmFreshWaterDelivery = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = request.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).some(key => !['wellName', 'deliveryId', 'deliveredAtUTC', 'deliveredBbl', 'measuredBeforeFeet'].includes(key))) {
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_delivery');
    }
    const wellName = typeof data.wellName === 'string' ? data.wellName.trim() : '';
    const deliveryId = typeof data.deliveryId === 'string' ? data.deliveryId.trim() : '';
    const deliveredAtUTC = typeof data.deliveredAtUTC === 'string' ? data.deliveredAtUTC : '';
    if (!deliveryId || deliveryId.length > 128 || unsafeKey.test(deliveryId)
      || typeof data.deliveredBbl !== 'number' || !Number.isFinite(data.deliveredBbl)
      || data.deliveredBbl <= 0 || data.deliveredBbl > 500
      || !Number.isFinite(Date.parse(deliveredAtUTC))
      || Date.parse(deliveredAtUTC) > Date.now() + 60 * 60 * 1000
      || Date.parse(deliveredAtUTC) < Date.now() - 30 * 86_400_000
      || (data.measuredBeforeFeet !== undefined && (typeof data.measuredBeforeFeet !== 'number'
        || !Number.isFinite(data.measuredBeforeFeet)))) {
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_delivery');
    }
    const pad = await authorizedPad(request, wellName, true);
    const delivery: FreshWaterDelivery = {
      deliveryId, driverId: pad.driver.driverId, deliveredAtUTC,
      deliveredBbl: data.deliveredBbl,
      ...(data.measuredBeforeFeet !== undefined ? { measuredBeforeFeet: data.measuredBeforeFeet as number } : {}),
    };
    const ref = admin.database().ref(`fresh_water_supply/${pad.companyId}/${wellName}`);
    let reason = '';
    let duplicate = false;
    const result = await ref.transaction(current => {
      const decided = applyFreshWaterDelivery(current as FreshWaterState | null, pad.config, delivery);
      if (!decided.ok) { reason = decided.reason; return; }
      duplicate = decided.duplicate;
      return decided.state;
    });
    if (!result.committed) {
      throw new httpsV2.HttpsError(reason === 'tank_overflow' || reason === 'stale_delivery'
        || reason === 'id_collision' ? 'failed-precondition' : 'invalid-argument', reason || 'delivery_conflict');
    }
    const state = result.snapshot.val() as FreshWaterState;
    return { ok: true, duplicate, deliveryId, levelFeet: state.levelFeet,
      asOfUTC: state.asOfUTC, dailyUseBbl: state.dailyUseBbl };
  },
);

/** Read the pad-specific fresh-water inventory without exposing its ledger. */
export const getWbmFreshWaterSupply = httpsV2.onCall(
  { timeoutSeconds: 20, memory: '256MiB', enforceAppCheck: false },
  async request => {
    const data = request.data as Record<string, unknown> | null;
    if (!data || Object.keys(data).some(key => key !== 'wellName')) {
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_request');
    }
    const wellName = typeof data.wellName === 'string' ? data.wellName.trim() : '';
    const pad = await authorizedPad(request, wellName, false);
    const snap = await admin.database().ref(`fresh_water_supply/${pad.companyId}/${wellName}`).once('value');
    const state = snap.exists() ? snap.val() as FreshWaterState : null;
    return { ok: true, wellName,
      config: pad.config,
      status: state ? {
        levelFeet: state.levelFeet, asOfUTC: state.asOfUTC, dailyUseBbl: state.dailyUseBbl,
        projectedFeet: projectFreshWaterFeet(state, pad.config, new Date().toISOString()),
        lastMeasuredFeet: state.lastMeasuredFeet ?? null,
        lastMeasuredAtUTC: state.lastMeasuredAtUTC ?? null,
      } : null,
    };
  },
);

/** Staff configures a pad's independent FW tanks and may seed its first reading.
 * Existing inventory is never overwritten by a configuration update.
 */
export const staffConfigureFreshWaterPad = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async request => {
    const staff = await requireTrustedCompanyCapability(request.auth?.uid, 'manageWells');
    const data = request.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).some(key => !['wellName', 'config', 'initialLevelFeet'].includes(key))) {
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_request');
    }
    const wellName = typeof data.wellName === 'string' ? data.wellName.trim() : '';
    if (!wellName || wellName.length > 150 || unsafeKey.test(wellName)) {
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_wellName');
    }
    if (!validFreshWaterConfig(data.config)) {
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_fresh_water_config');
    }
    const config = data.config as FreshWaterConfig;
    if (data.initialLevelFeet !== undefined && (typeof data.initialLevelFeet !== 'number'
      || !Number.isFinite(data.initialLevelFeet) || data.initialLevelFeet < 0
      || data.initialLevelFeet > config.tankHeightFeet)) {
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_initial_level');
    }
    const rtdb = admin.database();
    const wellRef = rtdb.ref(`well_config/${wellName}`);
    const wellSnap = await wellRef.once('value');
    if (!wellSnap.exists()) throw new httpsV2.HttpsError('not-found', 'well_not_found');
    const well = wellSnap.val() as Record<string, unknown>;
    if (!wellBelongsToDriverCompany(well, staff.companyId)) {
      throw new httpsV2.HttpsError('permission-denied', 'cross_company_well');
    }
    const activeSnap = await rtdb.ref(`fresh_water_supply/${staff.companyId}/${wellName}`).once('value');
    const priorConfig = well.freshWaterSupply as Partial<FreshWaterConfig> | undefined;
    if (activeSnap.exists() && (!priorConfig || priorConfig.tankCount !== config.tankCount
      || priorConfig.tankHeightFeet !== config.tankHeightFeet
      || priorConfig.bblPerFootPerTank !== config.bblPerFootPerTank
      || priorConfig.dailyUseBbl !== config.dailyUseBbl)) {
      throw new httpsV2.HttpsError('failed-precondition', 'active_pad_config_requires_migration');
    }
    await wellRef.child('freshWaterSupply').set(config);
    let seeded = false;
    if (typeof data.initialLevelFeet === 'number') {
      const stateRef = rtdb.ref(`fresh_water_supply/${staff.companyId}/${wellName}`);
      const atUTC = new Date().toISOString();
      const result = await stateRef.transaction(current => {
        if (current) return;
        const state: FreshWaterState = {
          seedLevelFeet: data.initialLevelFeet as number,
          seedAtUTC: atUTC,
          seedDailyUseBbl: config.dailyUseBbl,
          levelFeet: data.initialLevelFeet as number,
          asOfUTC: atUTC,
          dailyUseBbl: config.dailyUseBbl,
          lastMeasuredFeet: data.initialLevelFeet as number,
          lastMeasuredAtUTC: atUTC,
          deliveredSinceMeasurementBbl: 0,
          deliveries: {},
        };
        return state;
      });
      seeded = result.committed;
    }
    await writeSecurityAudit({ action: 'staffConfigureFreshWaterPad', actorUid: staff.uid,
      detail: { companyId: staff.companyId, wellName, seeded } });
    return { ok: true, wellName, seeded };
  },
);

/** Company-scoped dispatch queue. Sort on the client by projected remaining days. */
export const staffListFreshWaterPads = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async request => {
    const staff = await requireTrustedCompanyCapability(request.auth?.uid, 'viewDispatch');
    const rtdb = admin.database();
    const [wellsSnap, statesSnap] = await Promise.all([
      rtdb.ref('well_config').once('value'),
      rtdb.ref(`fresh_water_supply/${staff.companyId}`).once('value'),
    ]);
    const wells = (wellsSnap.val() || {}) as Record<string, Record<string, unknown>>;
    const states = (statesSnap.val() || {}) as Record<string, FreshWaterState>;
    const now = new Date().toISOString();
    const pads = Object.entries(wells).flatMap(([wellName, well]) => {
      if (!well || !wellBelongsToDriverCompany(well, staff.companyId)) return [];
      const config = validFreshWaterConfig(well.freshWaterSupply)
        ? well.freshWaterSupply as FreshWaterConfig : null;
      const status = states[wellName];
      const projectedFeet = status && config ? projectFreshWaterFeet(status, config, now) : null;
      const usableBbl = projectedFeet === null || !config ? null : projectedFeet * config.tankCount * config.bblPerFootPerTank;
      const daysRemaining = usableBbl === null || status.dailyUseBbl <= 0 ? null : usableBbl / status.dailyUseBbl;
      return [{ wellName, route: typeof well.route === 'string' ? well.route : '',
        operator: typeof well.operator === 'string' ? well.operator : '',
        config, status: status ? { levelFeet: status.levelFeet, asOfUTC: status.asOfUTC,
          projectedFeet, dailyUseBbl: status.dailyUseBbl, daysRemaining } : null }];
    });
    return { ok: true, asOfUTC: now, pads };
  },
);
