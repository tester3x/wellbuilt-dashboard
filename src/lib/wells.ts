// Well data utilities - fetches from Firebase
import { ref, get, onValue, set } from 'firebase/database';
import { getFirebaseDatabase } from './firebase';
import { adminGetWellHistory, adminGetWellPerformance, adminGetWellPool } from './adminDashboardCatalog';
import {
  buildWellRows,
  computeHealth,
  errorCodeOf,
  routesFromRows,
  type EstimationConfig,
  type EstimationStatus,
  type WellPoolHealth,
} from './wellEstimation';

export type { WellPoolHealth } from './wellEstimation';

export interface WellResponse {
  wellName: string;
  currentLevel: string;
  etaToMax: string;
  flowRate: string;
  timestamp: string;
  timestampUTC?: string;     // ISO 8601 UTC timestamp for calculations
  bbls?: number;
  maxLevel?: number;
  bottomLevel?: number;
  isDown?: boolean;
  wellDown?: boolean;        // From Cloud Function response
  responseId?: string;
  route?: string;
  // Additional fields from outgoing packets (TankResponse from VBA)
  tanks?: number;
  tankAtLevel?: string;      // "Tank @ Level" — target height for pullBbls (e.g. "2 @ 7'6\"")
  pullBbls?: number;         // Configured pull BBLs for this well
  timeTillPull?: string;     // Time Till Pull (H:M format) - from outgoing packets
  nextPullTime?: string;     // Next Pull Time (datetime string) - from outgoing packets
  nextPullTimeUTC?: string;  // ISO 8601 UTC timestamp
  bbls24hrs?: string;        // BBLs produced in 24 hours (AFR-based)
  windowBblsDay?: string;    // Window-averaged bbls/day (more accurate, from Cloud Function)
  overnightBblsDay?: string; // Overnight bbls/day from Cloud Function
  status?: string;           // Status from VBA
  location?: string;         // GPS/address placeholder for future
  // Last pull info from Cloud Function
  lastPullDateTime?: string;
  lastPullDateTimeUTC?: string;
  lastPullBbls?: string;
  lastPullTopLevel?: string;
  lastPullBottomLevel?: string;
  // NDIC linkage from well_config
  ndicName?: string;           // Full NDIC well name (e.g. "GABRIEL 1-36-25H")
  // Raw numeric level for precision (avoids parsing formatted string)
  currentLevelInches?: number; // Total inches — used by Add Pull modal
  // Tank dimensions from well_config
  bblPerFoot?: number;         // Stored BBL/ft (overrides numTanks * 20 default)
}

export interface WellConfig {
  route?: string;
  maxLevel?: number;
  bottomLevel?: number;
  tanks?: number;
  pullBbls?: number;
  tankCapacity?: number;  // BBL per tank (default 400)
  tankHeight?: number;    // feet per tank (default 20)
  bblPerFoot?: number;    // (tankCapacity / tankHeight) * numTanks
}

/** Snapshot well list from the admin catalog when RTDB parent reads are denied. */
export function wellResponsesFromCatalog(wellConfig: Record<string, unknown>): WellResponse[] {
  return Object.entries(wellConfig).map(([wellName, raw]) => {
    const config = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const tanks = typeof config.tanks === 'number'
      ? config.tanks
      : typeof config.numTanks === 'number' ? config.numTanks : 1;
    return {
      wellName,
      currentLevel: '--',
      etaToMax: '',
      flowRate: typeof config.avgFlowRate === 'string' ? config.avgFlowRate : 'Unknown',
      timestamp: '',
      route: typeof config.route === 'string' ? config.route : 'Unrouted',
      tanks,
      pullBbls: typeof config.pullBbls === 'number' ? config.pullBbls : 140,
      ndicName: typeof config.ndicName === 'string' ? config.ndicName : '',
      isDown: config.isDown === true,
    };
  });
}

export function mergeWellPool(
  wellConfig: Record<string, unknown>,
  wellStatus: Record<string, unknown> = {},
): WellResponse[] {
  return wellResponsesFromCatalog(wellConfig).map((well) => {
    const st = (wellStatus[well.wellName] && typeof wellStatus[well.wellName] === 'object')
      ? wellStatus[well.wellName] as Record<string, unknown>
      : {};
    return {
      ...well,
      currentLevel: typeof st.currentLevel === 'string' ? st.currentLevel : well.currentLevel,
      flowRate: typeof st.flowRate === 'string' ? st.flowRate : well.flowRate,
      timestamp: typeof st.timestamp === 'string' ? st.timestamp : well.timestamp,
      timeTillPull: typeof st.timeTillPull === 'string' ? st.timeTillPull : well.timeTillPull,
      nextPullTime: typeof st.nextPullTime === 'string' ? st.nextPullTime : well.nextPullTime,
      nextPullTimeUTC: typeof st.nextPullTimeUTC === 'string' ? st.nextPullTimeUTC : well.nextPullTimeUTC,
      lastPullDateTimeUTC: typeof st.lastPullDateTimeUTC === 'string' ? st.lastPullDateTimeUTC : well.lastPullDateTimeUTC,
      lastPullBbls: st.lastPullBbls != null ? String(st.lastPullBbls) : well.lastPullBbls,
      isDown: st.wellDown === true || st.isDown === true || well.isDown,
      status: typeof st.status === 'string' ? st.status : well.status,
    };
  });
}

async function wellPoolResponses(): Promise<{ wells: WellResponse[]; routes: string[] }> {
  const pool = await adminGetWellPool();
  const wells = mergeWellPool(pool.wellConfig || {}, pool.wellStatus || {});
  const routes = Array.from(new Set(wells.map((w) => w.route).filter((r): r is string => !!r)))
    .sort((a, b) => {
      if (a === 'Unrouted') return 1;
      if (b === 'Unrouted') return -1;
      return a.localeCompare(b);
    });
  return { wells: wells.sort((a, b) => a.wellName.localeCompare(b.wellName)), routes };
}

// NEW UNIFIED STRUCTURE - matches Cloud Function output
export interface WellStatus {
  wellName: string;
  config: {
    tanks: number;
    bottomLevel: number;
    route: string;
    pullBbls: number;
  };
  current: {
    level: string;
    levelInches: number;
    asOf: string;
  };
  lastPull: {
    dateTime: string;
    dateTimeUTC: string;
    topLevel: string;
    topLevelInches: number;
    bottomLevel: string;
    bottomLevelInches: number;
    bblsTaken: number;
    driverName?: string;
    packetId: string;
  };
  calculated: {
    flowRate: string;
    flowRateMinutes: number;
    bbls24hrs: number;
    nextPullTime: string;
    nextPullTimeUTC: string;
    timeTillPull: string;
  };
  isDown: boolean;
  updatedAt: string;
}



export interface PullPacket {
  packetId: string;
  wellName: string;
  // Entered Data
  timestamp: string;        // ISO date string - Date/Time of Pull
  tankTopLevel: number;     // in inches - Tank Top Level (before pull)
  bblsTaken: number;        // BBLs Taken
  driverName?: string;
  driverId?: string;
  // Calculated Data (computed client-side from entered data)
  tankAfter?: number;       // inches - Tank After = tankTop - (bbls / 20 * tanks) * 12
  timeDif?: string;         // H:M - Time since previous pull
  recoveryInches?: number;  // inches - Growth since previous pull
  flowRate?: string;        // H:M:S - Time to rise 12 inches (1 foot)
  flowRateDays?: number;    // days per foot - Raw flow rate for AFR calculation
  recoveryNeeded?: number;  // inches - Needed to reach pull target
  estTimeToPull?: string;   // H:M - Estimated time until ready
  estDateTimePull?: string; // ISO string - When it'll be ready
  currentLevelEst?: number; // inches - Current level estimate
  // Anomaly detection (based on VBA two-tier system)
  anomalyLevel?: number;    // 0 = normal, 1 = IT Review (2.5x), 2 = Anomaly (5x, excluded from AFR)
  // Edit tracking (canonical + legacy)
  editedAt?: string;        // ISO string - when the edit was made
  editedBy?: string;        // source/provenance (wbm | dashboard | legacy | unknown)
  editCount?: number;       // successfully applied post-submission edits
  originalSubmittedAt?: string;
  isEdit?: boolean;         // legacy dual-row marker
  // No-level flag (non-production-tank pull — fresh water, service work, etc.)
  noLevel?: boolean;
  jobType?: string;          // Commodity type from WB T (e.g. "Production Water")
  wellDown?: boolean;        // Well is down (not producing)
}

export interface PerformanceRow {
  d: string;  // date
  a: number;  // actual (inches)
  p: number;  // predicted (inches)
}

// Fetch well configs (route assignments, etc)
export async function fetchWellConfigs(): Promise<Record<string, WellConfig>> {
  try {
    const db = getFirebaseDatabase();
    const configRef = ref(db, 'well_config');
    const snapshot = await get(configRef);

    if (!snapshot.exists()) return {};

    const configs: Record<string, WellConfig> = {};
    snapshot.forEach((child) => {
      configs[child.key!] = child.val();
    });
    return configs;
  } catch {
    const pool = await adminGetWellPool();
    return pool.wellConfig as Record<string, WellConfig>;
  }
}

// Get unique route names from configs
export async function fetchRouteNames(): Promise<string[]> {
  const configs = await fetchWellConfigs();
  const routes = new Set<string>();

  Object.values(configs).forEach((config) => {
    if (config.route) {
      routes.add(config.route);
    }
  });

  return Array.from(routes).sort();
}

// Subscribe to well_config for lightweight well name + route list (used by well detail nav)
export interface WellNavItem {
  wellName: string;
  route: string;
}

export function subscribeToWellNavList(
  callback: (wells: WellNavItem[]) => void
): () => void {
  const db = getFirebaseDatabase();
  const configRef = ref(db, 'well_config');

  const apply = (wells: WellNavItem[]) => {
    wells.sort((a, b) => {
      if (a.route !== b.route) {
        if (a.route === 'Unrouted') return 1;
        if (b.route === 'Unrouted') return -1;
        return a.route.localeCompare(b.route);
      }
      return a.wellName.localeCompare(b.wellName);
    });
    callback(wells);
  };

  const unsubscribe = onValue(configRef, (snapshot) => {
    const wells: WellNavItem[] = [];
    if (snapshot.exists()) {
      snapshot.forEach((child) => {
        const config = child.val();
        wells.push({
          wellName: child.key!,
          route: config.route || 'Unrouted',
        });
      });
    }
    apply(wells);
  }, () => {
    adminGetWellPool().then((pool) => {
      apply(Object.entries(pool.wellConfig || {}).map(([wellName, raw]) => ({
        wellName,
        route: (raw && typeof raw === 'object' && typeof (raw as { route?: string }).route === 'string')
          ? (raw as { route: string }).route
          : 'Unrouted',
      })));
    }).catch(() => apply([]));
  });

  return unsubscribe;
}

// Fetch all current well statuses (from outgoing/)
export async function fetchAllWellStatuses(): Promise<WellResponse[]> {
  try {
    const db = getFirebaseDatabase();
    const outgoingRef = ref(db, 'packets/outgoing');
    const snapshot = await get(outgoingRef);

    if (!snapshot.exists()) return [];

    const responses: WellResponse[] = [];
    snapshot.forEach((child) => {
      const data = child.val();
      if (data.wellName) {
        responses.push({
          ...data,
          responseId: child.key,
        });
      }
    });

    return responses.sort((a, b) => a.wellName.localeCompare(b.wellName));
  } catch {
    const { wells } = await wellPoolResponses();
    return wells;
  }
}


// Well Status data path.
//
// Production RTDB rules do NOT grant a read at `well_config` or `packets/outgoing`
// themselves — `well_config`/`wells` carry only a `$well/.read`, and RTDB grants
// cascade down, never up, so an unfiltered parent subscription is denied for every
// caller including a platform admin. `packets/outgoing` additionally demands a
// `companyId`-scoped query for non-platform callers.
//
// So the authoritative snapshot comes from the `adminGetWellPool` callable, which
// authorises the caller server-side (requireRegisteredDashboardUser +
// canViewWellPool) and returns a company-projected, field-allowlisted catalog.
// Nothing here reads a broad RTDB parent node.
//
// Two clocks, deliberately separate:
//   • AUTHORITATIVE_REFRESH_MS — re-fetch the snapshot, so a newly processed pull
//     lands without a page reload and resets that well's estimate onto its new
//     bottom level and timestamp.
//   • ESTIMATE_TICK_MS — recompute levels from the snapshot already held. Local,
//     free, and keeps the display moving between refreshes even while degraded.
//
// A failed refresh never silently serves a stale snapshot as if it were live: the
// health object flips to degraded and the screen is expected to say so.
export const AUTHORITATIVE_REFRESH_MS = 60 * 1000;
export const ESTIMATE_TICK_MS = 30 * 1000;

export function subscribeToWellStatusesUnified(
  callback: (wells: WellResponse[], routes: string[], health: WellPoolHealth) => void,
  onError?: (err: unknown) => void,
): () => void {
  let stopped = false;
  let wellConfig: Record<string, EstimationConfig> = {};
  let wellStatus: Record<string, EstimationStatus> = {};
  let lastAuthoritativeAt: number | null = null;
  let errorCode: string | null = null;
  let inFlight = false;

  const emit = () => {
    if (stopped) return;
    const nowMs = Date.now();
    const rows = buildWellRows({ wellConfig, wellStatus, nowMs });
    const health = computeHealth({ lastAuthoritativeAt, errorCode, nowMs });
    callback(rows as unknown as WellResponse[], routesFromRows(rows), health);
  };

  const refreshAuthoritative = async () => {
    // Overlapping refreshes would let a slow response overwrite a newer one.
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const pool = await adminGetWellPool();
      if (stopped) return;
      wellConfig = (pool.wellConfig || {}) as Record<string, EstimationConfig>;
      wellStatus = (pool.wellStatus || {}) as Record<string, EstimationStatus>;
      lastAuthoritativeAt = Date.now();
      errorCode = null;
    } catch (err) {
      if (stopped) return;
      // Keep the last good snapshot and keep estimating from it — but mark the
      // pool degraded so the UI can show the data is no longer being confirmed.
      errorCode = errorCodeOf(err);
      onError?.(err);
    } finally {
      inFlight = false;
      emit();
    }
  };

  void refreshAuthoritative();
  const refreshTimer = setInterval(() => { void refreshAuthoritative(); }, AUTHORITATIVE_REFRESH_MS);
  const estimateTimer = setInterval(emit, ESTIMATE_TICK_MS);

  return () => {
    stopped = true;
    clearInterval(refreshTimer);
    clearInterval(estimateTimer);
  };
}


// Format days to H:MM string
function daysToHMM(days: number): string {
  if (days <= 0 || !isFinite(days)) return '--';
  const totalMinutes = Math.floor(days * 24 * 60);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${hours}:${mins.toString().padStart(2, '0')}`;
}

// Anomaly detection constants (tighter than VBA for better accuracy)
// VBA uses 5x/2.5x but that's too loose for wells with consistent flow rates
const ANOMALY_RATIO = 2.0;     // 2x off median = excluded from AFR averaging
const ITREVIEW_RATIO = 1.5;    // 1.5x off median = flagged but included in AFR

// Calculate median of an array
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// Determine anomaly level for a flow rate based on median (VBA two-tier system)
// Returns: 0 = Normal, 1 = IT Review (2.5x-5x), 2 = Anomaly (>5x, excluded from AFR)
export function getFlowRateAnomalyLevel(flowRate: number, medianRate: number): number {
  if (medianRate <= 0 || flowRate <= 0) return 0;

  // Calculate ratio (how far off from median)
  const ratio = flowRate < medianRate
    ? medianRate / flowRate
    : flowRate / medianRate;

  if (ratio >= ANOMALY_RATIO) {
    return 2; // Anomaly - excluded from averaging
  } else if (ratio >= ITREVIEW_RATIO) {
    return 1; // IT Review - flagged but included
  }
  return 0; // Normal
}

// Filter out anomalies from flow rates using median-based detection (VBA method)
// Returns flow rates with 5x+ outliers removed (Tier 2 anomalies excluded)
function filterAnomalies(flowRates: number[]): number[] {
  if (flowRates.length < 3) {
    // Not enough data for reliable anomaly detection
    return flowRates;
  }

  // Calculate median for anomaly detection
  const medianRate = median(flowRates);

  // Filter out Tier 2 anomalies (5x off median) - these are excluded from AFR
  // Keep Tier 1 (IT Review, 2.5x-5x) - these are still included in averaging
  const filtered = flowRates.filter(rate => {
    const level = getFlowRateAnomalyLevel(rate, medianRate);
    return level < 2; // Keep normal (0) and IT Review (1), exclude Anomaly (2)
  });

  // If we filtered too many, fall back to original (anomaly detection failed)
  if (filtered.length < 3) {
    return flowRates;
  }

  return filtered;
}

// Calculate Adaptive Flow Rate (AFR) from multiple pulls
// Uses 3-7 pulls based on flow rate consistency (like Excel VBA version)
// Filters anomalies first before calculating average
// Returns: flow rate in days per foot, or undefined if not enough data
function calculateAdaptiveFlowRate(flowRates: number[]): number | undefined {
  if (flowRates.length === 0) {
    return undefined;
  }

  // First, filter out anomalies (outliers that would skew the average)
  const cleanRates = filterAnomalies(flowRates);

  // Need at least 1 rate after filtering
  if (cleanRates.length === 0) {
    return flowRates[0]; // Fall back to most recent even if anomalous
  }

  // If less than 3 clean rates, just use what we have
  if (cleanRates.length < 3) {
    return average(cleanRates);
  }

  // Start with 3 most recent (non-anomalous) flow rates
  let bestAvg = average(cleanRates.slice(0, 3));
  let bestConsistency = calculateConsistency(cleanRates.slice(0, 3));

  // Try expanding to more samples (up to 7) if it improves consistency
  for (let n = 4; n <= Math.min(7, cleanRates.length); n++) {
    const sample = cleanRates.slice(0, n);
    const consistency = calculateConsistency(sample);

    // If this sample is more consistent (lower variance), use it
    // Consistency threshold: new sample must be at least as good
    if (consistency <= bestConsistency * 1.1) { // Allow 10% tolerance
      bestConsistency = consistency;
      bestAvg = average(sample);
    }
  }

  return bestAvg;
}

// Calculate average of an array
function average(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, val) => sum + val, 0) / arr.length;
}

// Calculate consistency score (coefficient of variation)
// Lower is better - 0 means perfectly consistent
function calculateConsistency(flowRates: number[]): number {
  if (flowRates.length < 2) return 0;

  const avg = average(flowRates);
  if (avg === 0) return Infinity;

  // Standard deviation
  const variance = flowRates.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / flowRates.length;
  const stdDev = Math.sqrt(variance);

  // Coefficient of variation (normalized measure of dispersion)
  return stdDev / avg;
}

// Format days to H:MM:SS string
function daysToHMMSS(days: number): string {
  if (days <= 0 || !isFinite(days)) return '--';
  const totalSeconds = Math.floor(days * 24 * 60 * 60);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// NEW: Fetch well history from unified structure
// Returns pre-calculated data from wells/{wellName}/history
// If calculated fields are missing, computes them client-side
export async function fetchWellHistoryUnified(wellName: string, limit: number = 0): Promise<PullPacket[]> {
  const db = getFirebaseDatabase();
  console.log(`[fetchWellHistoryUnified] Loading history for: ${wellName}`);

  // Single source of truth: packets/processed
  // The wells/{wellName}/history path was a one-time migration and is stale — skip it
  let processedSnapshot;
  try {
    const processedRef = ref(db, 'packets/processed');
    processedSnapshot = await get(processedRef);
  } catch {
    const remote = await adminGetWellHistory(wellName);
    const pulls = (remote.pulls || []).map((data) => historyPullFromRecord(data, wellName));
    return limit > 0 ? pulls.slice(0, limit) : pulls;
  }

  if (!processedSnapshot.exists()) {
    console.log('[fetchWellHistoryUnified] No processed packets found');
    return [];
  }

  const pulls: PullPacket[] = [];
  const cleanWellName = wellName.toLowerCase().replace(/\s/g, '');

  processedSnapshot.forEach((child) => {
    const key = child.key || '';
    // Skip edit_ prefixed records — these are raw edit requests, not processed pulls
    if (key.startsWith('edit_')) return;
    const data = child.val();
    if (data.wellName &&
        data.wellName.toLowerCase().replace(/\s/g, '') === cleanWellName) {
      const tankTopInches = data.tankTopInches || (data.tankLevelFeet || 0) * 12;
      const timestamp = data.dateTimeUTC || data.dateTime || '';
      const bblsTaken = typeof data.bblsTaken === 'number' ? data.bblsTaken : (parseFloat(data.bblsTaken) || 0);
      pulls.push({
        packetId: child.key || data.packetId,
        wellName: data.wellName,
        tankTopLevel: tankTopInches,
        bblsTaken: bblsTaken,
        timestamp: timestamp,
        driverName: data.driverName,
        tankAfter: data.tankAfterInches,
        timeDif: data.timeDif,
        recoveryInches: data.recoveryInches,
        flowRate: data.flowRate,
        flowRateDays: data.flowRateDays,
        editedAt: data.editedAt,
        editedBy: data.editedBy,
        editCount: typeof data.editCount === 'number' ? data.editCount : undefined,
        originalSubmittedAt: data.originalSubmittedAt,
        isEdit: data.isEdit === true,
        noLevel: data.noLevel || false,
        jobType: data.jobType,
        wellDown: data.wellDown || false,
      });
    }
  });

  console.log(`[fetchWellHistoryUnified] Found ${pulls.length} packets for ${wellName}`);

  // Sort by timestamp descending (newest first)
  pulls.sort((a, b) => {
    const timeA = new Date(a.timestamp).getTime() || 0;
    const timeB = new Date(b.timestamp).getTime() || 0;
    return timeB - timeA;
  });

  // Calculate missing fields (timeDif, recoveryInches, flowRate) if not present
  for (let i = 0; i < pulls.length; i++) {
    const pull = pulls[i];
    const prevPull = pulls[i + 1]; // Older pull (i+1 because sorted descending)

    if (prevPull) {
      const thisTime = new Date(pull.timestamp).getTime();
      const prevTime = new Date(prevPull.timestamp).getTime();

      // Time Dif - calculate if missing
      if (!pull.timeDif && !isNaN(thisTime) && !isNaN(prevTime) && thisTime > prevTime) {
        const timeDifDays = (thisTime - prevTime) / (1000 * 60 * 60 * 24);
        pull.timeDif = daysToHMM(timeDifDays);

        // Recovery Inches = current tank top - previous tank after
        if ((pull.recoveryInches === undefined || pull.recoveryInches === 0) && prevPull.tankAfter !== undefined) {
          pull.recoveryInches = Math.max(0, pull.tankTopLevel - prevPull.tankAfter);
        }

        // Flow Rate = time per foot of rise
        if ((!pull.flowRate || pull.flowRateDays === 0) && pull.recoveryInches && pull.recoveryInches >= 0.5) {
          const flowRateDays = (timeDifDays / pull.recoveryInches) * 12;
          if (flowRateDays > 0 && flowRateDays < 365) {
            pull.flowRateDays = flowRateDays;
            pull.flowRate = daysToHMMSS(flowRateDays);
          }
        }
      }
    }
  }

  // ANOMALY DETECTION: Calculate anomaly levels PROGRESSIVELY
  // Each row is compared against median of PREVIOUS rows only (not itself or future rows)
  // This matches VBA behavior - detect anomalies as they would appear when data was entered
  //
  // Mirrors filterAnomalies() in functions/src/index.ts — keep these in sync.
  // Includes regime-shift escape: if the LAST N pulls were all flagged Tier-2 in
  // the same direction, the baseline is stale; re-tag the run as a fresh sequence.

  // Pulls are sorted newest first, so we iterate from oldest to newest (reverse)
  const knownFlowRates: number[] = [];
  // Track each rate's index in the pulls[] array + rejection direction so we can
  // detect a tail rejection run after the loop. Direction: 0=accepted, +1=rejected
  // higher than baseline, -1=rejected lower.
  const ratesInOrder: { pullIndex: number; rate: number; direction: number }[] = [];

  for (let i = pulls.length - 1; i >= 0; i--) {
    const pull = pulls[i];

    if (pull.flowRateDays && pull.flowRateDays > 0 && pull.flowRateDays < 365) {
      let direction = 0;
      // Check anomaly against median of PREVIOUS rows (knownFlowRates)
      if (knownFlowRates.length >= 3) {
        const medianRate = median(knownFlowRates);
        pull.anomalyLevel = getFlowRateAnomalyLevel(pull.flowRateDays, medianRate);
        if (pull.anomalyLevel === 2) {
          direction = pull.flowRateDays > medianRate ? 1 : -1;
        }
      } else {
        pull.anomalyLevel = 0; // Not enough data to determine
      }

      // Add this rate to known rates for future comparisons
      // BUT only if it's not an anomaly (level 2) - anomalies don't pollute the median
      if (pull.anomalyLevel !== 2) {
        knownFlowRates.push(pull.flowRateDays);
      }
      ratesInOrder.push({ pullIndex: i, rate: pull.flowRateDays, direction });
    } else {
      pull.anomalyLevel = 0; // No flow rate to evaluate
    }
  }

  // Regime-shift escape: tail rejection run
  const REGIME_SHIFT_THRESHOLD = 3;
  let runDir = 0;
  let runStart = -1;
  for (let i = ratesInOrder.length - 1; i >= 0; i--) {
    const d = ratesInOrder[i].direction;
    if (d === 0) break;
    if (runDir === 0) runDir = d;
    if (d !== runDir) break;
    runStart = i;
  }
  if (runStart >= 0 && (ratesInOrder.length - runStart) >= REGIME_SHIFT_THRESHOLD) {
    // Reseed: re-tag the run rates as a fresh chronological sequence
    const reseed: number[] = [];
    for (let i = runStart; i < ratesInOrder.length; i++) {
      const entry = ratesInOrder[i];
      const pull = pulls[entry.pullIndex];
      if (reseed.length >= 3) {
        const medianRate = median(reseed);
        pull.anomalyLevel = getFlowRateAnomalyLevel(entry.rate, medianRate);
      } else {
        pull.anomalyLevel = 0;
      }
      if (pull.anomalyLevel !== 2) {
        reseed.push(entry.rate);
      }
    }
    // Pass-2-style overall-median check on the reseeded run — catches outliers
    // that were grandfathered in during the reseed (e.g. a single huge Apr-9
    // post-lapse pull at the head of an otherwise consistent run).
    if (reseed.length >= 5) {
      const overallMedian = median(reseed);
      for (let i = runStart; i < ratesInOrder.length; i++) {
        const entry = ratesInOrder[i];
        const pull = pulls[entry.pullIndex];
        const newLevel = getFlowRateAnomalyLevel(entry.rate, overallMedian);
        if (newLevel === 2 && pull.anomalyLevel !== 2) {
          pull.anomalyLevel = 2;
        }
      }
    }
  }

  console.log(`[fetchWellHistoryUnified] Found ${pulls.length} entries`);
  return limit > 0 ? pulls.slice(0, limit) : pulls;
}

// LEGACY: Fetch pull history for a well (from processed/)
// Calculates derived fields client-side (Cloud Function may not have run on historical data)
export async function fetchWellHistory(wellName: string, limit: number = 0): Promise<PullPacket[]> {
  const db = getFirebaseDatabase();
  console.log(`[fetchWellHistory] Loading history for: ${wellName}`);

  // Get all processed packets for this well
  const processedRef = ref(db, 'packets/processed');
  const snapshot = await get(processedRef);

  if (!snapshot.exists()) {
    console.log('[fetchWellHistory] No processed packets found');
    return [];
  }

  // Also get well config for tanks count and pull target
  const configRef = ref(db, 'well_config');
  const configSnapshot = await get(configRef);
  let tanks = 1;
  let pullBbls = 140;
  let bottomLevel = 3; // feet
  let bblPerFootPerTank = 20; // default: standard 400 BBL / 20' tank
  if (configSnapshot.exists()) {
    configSnapshot.forEach((child) => {
      const key = child.key || '';
      if (key.toLowerCase().replace(/\s/g, '') === wellName.toLowerCase().replace(/\s/g, '')) {
        const config = child.val();
        tanks = config.tanks || config.numTanks || 1;
        pullBbls = config.pullBbls || 140;
        bottomLevel = config.bottomLevel || config.allowedBottom || 3;
        bblPerFootPerTank = config.bblPerFoot ? config.bblPerFoot / tanks : 20;
      }
    });
  }
  const bottomInches = bottomLevel * 12;

  // Collect packets for this well
  const pulls: PullPacket[] = [];
  let matchedPackets = 0;

  snapshot.forEach((child) => {
    const data = child.val();

    // Match well name (normalize: lowercase, no spaces)
    if (data.wellName &&
        data.wellName.toLowerCase().replace(/\s/g, '') === wellName.toLowerCase().replace(/\s/g, '')) {
      matchedPackets++;

      // BACKWARD COMPATIBLE: Handle multiple field name formats
      // Tank level: tankTopInches (Cloud Function) OR tankLevelFeet * 12 (raw)
      const tankTopInches = data.tankTopInches || (data.tankLevelFeet || 0) * 12;

      // Timestamp: dateTimeUTC (preferred) OR dateTime (legacy)
      const timestamp = data.dateTimeUTC || data.dateTime || '';

      // BBLs: handle undefined/null/string
      const bblsTaken = typeof data.bblsTaken === 'number' ? data.bblsTaken :
                        (parseFloat(data.bblsTaken) || 0);

      pulls.push({
        packetId: child.key || data.packetId,
        wellName: data.wellName,
        tankTopLevel: tankTopInches,
        bblsTaken: bblsTaken,
        timestamp: timestamp,
        driverName: data.driverName,
        driverId: data.driverId,
        // These will be calculated below if not present from Cloud Function
        tankAfter: data.tankAfterInches,
        timeDif: data.timeDif,
        recoveryInches: data.recoveryInches,
        flowRate: data.flowRate,
        flowRateDays: data.flowRateDays,
        recoveryNeeded: data.recoveryNeeded,
        estTimeToPull: data.estTimeToPull,
        estDateTimePull: data.estDateTimePull,
      });
    }
  });
  console.log(`[fetchWellHistory] Found ${matchedPackets} packets for ${wellName}`);

  // Sort by timestamp descending (newest first)
  pulls.sort((a, b) => {
    const timeA = new Date(a.timestamp).getTime() || 0;
    const timeB = new Date(b.timestamp).getTime() || 0;
    return timeB - timeA;
  });

  // PASS 1: Calculate tankAfter and individual flow rates for each pull
  // ALWAYS recalculate tankAfter using current config - don't trust stored values
  // (stored values may have been calculated with wrong tank count)
  for (let i = 0; i < pulls.length; i++) {
    const pull = pulls[i];
    const prevPull = pulls[i + 1]; // Older pull (index+1 because sorted descending)

    // Tank After - ALWAYS recalculate with current tank count from config
    const bblsToInches = (pull.bblsTaken / (20 * tanks)) * 12;
    pull.tankAfter = pull.tankTopLevel - bblsToInches;

    if (prevPull) {
      // Ensure prev has tankAfter calculated
      const prevBblsToInches = (prevPull.bblsTaken / (20 * tanks)) * 12;
      prevPull.tankAfter = prevPull.tankTopLevel - prevBblsToInches;

      // Time Dif
      if (!pull.timeDif) {
        const thisTime = new Date(pull.timestamp).getTime();
        const prevTime = new Date(prevPull.timestamp).getTime();

        if (!isNaN(thisTime) && !isNaN(prevTime) && thisTime > prevTime) {
          const timeDifDays = (thisTime - prevTime) / (1000 * 60 * 60 * 24);
          pull.timeDif = daysToHMM(timeDifDays);

          // Recovery Inches = current tank top - previous tank after
          if (pull.recoveryInches === undefined) {
            pull.recoveryInches = Math.max(0, pull.tankTopLevel - (prevPull.tankAfter || 0));
          }

          // Flow Rate = time per foot of rise (individual pull rate)
          // Only calculate if recovery is meaningful (at least 0.5 inches to avoid division issues)
          if (!pull.flowRate && pull.recoveryInches && pull.recoveryInches >= 0.5) {
            const flowRateDays = (timeDifDays / pull.recoveryInches) * 12;
            // Sanity check: flow rate shouldn't be more than 365 days per foot
            if (flowRateDays > 0 && flowRateDays < 365) {
              pull.flowRateDays = flowRateDays;
              pull.flowRate = daysToHMMSS(flowRateDays);
            }
          }
        }
      }
    }
  }

  // PASS 2: Collect valid flow rates for AFR calculation
  const validFlowRates: number[] = [];
  for (const pull of pulls) {
    if (pull.flowRateDays && pull.flowRateDays > 0 && pull.flowRateDays < 365) {
      validFlowRates.push(pull.flowRateDays);
    }
  }

  // Calculate Adaptive Flow Rate (AFR) using 3-7 samples based on consistency
  const afrDays = calculateAdaptiveFlowRate(validFlowRates);

  // PASS 3: Apply AFR to the most recent pull for current level and time estimates
  if (pulls.length > 0 && afrDays) {
    const mostRecent = pulls[0];
    const thisTime = new Date(mostRecent.timestamp).getTime();

    // Store the AFR as the effective flow rate for display
    mostRecent.flowRateDays = afrDays;
    mostRecent.flowRate = daysToHMMSS(afrDays);

    // Recovery Needed
    if (mostRecent.recoveryNeeded === undefined) {
      const pullHeightInches = (pullBbls / (bblPerFootPerTank * tanks)) * 12;
      const targetLevel = bottomInches + pullHeightInches;
      mostRecent.recoveryNeeded = Math.max(0, targetLevel - (mostRecent.tankAfter || 0));
    }

    // Est Time to Pull (using AFR)
    if (!mostRecent.estTimeToPull && mostRecent.recoveryNeeded && mostRecent.recoveryNeeded > 0) {
      const estDays = (mostRecent.recoveryNeeded / 12) * afrDays;
      mostRecent.estTimeToPull = daysToHMM(estDays);
      // Only set estDateTimePull if the calculation produces a valid date
      const estDateMs = thisTime + estDays * 24 * 60 * 60 * 1000;
      if (isFinite(estDateMs) && estDateMs > 0) {
        const estDate = new Date(estDateMs);
        if (!isNaN(estDate.getTime())) {
          mostRecent.estDateTimePull = estDate.toISOString();
        }
      }
    }

    // Current Level Est (real-time, using AFR)
    const nowTime = Date.now();
    const elapsedDays = (nowTime - thisTime) / (1000 * 60 * 60 * 24);
    const inchesRisen = (elapsedDays / afrDays) * 12;
    mostRecent.currentLevelEst = (mostRecent.tankAfter || 0) + inchesRisen;

    // console.log(`[AFR] ${wellName}: Using ${validFlowRates.length >= 3 ? '3-7' : validFlowRates.length} samples, AFR = ${daysToHMMSS(afrDays)}`);
  }

  return limit > 0 ? pulls.slice(0, limit) : pulls;
}

// Fetch performance data for a well
export async function fetchWellPerformance(wellName: string): Promise<PerformanceRow[]> {
  const db = getFirebaseDatabase();
  // Performance keys use underscores for spaces (e.g. "Gabriel_3")
  const cleanName = wellName.replace(/\s/g, '_');
  const perfRef = ref(db, `performance/${cleanName}/rows`);
  const snapshot = await get(perfRef);

  if (!snapshot.exists()) return [];

  const rows: PerformanceRow[] = [];
  snapshot.forEach((child) => {
    const data = child.val();
    if (data.d && data.a !== undefined && data.p !== undefined) {
      rows.push({
        d: data.d,
        a: data.a,
        p: data.p,
      });
    }
  });

  // Sort by date descending
  rows.sort((a, b) => new Date(b.d).getTime() - new Date(a.d).getTime());

  return rows;
}

// Delete a pull — sends delete request to incoming/ for Cloud Function to process
// Cloud Function handles: removing from processed/, recalculating outgoing response
export async function deletePull(packetId: string, wellName: string): Promise<void> {
  const db = getFirebaseDatabase();
  const timestamp = Date.now();
  const cleanWellName = wellName.replace(/\s/g, '');
  const deletePacketId = `delete_${timestamp}_${cleanWellName}`;

  const deletePacket = {
    requestType: 'delete',
    packetId: packetId,
    wellName: wellName,
    timestamp: new Date().toISOString(),
    source: 'dashboard',
  };

  const deleteRef = ref(db, `packets/incoming/${deletePacketId}`);
  await set(deleteRef, deletePacket);
}

// Edit a pull (sends edit packet for Cloud Function to process)
// newLevelInches: tank top level in inches
// newBbls: BBLs taken
// newDateTimeUTC: optional new date/time in ISO format
export async function editPull(
  originalPacketId: string,
  wellName: string,
  newLevelInches: number,
  newBbls: number,
  newDateTimeUTC?: string,
  wellDown?: boolean
): Promise<void> {
  const db = getFirebaseDatabase();
  const timestamp = Date.now();
  const cleanWellName = wellName.replace(/\s/g, '');
  const editPacketId = `edit_${timestamp}_${cleanWellName}`;

  const editPacket: Record<string, any> = {
    requestType: 'edit',
    originalPacketId: originalPacketId,
    wellName: wellName,
    tankTopInches: newLevelInches,
    bblsTaken: newBbls,
    timestamp: new Date().toISOString(),
    source: 'dashboard',
    wellDown: wellDown || false,
    // 5/8/2026 — explicit authority signal: a dashboard edit IS an
    // authoritative statement about wellDown. CF respects this.
    wellDownIsAuthoritative: true,
  };

  if (newDateTimeUTC) {
    editPacket.dateTimeUTC = newDateTimeUTC;
    editPacket.dateTime = new Date(newDateTimeUTC).toLocaleString();
  }

  const editRef = ref(db, `packets/incoming/${editPacketId}`);
  await set(editRef, editPacket);
}

/** Immutable correction trail for a processed packet (packets/editHistory/{id}). */
export async function fetchEditHistory(
  packetId: string,
): Promise<
  Array<{
    eventId: string;
    sequence: number;
    editedAt: string;
    source: string;
    fields: Array<{ field: string; previous: unknown; next: unknown }>;
    resolutionPath?: string;
  }>
> {
  if (!packetId) return [];
  const db = getFirebaseDatabase();
  const snap = await get(ref(db, `packets/editHistory/${packetId}`));
  if (!snap.exists()) return [];
  const rows: Array<{
    eventId: string;
    sequence: number;
    editedAt: string;
    source: string;
    fields: Array<{ field: string; previous: unknown; next: unknown }>;
    resolutionPath?: string;
  }> = [];
  snap.forEach((child) => {
    const v = child.val() || {};
    rows.push({
      eventId: child.key || v.eventId || '',
      sequence: typeof v.sequence === 'number' ? v.sequence : 0,
      editedAt: v.editedAt || '',
      source: v.source || 'unknown',
      fields: Array.isArray(v.fields) ? v.fields : [],
      resolutionPath: v.resolutionPath,
    });
  });
  rows.sort((a, b) => a.sequence - b.sequence || a.editedAt.localeCompare(b.editedAt));
  return rows;
}

// Format inches to feet'inches" display
export function formatLevel(inches: number): string {
  const totalInches = Math.round(inches);
  const feet = Math.floor(totalInches / 12);
  const remainingInches = totalInches % 12;
  return `${feet}'${remainingInches}"`;
}

// Calculate accuracy percentage
export function calculateAccuracy(predicted: number, actual: number): number {
  if (actual === 0) return 0;
  return (predicted / actual) * 100;
}

// Get accuracy color class
export function getAccuracyColor(accuracy: number): string {
  const diff = Math.abs(accuracy - 100);
  if (diff <= 5) return 'text-green-400';
  if (diff <= 10) return 'text-yellow-400';
  return 'text-red-400';
}

// Get accuracy color as hex (for cards/badges)
export function getAccuracyColorHex(accuracy: number): string {
  const diff = Math.abs(accuracy - 100);
  if (diff <= 5) return '#10B981';
  if (diff <= 10) return '#F59E0B';
  return '#EF4444';
}

// "Real" accuracy — treats over/under equally (distance from 100%)
export function getRealAccuracy(rawAccuracy: number): number {
  return 100 - Math.abs(100 - rawAccuracy);
}

// Anomaly detection threshold (30% off from median deviation)
const PERF_ANOMALY_THRESHOLD = 30;

export interface ProcessedPerfRow {
  date: string;
  dateObj: Date;
  actualInches: number;
  predictedInches: number;
  accuracy: number;
  isAnomaly: boolean;
}

export interface WellPerformanceStats {
  wellName: string;
  route: string;
  pullCount: number;
  avgAccuracy: number;
  bestAccuracy: number;
  worstAccuracy: number;
  trend: 'up' | 'down' | 'stable';
  anomalyCount: number;
  rows: ProcessedPerfRow[];
  // Counts by accuracy band
  greenCount: number;   // within 5%
  yellowCount: number;  // within 10%
  redCount: number;     // > 10% off
}

export interface RoutePerformanceStats {
  routeName: string;
  wellCount: number;
  pullCount: number;
  avgAccuracy: number;
  improving: number;
  declining: number;
  stable: number;
  wells: WellPerformanceStats[];
}

// Process raw performance rows with anomaly detection
export function processPerformanceRows(rawRows: PerformanceRow[]): ProcessedPerfRow[] {
  const rows: ProcessedPerfRow[] = rawRows.map(r => ({
    date: r.d,
    dateObj: new Date(r.d + 'T12:00:00'),
    actualInches: r.a,
    predictedInches: r.p,
    accuracy: r.a === 0 ? 0 : (r.p / r.a) * 100,
    isAnomaly: false,
  }));

  // Anomaly detection: find median deviation, mark rows > median + threshold
  if (rows.length >= 5) {
    const deviations = rows.map(r => Math.abs(100 - r.accuracy));
    const sortedDeviations = [...deviations].sort((a, b) => a - b);
    const medianDeviation = sortedDeviations[Math.floor(sortedDeviations.length / 2)];
    const maxAllowedDeviation = medianDeviation + PERF_ANOMALY_THRESHOLD;

    rows.forEach((row, i) => {
      if (deviations[i] > maxAllowedDeviation) {
        row.isAnomaly = true;
      }
    });
  }

  return rows;
}

// Calculate well performance stats from processed rows
export function calcWellStats(
  wellName: string,
  route: string,
  rows: ProcessedPerfRow[]
): WellPerformanceStats {
  const nonAnomalous = rows.filter(r => !r.isAnomaly);
  const forAvg = nonAnomalous.length > 0 ? nonAnomalous : rows;

  // Use "real accuracy" (distance from 100%) to match WB Mobile's calculation
  const avgAccuracy = forAvg.length > 0
    ? Math.round((forAvg.reduce((s, r) => s + getRealAccuracy(r.accuracy), 0) / forAvg.length) * 10) / 10
    : 0;

  // Best/worst determined by smallest/largest deviation from 100%
  let bestAccuracy = 0;
  let worstAccuracy = 200;
  for (const r of rows) {
    const real = getRealAccuracy(r.accuracy);
    if (real > getRealAccuracy(bestAccuracy)) bestAccuracy = r.accuracy;
    if (real < getRealAccuracy(worstAccuracy)) worstAccuracy = r.accuracy;
  }

  // Trend: compare first half vs second half (non-anomalous, by date ascending)
  let trend: 'up' | 'down' | 'stable' = 'stable';
  const sorted = [...nonAnomalous].sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
  if (sorted.length >= 10) {
    const mid = Math.floor(sorted.length / 2);
    const firstHalf = sorted.slice(0, mid);
    const secondHalf = sorted.slice(mid);
    const firstAvg = firstHalf.reduce((s, r) => s + getRealAccuracy(r.accuracy), 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((s, r) => s + getRealAccuracy(r.accuracy), 0) / secondHalf.length;
    if (secondAvg > firstAvg + 2) trend = 'up';
    else if (secondAvg < firstAvg - 2) trend = 'down';
  }

  // Band counts
  let greenCount = 0, yellowCount = 0, redCount = 0;
  for (const r of rows) {
    const diff = Math.abs(100 - r.accuracy);
    if (diff <= 5) greenCount++;
    else if (diff <= 10) yellowCount++;
    else redCount++;
  }

  return {
    wellName,
    route,
    pullCount: rows.length,
    avgAccuracy,
    bestAccuracy,
    worstAccuracy,
    trend,
    anomalyCount: rows.filter(r => r.isAnomaly).length,
    rows,
    greenCount,
    yellowCount,
    redCount,
  };
}

// Fetch all performance data in one shot (entire performance/ node)
function historyPullFromRecord(data: Record<string, unknown>, wellName: string): PullPacket {
  const tankTopInches = (data.tankTopInches as number) || ((data.tankLevelFeet as number) || 0) * 12;
  return {
    packetId: String(data.packetId || ''),
    wellName: String(data.wellName || wellName),
    tankTopLevel: tankTopInches,
    bblsTaken: typeof data.bblsTaken === 'number' ? data.bblsTaken : parseFloat(String(data.bblsTaken || '0')) || 0,
    timestamp: String(data.dateTimeUTC || data.dateTime || ''),
    driverName: data.driverName as string | undefined,
    tankAfter: data.tankAfterInches as number | undefined,
    timeDif: data.timeDif as string | undefined,
    recoveryInches: data.recoveryInches as number | undefined,
    flowRate: data.flowRate as string | undefined,
    flowRateDays: data.flowRateDays as number | undefined,
    editedAt: data.editedAt as string | undefined,
    editedBy: data.editedBy as string | undefined,
    editCount: typeof data.editCount === 'number' ? data.editCount : undefined,
    originalSubmittedAt: data.originalSubmittedAt as string | undefined,
    isEdit: data.isEdit === true,
    noLevel: data.noLevel === true,
    jobType: data.jobType as string | undefined,
    wellDown: data.wellDown === true,
  };
}

export async function fetchAllPerformanceData(): Promise<Record<string, PerformanceRow[]>> {
  const db = getFirebaseDatabase();
  let snapshot;
  try {
    const perfRef = ref(db, 'performance');
    snapshot = await get(perfRef);
  } catch {
    const remote = await adminGetWellPerformance();
    return remote.rows || {};
  }

  if (!snapshot.exists()) return {};

  const result: Record<string, PerformanceRow[]> = {};
  snapshot.forEach((wellChild) => {
    const wellName = wellChild.child('wellName').val() || wellChild.key;
    const rowsNode = wellChild.child('rows');
    if (!rowsNode.exists()) return;

    const rows: PerformanceRow[] = [];
    rowsNode.forEach((rowChild) => {
      const data = rowChild.val();
      if (data && data.d && data.a !== undefined && data.p !== undefined) {
        rows.push({ d: data.d, a: data.a, p: data.p });
      }
    });

    if (rows.length > 0) {
      // Sort descending by date
      rows.sort((a, b) => new Date(b.d).getTime() - new Date(a.d).getTime());
      result[wellName!] = rows;
    }
  });

  return result;
}

// Build full performance summary: routes and wells
export async function buildPerformanceSummary(): Promise<{
  routes: RoutePerformanceStats[];
  overallAvg: number;
  totalWells: number;
  totalPulls: number;
}> {
  const [allPerf, configs] = await Promise.all([
    fetchAllPerformanceData(),
    fetchWellConfigs(),
  ]);

  const wellStats: WellPerformanceStats[] = [];

  for (const [perfKey, rawRows] of Object.entries(allPerf)) {
    // Match config by normalizing: spaces and underscores treated the same
    const configEntry = Object.entries(configs).find(([key]) => {
      const normalize = (s: string) => s.replace(/[\s_]/g, '').toLowerCase();
      return normalize(key) === normalize(perfKey);
    });

    const wellName = configEntry ? configEntry[0] : perfKey;
    const route = configEntry?.[1]?.route || 'Unrouted';

    const processed = processPerformanceRows(rawRows);
    const stats = calcWellStats(wellName, route, processed);
    wellStats.push(stats);
  }

  // Group by route
  const routeMap = new Map<string, WellPerformanceStats[]>();
  for (const ws of wellStats) {
    const existing = routeMap.get(ws.route) || [];
    existing.push(ws);
    routeMap.set(ws.route, existing);
  }

  const MIN_PULLS_FOR_AVG = 5;
  const routes: RoutePerformanceStats[] = [];
  let totalAccuracy = 0;
  let totalWellsForAvg = 0;

  for (const [routeName, wells] of routeMap) {
    // Skip Test Route
    if (routeName.toLowerCase().includes('test')) continue;

    wells.sort((a, b) => a.wellName.localeCompare(b.wellName));

    const routePulls = wells.reduce((s, w) => s + w.pullCount, 0);
    const qualifiedWells = wells.filter(w => w.pullCount >= MIN_PULLS_FOR_AVG);
    const routeAvg = qualifiedWells.length > 0
      ? qualifiedWells.reduce((s, w) => s + w.avgAccuracy, 0) / qualifiedWells.length
      : 0;

    routes.push({
      routeName,
      wellCount: wells.length,
      pullCount: routePulls,
      avgAccuracy: routeAvg,
      improving: wells.filter(w => w.trend === 'up').length,
      declining: wells.filter(w => w.trend === 'down').length,
      stable: wells.filter(w => w.trend === 'stable').length,
      wells,
    });

    // Add qualified wells to overall
    for (const w of qualifiedWells) {
      totalAccuracy += w.avgAccuracy;
      totalWellsForAvg++;
    }
  }

  routes.sort((a, b) => a.routeName.localeCompare(b.routeName));

  return {
    routes,
    overallAvg: totalWellsForAvg > 0 ? totalAccuracy / totalWellsForAvg : 0,
    totalWells: wellStats.filter(w => !w.route.toLowerCase().includes('test')).length,
    totalPulls: wellStats.filter(w => !w.route.toLowerCase().includes('test')).reduce((s, w) => s + w.pullCount, 0),
  };
}
