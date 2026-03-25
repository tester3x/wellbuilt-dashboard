// lib/driverEta.ts — AI Driver ETA: "Can they make it?"
//
// Calculates estimated arrival time for each driver to a service work location.
// Uses driver GPS from dispatch docs + Google Distance Matrix for drive times.

import { getDistanceMatrix } from './directions';

/** Driver stage from dispatch doc (written by WB T updateDriverStage) */
type DriverStage = 'en_route_pickup' | 'on_site_pickup' | 'en_route_dropoff' | 'on_site_dropoff' | 'paused' | 'completed';

/** Dispatch job data (subset needed for ETA) */
interface DispatchForEta {
  driverHash: string;
  driverStage?: DriverStage;
  stageUpdatedAt?: any; // Firestore Timestamp or {seconds, nanoseconds}
  driverLat?: number;
  driverLng?: number;
  driverGpsAt?: string;
  status: string;
  // Well/disposal coords for position inference
  wellName?: string;
  disposalLat?: number;
  disposalLng?: number;
}

/** Target location for the service work job */
interface TargetLocation {
  lat: number;
  lng: number;
  name: string;
}

/** ETA result for a single driver */
export interface DriverEtaResult {
  driverHash: string;
  /** Estimated minutes until driver arrives at target */
  etaMinutes: number | null;
  /** How we calculated it */
  source: 'gps' | 'inferred' | 'unknown';
  /** Can they make the onsiteBy deadline? */
  status: 'can_make_it' | 'tight' | 'cant_make_it' | 'unknown';
  /** Display string like "~45m" or "~1h20m" */
  display: string;
}

// Average time for each job step (minutes) — conservative estimates
const AVG_LOAD_TIME = 20;      // Time at pickup (gauge, connect, load)
const AVG_UNLOAD_TIME = 15;    // Time at SWD (wait, unload, disconnect)
const AVG_DRIVE_FALLBACK = 25; // Fallback drive time when Distance Matrix unavailable

/** Parse Firestore timestamp to epoch ms */
function getTimestampMs(ts: any): number {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.seconds === 'number') return ts.seconds * 1000 + ((ts.nanoseconds || 0) / 1000000);
  if (ts instanceof Date) return ts.getTime();
  const n = typeof ts === 'string' ? new Date(ts).getTime() : Number(ts);
  return isNaN(n) ? 0 : n;
}

/**
 * Estimate remaining minutes on current job based on driver stage.
 * Returns 0 if idle/completed.
 */
function estimateRemainingJobMinutes(dispatch: DispatchForEta): number {
  const stage = dispatch.driverStage;
  if (!stage || stage === 'completed') return 0;

  const stageAge = dispatch.stageUpdatedAt
    ? (Date.now() - getTimestampMs(dispatch.stageUpdatedAt)) / 60000
    : 0;

  switch (stage) {
    case 'on_site_pickup':
      // Loading — estimate remaining load time minus time already spent
      return Math.max(0, AVG_LOAD_TIME - stageAge) + AVG_DRIVE_FALLBACK + AVG_UNLOAD_TIME;

    case 'en_route_dropoff':
      // Driving to SWD — estimate remaining drive + unload
      return Math.max(0, AVG_DRIVE_FALLBACK - stageAge) + AVG_UNLOAD_TIME;

    case 'on_site_dropoff':
      // Unloading — estimate remaining unload time
      return Math.max(0, AVG_UNLOAD_TIME - stageAge);

    case 'en_route_pickup':
      // Driving to well — full job cycle remaining
      return Math.max(0, AVG_DRIVE_FALLBACK - stageAge) + AVG_LOAD_TIME + AVG_DRIVE_FALLBACK + AVG_UNLOAD_TIME;

    case 'paused':
      // Unknown how long pause lasts — assume 15 min + rest of job
      return 15 + AVG_DRIVE_FALLBACK + AVG_UNLOAD_TIME;

    default:
      return 0;
  }
}

/**
 * Get driver's current or inferred GPS coordinates.
 * Priority: actual GPS > dispatch well/SWD coords > null
 */
function getDriverLocation(dispatch: DispatchForEta): { lat: number; lng: number } | null {
  // Actual GPS from WB T
  if (dispatch.driverLat && dispatch.driverLng) {
    return { lat: dispatch.driverLat, lng: dispatch.driverLng };
  }

  // Infer from stage — at SWD or at well
  if (dispatch.driverStage === 'on_site_dropoff' && dispatch.disposalLat && dispatch.disposalLng) {
    return { lat: dispatch.disposalLat, lng: dispatch.disposalLng };
  }

  return null;
}

/** Format minutes as display string */
function formatEta(minutes: number): string {
  if (minutes < 60) return `~${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `~${h}h${m}m` : `~${h}h`;
}

/**
 * Calculate estimated arrival times for all drivers to a target location.
 *
 * @param drivers — list of driver hashes to evaluate
 * @param activeDispatches — all active dispatch docs (from Firestore listener)
 * @param target — GPS coords of the service work location
 * @param onsiteByMinutes — minutes from now until deadline (null = no deadline)
 */
export async function calculateDriverETAs(
  driverHashes: string[],
  activeDispatches: DispatchForEta[],
  target: TargetLocation,
): Promise<DriverEtaResult[]> {
  // Step 1: For each driver, find their active dispatch + estimate remaining job time
  const driverData = driverHashes.map(hash => {
    const activeJobs = activeDispatches.filter(d =>
      d.driverHash === hash &&
      ['accepted', 'in_progress', 'paused'].includes(d.status)
    );
    const activeJob = activeJobs[0] || null; // Primary active job
    const remainingMinutes = activeJob ? estimateRemainingJobMinutes(activeJob) : 0;
    const location = activeJob ? getDriverLocation(activeJob) : null;

    return { hash, activeJob, remainingMinutes, location };
  });

  // Step 2: Get drive times from each driver's location to the target
  const driversWithLocation = driverData.filter(d => d.location !== null);
  let driveTimes: Array<{ durationMinutes: number; distanceMiles: number } | null> = [];

  if (driversWithLocation.length > 0) {
    try {
      driveTimes = await getDistanceMatrix(
        driversWithLocation.map(d => d.location!),
        { lat: target.lat, lng: target.lng },
      );
    } catch {
      driveTimes = driversWithLocation.map(() => null);
    }
  }

  // Map drive times back to driver data
  let driveTimeIdx = 0;
  const driveTimeMap = new Map<string, number>();
  for (const d of driverData) {
    if (d.location) {
      const dt = driveTimes[driveTimeIdx++];
      if (dt) driveTimeMap.set(d.hash, dt.durationMinutes);
    }
  }

  // Step 3: Calculate ETA for each driver
  return driverData.map(d => {
    const driveMinutes = driveTimeMap.get(d.hash) ?? null;

    if (d.location === null && !d.activeJob) {
      // Idle, no GPS — unknown
      return {
        driverHash: d.hash,
        etaMinutes: null,
        source: 'unknown' as const,
        status: 'unknown' as const,
        display: '?',
      };
    }

    // Total ETA = remaining job time + drive to target
    const totalMinutes = d.remainingMinutes + (driveMinutes ?? AVG_DRIVE_FALLBACK);
    const source = driveMinutes !== null ? 'gps' as const : 'inferred' as const;

    return {
      driverHash: d.hash,
      etaMinutes: totalMinutes,
      source,
      status: 'unknown' as const, // Caller compares to onsiteBy
      display: formatEta(totalMinutes),
    };
  });
}

/**
 * Apply onsiteBy deadline to ETA results.
 * Updates status to can_make_it / tight / cant_make_it.
 */
export function applyDeadline(
  results: DriverEtaResult[],
  onsiteByMinutesFromNow: number,
): DriverEtaResult[] {
  return results.map(r => {
    if (r.etaMinutes === null) return r;
    const buffer = onsiteByMinutesFromNow - r.etaMinutes;
    let status: DriverEtaResult['status'];
    if (buffer >= 30) status = 'can_make_it';
    else if (buffer >= 0) status = 'tight';
    else status = 'cant_make_it';
    return { ...r, status };
  });
}
