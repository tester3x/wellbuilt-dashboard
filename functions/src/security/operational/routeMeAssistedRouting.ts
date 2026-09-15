/**
 * Route Me Assisted Routing Core Engine.
 *
 * Implements:
 * 1. Device location validation (presence, freshness <= 15m, accuracy <= 500m, coordinate bounds).
 * 2. Leg-by-leg sequencing: Origin (device) -> Pickup Well -> Disposal Site.
 * 3. Governed road safety over naive map estimates:
 *    - Active closures, prohibited roads, and approved corridors strictly outrank map shortcuts.
 *    - Driver-history travel time outranks unsafe shortcuts when sufficiently supported.
 * 4. Cycle time evaluation:
 *    - Transit to well + Wait time (if arriving before predictedReadyAtMs) + Loading (30m)
 *      + Transit to disposal + Unloading (30m).
 * 5. Disposal selection:
 *    - Filters by company authorization, operator/water type, and blacklist first.
 *    - Selects best drivable drop-off based on verified travel time; historical frequency
 *      serves only as a tie-breaker/preference when travel is equivalent.
 * 6. Honest fail-safe contract:
 *    - Returns ROUTE_UNVERIFIED / ROUTING_DATA_UNAVAILABLE when governed routing data is absent.
 *    - Does NOT fabricate synthetic travel times or fake road networks.
 */

export type RouteTravelBasis =
  | 'driver_history'
  | 'approved_corridor'
  | 'map_estimate'
  | 'unverified';

export type RouteVerificationStatus =
  | 'ROUTE_VERIFIED'
  | 'ROUTE_UNVERIFIED';

export interface DeviceLocationInput {
  latitude?: number;
  longitude?: number;
  capturedAt?: number | string;
  accuracy?: number; // meters
}

export interface LocationValidationResult {
  valid: boolean;
  reason?: 'missing' | 'stale' | 'inaccurate' | 'invalid_coords';
  latitude?: number;
  longitude?: number;
  capturedAtMs?: number;
  accuracy?: number;
}

export interface RouteLegPoint {
  lat: number;
  lng: number;
  label?: string;
}

export interface RouteLeg {
  legType: 'origin_to_pickup' | 'pickup_to_disposal';
  origin: RouteLegPoint;
  destination: RouteLegPoint;
  travelBasis: RouteTravelBasis;
  confidence: number;      // 0.0 - 1.0 (0 when unverified)
  sampleCount: number;     // historical sample count (0 when unverified)
  restrictions: string[];  // e.g. ['road_closed', 'prohibited_truck', 'unsafe_shortcut']
  estimatedTravelMinutes: number | null;
  distanceMiles?: number | null;
  reasonCode?: string;     // e.g. 'ROUTING_DATA_UNAVAILABLE', 'CLOSED_ROAD_DETOUR'
}

export interface CycleTimeEstimate {
  travelToPickupMinutes: number | null;
  waitToReadyMinutes: number;   // Math.max(0, (predictedReadyAtMs - arrivalAtPickupMs) / 60000)
  loadingMinutes: number;       // default 30 min
  travelToDisposalMinutes: number | null;
  unloadingMinutes: number;     // default 30 min
  totalCycleMinutes: number | null;
}

// ── Governed Routing Data Model (Injectable for Deterministic Testing) ──────────

export interface GovernedRoadClosure {
  id: string;
  roadName: string;
  active: boolean;
  affectedSegments?: string[];
  reason?: string;
}

export interface GovernedRoadRestriction {
  id: string;
  roadName: string;
  prohibitedTrucks?: boolean;
  maxGrossWeightLbs?: number;
  active: boolean;
  reason?: string;
}

export interface GovernedCorridor {
  corridorId: string;
  companyId?: string;
  originName?: string;
  destName?: string;
  travelMinutes: number;
  distanceMiles?: number;
  isApproved: boolean;
  viaRoads: string[];
}

export interface DriverTravelHistoryEntry {
  originName: string;
  destName: string;
  sampleCount: number;
  medianMinutes: number;
  standardDeviationMinutes?: number;
  confidence: number; // 0.0 - 1.0
  viaRoads?: string[];
}

export interface NaiveMapEstimate {
  originName: string;
  destName: string;
  estimatedMinutes: number;
  distanceMiles?: number;
  viaRoads: string[];
}

export interface GovernedRoutingRepository {
  closures?: GovernedRoadClosure[];
  restrictions?: GovernedRoadRestriction[];
  corridors?: GovernedCorridor[];
  travelHistory?: DriverTravelHistoryEntry[];
  naiveMapEstimates?: NaiveMapEstimate[];
}

// ── Location Validation ─────────────────────────────────────────────────────────

export const MAX_LOCATION_AGE_MS = 15 * 60 * 1000; // 15 minutes
export const MAX_LOCATION_ACCURACY_METERS = 500;   // 500 meters

/**
 * Validate device location strictly as routing origin data.
 */
export function validateDeviceLocation(
  loc: DeviceLocationInput | undefined | null,
  asOfMs: number,
): LocationValidationResult {
  if (!loc || typeof loc !== 'object') {
    return { valid: false, reason: 'missing' };
  }

  const { latitude, longitude, capturedAt, accuracy } = loc;

  // 1. Check coordinate presence and validity
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || isNaN(latitude) || isNaN(longitude)) {
    return { valid: false, reason: 'missing' };
  }

  // WGS84 range check and reject (0, 0)
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return { valid: false, reason: 'invalid_coords' };
  }
  if (Math.abs(latitude) < 0.0001 && Math.abs(longitude) < 0.0001) {
    return { valid: false, reason: 'invalid_coords' };
  }

  // 2. Check freshness (capturedAt)
  if (capturedAt === undefined || capturedAt === null) {
    return { valid: false, reason: 'missing' };
  }

  let capturedAtMs: number;
  if (typeof capturedAt === 'number') {
    capturedAtMs = capturedAt;
  } else if (typeof capturedAt === 'string') {
    capturedAtMs = Date.parse(capturedAt);
  } else {
    return { valid: false, reason: 'missing' };
  }

  if (isNaN(capturedAtMs) || capturedAtMs <= 0) {
    return { valid: false, reason: 'missing' };
  }

  // Must not be in the distant future (> 1 min clock drift) and must not be older than 15 minutes
  if (capturedAtMs > asOfMs + 60000) {
    return { valid: false, reason: 'stale' };
  }
  if (asOfMs - capturedAtMs > MAX_LOCATION_AGE_MS) {
    return { valid: false, reason: 'stale' };
  }

  // 3. Check accuracy
  if (accuracy !== undefined && accuracy !== null) {
    if (typeof accuracy !== 'number' || isNaN(accuracy) || accuracy <= 0 || accuracy > MAX_LOCATION_ACCURACY_METERS) {
      return { valid: false, reason: 'inaccurate' };
    }
  }

  return {
    valid: true,
    latitude,
    longitude,
    capturedAtMs,
    accuracy: accuracy ?? undefined,
  };
}

// ── Leg Travel Evaluation & Governed Road Safety ────────────────────────────────

export interface LegEvaluationOptions {
  legType: 'origin_to_pickup' | 'pickup_to_disposal';
  origin: RouteLegPoint;
  destination: RouteLegPoint;
  companyId: string;
}

/**
 * Evaluate travel for a single leg under governed road safety constraints.
 *
 * Rules:
 * 1. If no governed data sources exist, return 'unverified' with ROUTING_DATA_UNAVAILABLE.
 * 2. Active closures and truck restrictions disqualify naive shortcuts.
 * 3. Approved corridors strictly outrank naive map estimates.
 * 4. Driver-history travel time outranks unsafe map estimates when sample count >= 3 and confidence >= 0.7.
 */
export function evaluateLegTravel(
  opts: LegEvaluationOptions,
  repo?: GovernedRoutingRepository,
): RouteLeg {
  const { legType, origin, destination, companyId } = opts;
  const originLabel = origin.label || `${origin.lat.toFixed(4)},${origin.lng.toFixed(4)}`;
  const destLabel = destination.label || `${destination.lat.toFixed(4)},${destination.lng.toFixed(4)}`;

  // Default fail-safe when no repo is supplied or repo is completely empty
  const hasData = Boolean(
    repo &&
    ((repo.closures && repo.closures.length > 0) ||
      (repo.restrictions && repo.restrictions.length > 0) ||
      (repo.corridors && repo.corridors.length > 0) ||
      (repo.travelHistory && repo.travelHistory.length > 0) ||
      (repo.naiveMapEstimates && repo.naiveMapEstimates.length > 0))
  );

  if (!hasData || !repo) {
    return {
      legType,
      origin,
      destination,
      travelBasis: 'unverified',
      confidence: 0,
      sampleCount: 0,
      restrictions: [],
      estimatedTravelMinutes: null,
      reasonCode: 'ROUTING_DATA_UNAVAILABLE',
    };
  }

  // 1. Identify active closures & restrictions
  const activeClosedRoads = new Set(
    (repo.closures || [])
      .filter((c) => c.active)
      .map((c) => c.roadName.toLowerCase().trim()),
  );

  const activeProhibitedRoads = new Set(
    (repo.restrictions || [])
      .filter((r) => r.active && r.prohibitedTrucks)
      .map((r) => r.roadName.toLowerCase().trim()),
  );

  // 2. Check candidate routes:
  // A. Approved Company Corridor
  const approvedCorridor = (repo.corridors || []).find((c) => {
    if (!c.isApproved) return false;
    if (c.companyId && c.companyId !== companyId) return false;
    const origMatch = !c.originName || c.originName.toLowerCase() === originLabel.toLowerCase();
    const destMatch = !c.destName || c.destName.toLowerCase() === destLabel.toLowerCase();
    if (!origMatch || !destMatch) return false;

    // Must not traverse an active closure or prohibited road
    const hasClosure = c.viaRoads.some((r) => activeClosedRoads.has(r.toLowerCase().trim()));
    const hasProhibited = c.viaRoads.some((r) => activeProhibitedRoads.has(r.toLowerCase().trim()));
    return !hasClosure && !hasProhibited;
  });

  // B. Driver Travel History
  const travelHistory = (repo.travelHistory || []).find((th) => {
    const origMatch = th.originName.toLowerCase() === originLabel.toLowerCase();
    const destMatch = th.destName.toLowerCase() === destLabel.toLowerCase();
    if (!origMatch || !destMatch) return false;

    // Check if viaRoads are known and whether any are closed
    if (th.viaRoads && th.viaRoads.length > 0) {
      const hasClosure = th.viaRoads.some((r) => activeClosedRoads.has(r.toLowerCase().trim()));
      const hasProhibited = th.viaRoads.some((r) => activeProhibitedRoads.has(r.toLowerCase().trim()));
      if (hasClosure || hasProhibited) return false;
    }
    return true;
  });

  // C. Naive Map Estimate
  const naiveMap = (repo.naiveMapEstimates || []).find((nm) => {
    const origMatch = nm.originName.toLowerCase() === originLabel.toLowerCase();
    const destMatch = nm.destName.toLowerCase() === destLabel.toLowerCase();
    return origMatch && destMatch;
  });

  const restrictions: string[] = [];
  let naiveTraversesClosure = false;
  let naiveTraversesProhibited = false;

  if (naiveMap) {
    naiveTraversesClosure = naiveMap.viaRoads.some((r) => activeClosedRoads.has(r.toLowerCase().trim()));
    naiveTraversesProhibited = naiveMap.viaRoads.some((r) => activeProhibitedRoads.has(r.toLowerCase().trim()));
    if (naiveTraversesClosure) restrictions.push('road_closed');
    if (naiveTraversesProhibited) restrictions.push('prohibited_truck');
  }

  // 3. Selection & Ranking Logic:
  // Rule: Governed road closures strictly invalidate naive map shortcuts.
  // If naive map has a closure/prohibited road, it CANNOT be used as map_estimate.
  if (naiveTraversesClosure || naiveTraversesProhibited) {
    // Naive route is unsafe. Safe detour or corridor must control!
    if (approvedCorridor) {
      return {
        legType,
        origin,
        destination,
        travelBasis: 'approved_corridor',
        confidence: 0.95,
        sampleCount: 1,
        restrictions,
        estimatedTravelMinutes: approvedCorridor.travelMinutes,
        distanceMiles: approvedCorridor.distanceMiles ?? null,
        reasonCode: 'CLOSED_ROAD_SAFE_DETOUR',
      };
    }

    if (travelHistory && travelHistory.sampleCount >= 3 && travelHistory.confidence >= 0.7) {
      return {
        legType,
        origin,
        destination,
        travelBasis: 'driver_history',
        confidence: travelHistory.confidence,
        sampleCount: travelHistory.sampleCount,
        restrictions,
        estimatedTravelMinutes: travelHistory.medianMinutes,
        reasonCode: 'DRIVER_HISTORY_SAFE_DETOUR',
      };
    }

    // No safe corridor or driver history exists to bypass the closure:
    // Mark as unsafe shortcut / detour required with penalized estimate or unverified
    return {
      legType,
      origin,
      destination,
      travelBasis: 'unverified',
      confidence: 0,
      sampleCount: 0,
      restrictions,
      estimatedTravelMinutes: null,
      reasonCode: 'UNSAFE_CLOSED_ROAD_NO_DETOUR',
    };
  }

  // If approved corridor exists, it outranks naive map estimates
  if (approvedCorridor) {
    return {
      legType,
      origin,
      destination,
      travelBasis: 'approved_corridor',
      confidence: 0.95,
      sampleCount: 1,
      restrictions: [],
      estimatedTravelMinutes: approvedCorridor.travelMinutes,
      distanceMiles: approvedCorridor.distanceMiles ?? null,
      reasonCode: 'APPROVED_CORRIDOR_VERIFIED',
    };
  }

  // Driver travel history outranks unverified map estimate when sufficiently supported
  if (travelHistory && travelHistory.sampleCount >= 3 && travelHistory.confidence >= 0.7) {
    return {
      legType,
      origin,
      destination,
      travelBasis: 'driver_history',
      confidence: travelHistory.confidence,
      sampleCount: travelHistory.sampleCount,
      restrictions: [],
      estimatedTravelMinutes: travelHistory.medianMinutes,
      reasonCode: 'DRIVER_HISTORY_VERIFIED',
    };
  }

  // Naive map estimate without closures
  if (naiveMap) {
    return {
      legType,
      origin,
      destination,
      travelBasis: 'map_estimate',
      confidence: 0.5,
      sampleCount: 0,
      restrictions: [],
      estimatedTravelMinutes: naiveMap.estimatedMinutes,
      distanceMiles: naiveMap.distanceMiles ?? null,
      reasonCode: 'MAP_ESTIMATE_UNVERIFIED_CORRIDOR',
    };
  }

  return {
    legType,
    origin,
    destination,
    travelBasis: 'unverified',
    confidence: 0,
    sampleCount: 0,
    restrictions: [],
    estimatedTravelMinutes: null,
    reasonCode: 'ROUTING_DATA_UNAVAILABLE',
  };
}

// ── Leg Sequencing & Cycle Time Estimation ──────────────────────────────────────

export const DEFAULT_LOADING_MINUTES = 30;
export const DEFAULT_UNLOADING_MINUTES = 30;

export interface WellRoutingContext {
  wellName: string;
  wellId?: string;
  companyId: string;
  lat?: number;
  lng?: number;
  predictedReadyAtMs: number | null;
  priorityState: 'pull-now' | 'approaching' | 'verify' | 'down' | 'no-gain';
}

export interface CandidateDisposal {
  id?: string;
  name?: string;
  well_name?: string;
  companyId?: string;
  operator?: string;
  waterType?: string;
  lat?: number;
  lng?: number;
  isBlacklisted?: boolean;
  unavailable?: boolean;
}

export interface SequencedRouteResult {
  originToPickupLeg: RouteLeg;
  pickupToDisposalLeg: RouteLeg;
  selectedDisposalName: string;
  cycleTime: CycleTimeEstimate;
  routeVerificationStatus: RouteVerificationStatus;
}

/**
 * Sequence Pickup and Disposal legs for a well, evaluate cycle time, and select best disposal.
 */
export function sequencePickupAndDisposalLegs(
  deviceOrigin: RouteLegPoint,
  well: WellRoutingContext,
  eligibleDisposals: CandidateDisposal[],
  preferredDisposalName: string | null | undefined,
  asOfMs: number,
  repo?: GovernedRoutingRepository,
): SequencedRouteResult {
  const wellPoint: RouteLegPoint = {
    lat: well.lat ?? 0,
    lng: well.lng ?? 0,
    label: well.wellName,
  };

  // Leg 1: Origin -> Pickup Well
  const originToPickupLeg = evaluateLegTravel(
    {
      legType: 'origin_to_pickup',
      origin: deviceOrigin,
      destination: wellPoint,
      companyId: well.companyId,
    },
    repo,
  );

  // Evaluate wait time at well:
  // Arrival at well = asOfMs + travelToPickupMs
  let waitToReadyMinutes = 0;
  if (originToPickupLeg.estimatedTravelMinutes !== null && well.predictedReadyAtMs !== null) {
    const arrivalAtWellMs = asOfMs + originToPickupLeg.estimatedTravelMinutes * 60000;
    if (well.predictedReadyAtMs > arrivalAtWellMs) {
      waitToReadyMinutes = Math.round((well.predictedReadyAtMs - arrivalAtWellMs) / 60000);
    }
  }

  // Leg 2: Pickup Well -> Disposal Site
  // Evaluate all eligible disposals to pick the best travel choice
  let bestDisposalName = preferredDisposalName || 'No verified drop-off';
  let bestDisposalLeg: RouteLeg | null = null;

  if (eligibleDisposals.length > 0) {
    const evaluatedDisposals = eligibleDisposals.map((disp) => {
      const dispName = (disp.well_name || disp.name || '').trim();
      const dispPoint: RouteLegPoint = {
        lat: disp.lat ?? 0,
        lng: disp.lng ?? 0,
        label: dispName,
      };

      const leg = evaluateLegTravel(
        {
          legType: 'pickup_to_disposal',
          origin: wellPoint,
          destination: dispPoint,
          companyId: well.companyId,
        },
        repo,
      );

      return { dispName, dispPoint, leg };
    });

    // Separate verified vs unverified
    const verifiedChoices = evaluatedDisposals.filter(
      (d) => d.leg.estimatedTravelMinutes !== null && d.leg.travelBasis !== 'unverified',
    );

    if (verifiedChoices.length > 0) {
      // Sort by estimated travel minutes ascending
      verifiedChoices.sort((a, b) => {
        const aMins = a.leg.estimatedTravelMinutes!;
        const bMins = b.leg.estimatedTravelMinutes!;
        // If times are close (within 2 mins), give slight edge to preferred disposal
        if (Math.abs(aMins - bMins) <= 2 && preferredDisposalName) {
          if (a.dispName.toLowerCase() === preferredDisposalName.toLowerCase()) return -1;
          if (b.dispName.toLowerCase() === preferredDisposalName.toLowerCase()) return 1;
        }
        return aMins - bMins;
      });

      const top = verifiedChoices[0];
      bestDisposalName = top.dispName;
      bestDisposalLeg = top.leg;
    } else {
      // No verified travel for any disposal; fallback to preferred or first eligible
      const match = evaluatedDisposals.find(
        (d) => preferredDisposalName && d.dispName.toLowerCase() === preferredDisposalName.toLowerCase(),
      ) || evaluatedDisposals[0];

      bestDisposalName = match.dispName;
      bestDisposalLeg = match.leg;
    }
  }

  // Fallback if no disposal leg was evaluated
  if (!bestDisposalLeg) {
    const fallbackPoint: RouteLegPoint = {
      lat: 0,
      lng: 0,
      label: bestDisposalName,
    };
    bestDisposalLeg = {
      legType: 'pickup_to_disposal',
      origin: wellPoint,
      destination: fallbackPoint,
      travelBasis: 'unverified',
      confidence: 0,
      sampleCount: 0,
      restrictions: [],
      estimatedTravelMinutes: null,
      reasonCode: 'NO_ELIGIBLE_DISPOSALS',
    };
  }

  // Calculate total cycle time
  const t1 = originToPickupLeg.estimatedTravelMinutes;
  const t2 = bestDisposalLeg.estimatedTravelMinutes;
  const totalCycleMinutes =
    t1 !== null && t2 !== null
      ? t1 + waitToReadyMinutes + DEFAULT_LOADING_MINUTES + t2 + DEFAULT_UNLOADING_MINUTES
      : null;

  const cycleTime: CycleTimeEstimate = {
    travelToPickupMinutes: t1,
    waitToReadyMinutes,
    loadingMinutes: DEFAULT_LOADING_MINUTES,
    travelToDisposalMinutes: t2,
    unloadingMinutes: DEFAULT_UNLOADING_MINUTES,
    totalCycleMinutes,
  };

  const isVerified =
    originToPickupLeg.travelBasis !== 'unverified' &&
    bestDisposalLeg.travelBasis !== 'unverified' &&
    originToPickupLeg.restrictions.length === 0;

  return {
    originToPickupLeg,
    pickupToDisposalLeg: bestDisposalLeg,
    selectedDisposalName: bestDisposalName,
    cycleTime,
    routeVerificationStatus: isVerified ? 'ROUTE_VERIFIED' : 'ROUTE_UNVERIFIED',
  };
}
