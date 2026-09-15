/**
 * Shared self-scoped Route Me routing callable: getDriverRouteMe.
 *
 * Implements driver-self mode for Phase 1:
 * - WB-M / WB-T self mode: Authenticated driver via requireSecureDriver. Client supplies
 *   NO driverId or companyId; server derives canonical scope.
 * - Caller location validation: Caller supplies device origin (latitude, longitude, capturedAt, accuracy)
 *   strictly as routing data. If missing, stale (>15m), or inaccurate (>500m), returns LOCATION_REQUIRED.
 * - Dynamic projection rule (Gabriel-5):
 *   Route Me never consumes frozen Level, Time Till Pull, or copied currentLevel.
 *   At one immutable asOfMs, calculates live state strictly from raw post-pull baseline,
 *   authoritative observation timestamp, governed flow rate, and config trigger.
 * - Assisted routing leg sequencing:
 *   Evaluates Origin -> Pickup Well -> Disposal Site.
 *   In production, when governed road closures, approved corridors, and driver travel history
 *   are absent, returns honest fail-safe status ROUTE_UNVERIFIED / ROUTING_DATA_UNAVAILABLE
 *   with full per-leg contract.
 */

import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from '../requireDriverAuth';
import {
  loadCanonicalDriverAuthority,
  productionCanonicalDriverReaders,
} from '../canonicalDriverAuthority';
import { buildWbmBootstrapSnapshot } from './wbmBootstrap';
import { collectLatestOutgoingByWell } from './selectOutgoingStatus';
import {
  projectRouteMeLevelAndTtp,
  parseFeetDecimal,
  parseFlowMinutesPerFoot,
  parsePullTimeMs,
  calculateTargetFeet,
  RouteMeProjectionInputs,
} from './routeMeProjection';
import { recommendDisposal, DisposalRecord, NO_VERIFIED_DROPOFF } from './routeMeDisposal';
import { resolveWellAssignment, DispatchLike, RouteMeAssignmentState } from './routeMeAssignment';
import {
  validateDeviceLocation,
  sequencePickupAndDisposalLegs,
  RouteLeg,
  RouteVerificationStatus,
  CycleTimeEstimate,
  DeviceLocationInput,
  CandidateDisposal,
  WellRoutingContext,
} from './routeMeAssistedRouting';

export const DEFAULT_DDJD_PILOT_REASON = 'WB-T assignment not enabled yet';

export interface RouteMeWell {
  wellName: string;
  companyId: string;
  wellId: string;
  levelDisplay: string;
  timeTillPull: string;
  priorityState: 'pull-now' | 'approaching' | 'verify' | 'down' | 'no-gain';
  predictedReadyAtMs: number | null;
  pullsPerDay?: number;
  assignmentState: RouteMeAssignmentState;
  assignee?: string;
  muted: boolean;
  recommendedDisposal: string;
  routeVerificationStatus: RouteVerificationStatus;
  legs?: {
    originToPickup: RouteLeg;
    pickupToDisposal: RouteLeg;
  };
  cycleTimeEstimate?: CycleTimeEstimate;
}

export interface RouteMeCapabilities {
  canViewRouteMe: boolean;
  canCreateWbmPull: boolean;
  canCreateDdjd: boolean;
  ddjdUnavailableReason: string;
}

export interface RouteMeResult {
  ok: boolean;
  capabilities: RouteMeCapabilities;
  wells: RouteMeWell[];
  asOfMs: number | null;
  routeVerificationStatus?: RouteVerificationStatus;
  unavailableReason?: string;
  locationFailureReason?: string;
}

export function deniedRouteMeResult(reason: string, locationFailureReason?: string): RouteMeResult {
  return {
    ok: false,
    capabilities: {
      canViewRouteMe: false,
      canCreateWbmPull: false,
      canCreateDdjd: false,
      ddjdUnavailableReason: DEFAULT_DDJD_PILOT_REASON,
    },
    wells: [],
    asOfMs: null,
    unavailableReason: reason,
    locationFailureReason,
  };
}

export const getDriverRouteMe = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request): Promise<RouteMeResult> => {
    let resolvedDriverId: string;
    let resolvedCompanyId: string;

    const rawData = (request.data || {}) as Record<string, unknown>;

    // 1. Resolve Driver Self Mode (Phase 1 exposes driver-self mode only)
    try {
      const driver = await requireSecureDriver(request, { allowLegacyHash: false });
      resolvedDriverId = driver.driverId;
    } catch (err: any) {
      return deniedRouteMeResult(err?.message || 'Driver unauthenticated');
    }

    const authority = await loadCanonicalDriverAuthority(
      resolvedDriverId,
      productionCanonicalDriverReaders(),
    );
    if (!authority || !authority.active) {
      return deniedRouteMeResult('driver_inactive');
    }
    if (!authority.companyId) {
      return deniedRouteMeResult('company_required');
    }
    resolvedCompanyId = authority.companyId;

    // 2. Capture one immutable asOfMs for all wells and location checks in this evaluation
    const asOfMs = Date.now();

    // 3. Caller Device Origin Validation
    // Location is validated strictly as routing origin data. Scope remains 100% server-derived.
    const rawLoc = (rawData.location || rawData.deviceLocation) as DeviceLocationInput | undefined;
    const locValidation = validateDeviceLocation(rawLoc, asOfMs);
    if (!locValidation.valid) {
      return deniedRouteMeResult('LOCATION_REQUIRED', locValidation.reason);
    }
    const deviceOrigin = {
      lat: locValidation.latitude!,
      lng: locValidation.longitude!,
      label: 'Device Location',
    };

    // 4. Load Driver Profile and Evaluate Well Scope
    const db = admin.database();
    const profSnap = await db.ref(`drivers/profiles/${resolvedDriverId}`).once('value');
    if (!profSnap.exists()) {
      return deniedRouteMeResult('profile_missing');
    }
    const profile = (profSnap.val() || {}) as Record<string, unknown>;

    const wellSnap = await db.ref('well_config').once('value');
    const allWellConfig = wellSnap.exists() ? (wellSnap.val() as Record<string, unknown>) : {};

    const snap = buildWbmBootstrapSnapshot({
      driverId: resolvedDriverId,
      companyId: resolvedCompanyId,
      profile,
      wellConfig: allWellConfig,
    });

    if (snap.eligibilityStatus !== 'eligible') {
      return deniedRouteMeResult(snap.eligibilityReason);
    }

    const authorizedWellEntries = Object.entries(snap.wells);
    if (authorizedWellEntries.length === 0) {
      return {
        ok: true,
        capabilities: {
          canViewRouteMe: true,
          canCreateWbmPull: true,
          canCreateDdjd: false,
          ddjdUnavailableReason: DEFAULT_DDJD_PILOT_REASON,
        },
        wells: [],
        asOfMs,
        routeVerificationStatus: 'ROUTE_UNVERIFIED',
        unavailableReason: 'ROUTING_DATA_UNAVAILABLE',
      };
    }

    // 5. Load Outgoing Status, Active Dispatches, and Disposals in Parallel
    const fs = admin.firestore();
    const [outgoingSnap, dispatchesSnap, disposalsSnap] = await Promise.all([
      db.ref('packets/outgoing').once('value'),
      fs.collection('dispatches')
        .where('companyId', '==', resolvedCompanyId)
        .get()
        .catch(() => null),
      fs.collection('disposals').get().catch(() => null),
    ]);

    const latestByWell = collectLatestOutgoingByWell(
      outgoingSnap.exists() ? outgoingSnap.val() : {},
      resolvedCompanyId,
    );

    const activeDispatches: DispatchLike[] = [];
    if (dispatchesSnap && !dispatchesSnap.empty) {
      dispatchesSnap.forEach((doc) => {
        activeDispatches.push({ id: doc.id, ...(doc.data() as Record<string, unknown>) });
      });
    }

    const disposalsList: DisposalRecord[] = [];
    if (disposalsSnap && !disposalsSnap.empty) {
      disposalsSnap.forEach((doc) => {
        disposalsList.push({ id: doc.id, ...(doc.data() as Record<string, unknown>) });
      });
    }

    const candidateDisposals: CandidateDisposal[] = disposalsList.map((d) => ({
      id: d.id,
      name: d.name,
      well_name: d.well_name,
      companyId: d.companyId,
      operator: d.operator,
      waterType: d.waterType,
      lat: d.lat,
      lng: d.lng,
      isBlacklisted: d.isBlacklisted || d.blacklisted,
      unavailable: d.unavailable || d.active === false,
    }));

    // Filter candidate disposals by company/tenant eligibility
    const eligibleDisposals = candidateDisposals.filter((cd) => {
      if (cd.isBlacklisted || cd.unavailable) return false;
      if (cd.companyId && cd.companyId !== resolvedCompanyId) return false;
      return true;
    });

    // 6. Project and Route Each Authorized Well
    const wells: RouteMeWell[] = [];
    const seenWellIds = new Set<string>();

    for (const [configKey, rawConf] of Object.entries(allWellConfig)) {
      const conf = (rawConf || {}) as Record<string, unknown>;
      const wellCompany = typeof conf.companyId === 'string' ? conf.companyId.trim() : '';
      if (wellCompany !== resolvedCompanyId) continue;

      const wellName = typeof conf.wellName === 'string' && conf.wellName.trim()
        ? conf.wellName.trim()
        : configKey;
      const wellId = typeof conf.wellId === 'string' && conf.wellId.trim()
        ? conf.wellId.trim()
        : (typeof conf.id === 'string' && conf.id.trim() ? conf.id.trim() : configKey);

      // Verify this well is in the driver's authorized scope (snap.wells)
      if (!snap.wells[configKey] && !snap.wells[wellName] && !snap.wells[wellId]) {
        continue;
      }

      if (seenWellIds.has(wellId)) continue;
      seenWellIds.add(wellId);

      // Resolve config dimensions for target level
      const bottomFeet = typeof conf.bottomLevel === 'number'
        ? conf.bottomLevel
        : parseFeetDecimal(conf.bottomLevel) || 3;
      const pullBbls = typeof conf.pullBbls === 'number' ? conf.pullBbls : 140;
      const tanks = typeof conf.tanks === 'number' ? conf.tanks : 1;
      const bblPerFoot = typeof conf.bblPerFoot === 'number' && conf.bblPerFoot > 0
        ? conf.bblPerFoot
        : 20 * tanks;
      const targetFeet = calculateTargetFeet({
        allowedBottomFeet: bottomFeet,
        pullBbls,
        bblPerFoot,
      });

      // Outgoing status lookup
      const outgoing = (
        latestByWell.get(wellName) ||
        latestByWell.get(wellId) ||
        latestByWell.get(configKey) ||
        {}
      ) as Record<string, unknown>;

      const lastPullBottomLevel = outgoing.lastPullBottomLevel || conf.lastPullBottomLevel;
      const lastPullTimeUTC = outgoing.lastPullDateTimeUTC || outgoing.timestampUTC || conf.lastPullDateTimeUTC;
      const flowRate = outgoing.flowRate || conf.avgFlowRate;
      const afrMinutes = typeof conf.avgFlowRateMinutes === 'number'
        ? conf.avgFlowRateMinutes
        : (typeof outgoing.avgFlowRateMinutes === 'number' ? outgoing.avgFlowRateMinutes : null);

      const wellDown = Boolean(outgoing.wellDown || conf.wellDown || conf.isDown);

      // Mandatory Projection Rule:
      // Calculate strictly from raw post-pull baseline, authoritative timestamp, and governed flow.
      const startingBottomFeet = parseFeetDecimal(lastPullBottomLevel);
      const pullTimeMs = parsePullTimeMs(lastPullTimeUTC);
      const flowMinutesPerFoot = parseFlowMinutesPerFoot(flowRate) || (afrMinutes && afrMinutes >= 1 ? afrMinutes : null);

      const projInputs: RouteMeProjectionInputs = {
        startingBottomFeet,
        pullTimeMs,
        flowMinutesPerFoot,
        wellDown,
        targetFeet,
      };

      const proj = projectRouteMeLevelAndTtp(projInputs, asOfMs);

      // Assignment state
      const assign = resolveWellAssignment(
        { wellName, wellId, companyId: resolvedCompanyId },
        activeDispatches,
        resolvedDriverId,
      );

      // Disposal recommendation (5-rule engine)
      const recommendedDisposal = recommendDisposal(
        disposalsList,
        {
          wellName,
          companyId: resolvedCompanyId,
          wellId,
          operator: typeof conf.operator === 'string' ? conf.operator : undefined,
          waterType: typeof conf.waterType === 'string' ? conf.waterType : undefined,
          preferredDisposal: typeof conf.preferredDisposal === 'string' ? conf.preferredDisposal : undefined,
        },
      );

      // Assisted routing leg sequencing & cycle time
      const wellRoutingCtx: WellRoutingContext = {
        wellName,
        wellId,
        companyId: resolvedCompanyId,
        lat: typeof conf.latitude === 'number' ? conf.latitude : undefined,
        lng: typeof conf.longitude === 'number' ? conf.longitude : undefined,
        predictedReadyAtMs: proj.predictedReadyAtMs,
        priorityState: proj.priorityState,
      };

      // In production, governed routing sources (closures, corridors, travel history) do not exist yet.
      // Pass undefined repo so it safely evaluates to the honest fail-safe contract (ROUTE_UNVERIFIED).
      const seqResult = sequencePickupAndDisposalLegs(
        deviceOrigin,
        wellRoutingCtx,
        eligibleDisposals,
        recommendedDisposal !== NO_VERIFIED_DROPOFF ? recommendedDisposal : null,
        asOfMs,
        undefined,
      );

      wells.push({
        wellName,
        companyId: resolvedCompanyId,
        wellId,
        levelDisplay: proj.levelDisplay,
        timeTillPull: proj.timeTillPull,
        priorityState: proj.priorityState,
        predictedReadyAtMs: proj.predictedReadyAtMs,
        pullsPerDay: typeof outgoing.pullsPerDay === 'number' ? outgoing.pullsPerDay : undefined,
        assignmentState: assign.assignmentState,
        assignee: assign.assignee,
        muted: assign.muted,
        recommendedDisposal: seqResult.selectedDisposalName || recommendedDisposal,
        routeVerificationStatus: seqResult.routeVerificationStatus,
        legs: {
          originToPickup: seqResult.originToPickupLeg,
          pickupToDisposal: seqResult.pickupToDisposalLeg,
        },
        cycleTimeEstimate: seqResult.cycleTime,
      });
    }

    // 7. Ordering: Order by predictedReadyAtMs ascending (earliest ready / ready now first, nulls at end)
    wells.sort((a, b) => {
      if (a.predictedReadyAtMs !== null && b.predictedReadyAtMs !== null) {
        return a.predictedReadyAtMs - b.predictedReadyAtMs;
      }
      if (a.predictedReadyAtMs !== null) return -1;
      if (b.predictedReadyAtMs !== null) return 1;
      return a.wellName.localeCompare(b.wellName);
    });

    return {
      ok: true,
      capabilities: {
        canViewRouteMe: true,
        canCreateWbmPull: true,
        canCreateDdjd: false, // Phase 1 pilot: visual-only
        ddjdUnavailableReason: DEFAULT_DDJD_PILOT_REASON,
      },
      wells,
      asOfMs,
      routeVerificationStatus: 'ROUTE_UNVERIFIED',
      unavailableReason: 'ROUTING_DATA_UNAVAILABLE',
    };
  },
);
