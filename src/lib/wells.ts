// Well data utilities - fetches from Firebase
import { ref, get, onValue, query, orderByChild, set } from 'firebase/database';
import { getFirebaseDatabase } from './firebase';

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
}

export interface WellConfig {
  route?: string;
  maxLevel?: number;
  bottomLevel?: number;
  tanks?: number;
  pullBbls?: number;
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
  // Edit tracking
  editedAt?: string;        // ISO string - when the edit was made
  editedBy?: string;        // who made the edit (e.g. 'dashboard')
}

export interface PerformanceRow {
  d: string;  // date
  a: number;  // actual (inches)
  p: number;  // predicted (inches)
}

// Fetch well configs (route assignments, etc)
export async function fetchWellConfigs(): Promise<Record<string, WellConfig>> {
  const db = getFirebaseDatabase();
  const configRef = ref(db, 'well_config');
  const snapshot = await get(configRef);

  if (!snapshot.exists()) return {};

  const configs: Record<string, WellConfig> = {};
  snapshot.forEach((child) => {
    configs[child.key!] = child.val();
  });
  return configs;
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
    // Sort by route order (alphabetical, Unrouted last), then by well name within each route
    wells.sort((a, b) => {
      if (a.route !== b.route) {
        if (a.route === 'Unrouted') return 1;
        if (b.route === 'Unrouted') return -1;
        return a.route.localeCompare(b.route);
      }
      return a.wellName.localeCompare(b.wellName);
    });
    callback(wells);
  });

  return unsubscribe;
}

// Fetch all current well statuses (from outgoing/)
export async function fetchAllWellStatuses(): Promise<WellResponse[]> {
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

  // Sort by well name
  return responses.sort((a, b) => a.wellName.localeCompare(b.wellName));
}

// Helper: Parse "X'Y\"" to inches
function parseFeetInchesStr(str: string): number {
  if (!str) return 0;
  const match = str.match(/(\d+)'(\d+)"/);
  if (match) return parseInt(match[1]) * 12 + parseInt(match[2]);
  return 0;
}

// Helper: Calculate Tank @ Level from config values
function calcTankAtLevel(tanks: number, pullBbls: number, bottomInches: number): { tankAtInches: number; tankAtLevel: string } {
  const bblsPerTank = pullBbls / tanks;
  const tankAtInches = ((bblsPerTank / 20) * 12) + bottomInches;
  const tankAtFeet = Math.floor(tankAtInches / 12);
  const tankAtRemainder = Math.round(tankAtInches - (tankAtFeet * 12));
  return { tankAtInches, tankAtLevel: `${tanks} @ ${tankAtFeet}'${tankAtRemainder}"` };
}

// Helper: Estimate current level from bottom level + elapsed time + flow rate
function estimateCurrentLevel(
  bottomInches: number,
  lastPullTimeUTC: string,
  flowRateMinutes: number,
): number | null {
  if (!lastPullTimeUTC || flowRateMinutes <= 0 || bottomInches <= 0) return null;
  const lastPullTime = new Date(lastPullTimeUTC).getTime();
  if (isNaN(lastPullTime) || lastPullTime <= 0) return null;
  const minutesElapsed = (Date.now() - lastPullTime) / (1000 * 60);
  const minutesPerInch = flowRateMinutes / 12;
  const inchesRisen = minutesElapsed / minutesPerInch;
  return bottomInches + inchesRisen;
}

// Helper: Format inches as feet'inches"
function inchesToDisplay(totalInches: number): string {
  const feet = Math.floor(totalInches / 12);
  const inches = Math.floor(totalInches % 12);
  return `${feet}'${inches}"`;
}

// Helper: Calculate time till pull from current inches to target inches at given flow rate
function calcTimeTillPull(currentInches: number, targetInches: number, flowRateMinutes: number): string {
  if (flowRateMinutes <= 0) return 'Unknown';
  const inchesNeeded = targetInches - currentInches;
  if (inchesNeeded <= 0) return 'Ready';
  const minutesPerInch = flowRateMinutes / 12;
  const totalMinutes = inchesNeeded * minutesPerInch;
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const mins = Math.floor(totalMinutes % 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  return `${hours}h ${mins}m`;
}

// Subscribe to well statuses using packets/outgoing (the response packets) + well_config
// packets/outgoing is THE source of current well status — written by Cloud Functions on every pull
export function subscribeToWellStatusesUnified(callback: (wells: WellResponse[], routes: string[]) => void): () => void {
  const db = getFirebaseDatabase();
  const configRef = ref(db, 'well_config');
  const outgoingRef = ref(db, 'packets/outgoing');

  let configData: Record<string, WellConfig> = {};
  let outgoingData: Record<string, WellResponse> = {};
  let gotConfigs = false;
  let gotOutgoing = false;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 300;

  const timeout = setTimeout(() => {
    if (!gotConfigs || !gotOutgoing) {
      console.warn('[wells.ts] Subscription timeout - showing partial data');
      mergeAndCallback(true);
    }
  }, 5000);

  const mergeAndCallback = (force = false) => {
    if (!force && (!gotConfigs || !gotOutgoing)) return;
    if (gotConfigs && gotOutgoing) clearTimeout(timeout);

    const allWells: WellResponse[] = [];

    // Build wells list from well_config (master list), merge with outgoing response data
    Object.entries(configData).forEach(([wellKey, config]) => {
      const tanks = config.tanks || (config as any).numTanks || 1;
      const pullBbls = config.pullBbls || 140;
      const bottomLevelFeet = config.bottomLevel || (config as any).allowedBottom || 3;
      const bottomInches = bottomLevelFeet * 12;
      const { tankAtInches, tankAtLevel } = calcTankAtLevel(tanks, pullBbls, bottomInches);

      // Look for outgoing response packet for this well
      const configKeyNoSpaces = wellKey.replace(/\s/g, '');
      const outgoing = outgoingData[configKeyNoSpaces];

      if (outgoing) {
        // Has outgoing response — use it as the source of truth
        let currentLevel = outgoing.currentLevel || '--';
        let timeTillPull = outgoing.timeTillPull || 'Unknown';
        let flowRate = outgoing.flowRate || 'Unknown';
        const isDown = outgoing.wellDown || false;

        // Get flow rate in minutes from well_config (avgFlowRateMinutes written by Cloud Function)
        const afrMinutes = (config as any).avgFlowRateMinutes || 0;

        // Estimate current level from bottom level after last pull + flow rate + time elapsed
        if (!isDown && outgoing.lastPullDateTimeUTC && outgoing.lastPullBottomLevel && afrMinutes > 0) {
          const bottomAfterPull = parseFeetInchesStr(outgoing.lastPullBottomLevel);
          const estInches = estimateCurrentLevel(bottomAfterPull, outgoing.lastPullDateTimeUTC, afrMinutes);
          if (estInches !== null) {
            currentLevel = inchesToDisplay(estInches);
            timeTillPull = calcTimeTillPull(estInches, tankAtInches, afrMinutes);
          }
        }

        // Use the stored AFR display string if we have it
        if ((config as any).avgFlowRate) {
          flowRate = (config as any).avgFlowRate;
        }

        allWells.push({
          ...outgoing,
          route: config.route || 'Unrouted',
          tanks,
          tankAtLevel,
          pullBbls,
          bottomLevel: bottomLevelFeet,
          currentLevel,
          flowRate,
          timeTillPull,
          etaToMax: timeTillPull,
          isDown,
          timestampUTC: outgoing.lastPullDateTimeUTC || outgoing.timestampUTC,
        });
      } else {
        // No outgoing data — placeholder (well exists in config but no pulls yet)
        allWells.push({
          wellName: wellKey,
          currentLevel: '--',
          etaToMax: '--',
          flowRate: '--',
          timestamp: '',
          route: config.route || 'Unrouted',
          tanks,
          tankAtLevel,
          pullBbls,
          bottomLevel: bottomLevelFeet,
        });
      }
    });

    const routes = Array.from(new Set(allWells.map((w) => w.route).filter((r): r is string => !!r)))
      .sort((a, b) => {
        // "Unrouted" always sorts last
        if (a === 'Unrouted') return 1;
        if (b === 'Unrouted') return -1;
        return a.localeCompare(b);
      });
    callback(allWells.sort((a, b) => a.wellName.localeCompare(b.wellName)), routes);
  };

  const debouncedMergeAndCallback = (force = false) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (!gotConfigs || !gotOutgoing) {
      mergeAndCallback(force);
      return;
    }
    debounceTimer = setTimeout(() => mergeAndCallback(force), DEBOUNCE_MS);
  };

  const unsubConfigs = onValue(configRef, (snapshot) => {
    gotConfigs = true;
    if (!snapshot.exists()) {
      configData = {};
    } else {
      const configs: Record<string, WellConfig> = {};
      snapshot.forEach((child) => {
        configs[child.key!] = child.val();
      });
      configData = configs;
    }
    debouncedMergeAndCallback();
  });

  const unsubOutgoing = onValue(outgoingRef, (snapshot) => {
    gotOutgoing = true;
    if (!snapshot.exists()) {
      outgoingData = {};
    } else {
      const responses: Record<string, WellResponse> = {};
      snapshot.forEach((child) => {
        const childKey = child.key || '';
        const data = child.val();
        if (childKey.startsWith('response_') && !childKey.includes('delete') && data.wellName) {
          const key = data.wellName.replace(/\s/g, '');
          responses[key] = { ...data, responseId: childKey };
        }
      });
      outgoingData = responses;
    }
    debouncedMergeAndCallback();
  });

  // Refresh every 30 seconds to update estimated levels (even if Firebase data hasn't changed)
  const refreshInterval = setInterval(() => {
    if (gotConfigs && gotOutgoing) {
      mergeAndCallback(true);
    }
  }, 30000);

  return () => {
    clearTimeout(timeout);
    if (debounceTimer) clearTimeout(debounceTimer);
    clearInterval(refreshInterval);
    unsubConfigs();
    unsubOutgoing();
  };
}

// LEGACY: Subscribe to well statuses (realtime updates) with route info
// Shows ALL wells from well_config, merges with outgoing data where available
export function subscribeToWellStatuses(callback: (wells: WellResponse[], routes: string[]) => void): () => void {
  const db = getFirebaseDatabase();
  const outgoingRef = ref(db, 'packets/outgoing');
  const configRef = ref(db, 'well_config');

  let outgoingData: Record<string, WellResponse> = {};
  let configData: Record<string, WellConfig> = {};
  let gotOutgoing = false;
  let gotConfigs = false;
  let timeoutFired = false;

  // Debounce timer - prevents rapid re-renders from multiple Firebase updates
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 300; // Wait 300ms after last update before calling callback

  // Timeout fallback - if Firebase is slow, show what we have after 5 seconds
  const timeout = setTimeout(() => {
    timeoutFired = true;
    if (!gotOutgoing || !gotConfigs) {
      console.warn('Firebase subscription timeout - showing partial data');
      mergeAndCallback(true);
    }
  }, 5000);

  const mergeAndCallback = (force = false) => {
    if (!force && (!gotOutgoing || !gotConfigs)) return;
    if (gotOutgoing && gotConfigs) clearTimeout(timeout);

    // console.log(`[wells.ts] Merging - configs: ${Object.keys(configData).length}, outgoing: ${Object.keys(outgoingData).length}`);

    // Build wells list from ALL wells in config
    const allWells: WellResponse[] = [];
    let matchedCount = 0;

    // First, add all wells from config (the master list)
    Object.entries(configData).forEach(([wellKey, config]) => {
      // Config keys may have spaces (e.g., "Gabriel 1" or "Atlas 1")
      // Outgoing is keyed by wellName with spaces stripped
      // So we need to strip spaces from config key to match
      const configKeyNoSpaces = wellKey.replace(/\s/g, '');
      const outgoing = outgoingData[configKeyNoSpaces];

      if (outgoing) {
        matchedCount++;
        // Has outgoing data - use it with route and tanks from config
        allWells.push({
          ...outgoing,
          route: config.route || 'Unrouted',
          tanks: config.tanks || 1,
        });
      } else {
        // No outgoing data - create placeholder from config
        // Config key already has proper formatting (e.g., "Gabriel 1")
        allWells.push({
          wellName: wellKey,
          currentLevel: '--',
          etaToMax: '--',
          flowRate: '--',
          timestamp: '',
          route: config.route || 'Unrouted',
          maxLevel: config.maxLevel,
          bottomLevel: config.bottomLevel,
          tanks: config.tanks || 1,
        });
      }
    });

    // Get unique routes (filter out undefined)
    const routes = Array.from(new Set(allWells.map((w) => w.route).filter((r): r is string => !!r))).sort();

    // console.log(`[wells.ts] Final: ${allWells.length} wells, ${matchedCount} with outgoing data, ${routes.length} routes`);
    callback(allWells.sort((a, b) => a.wellName.localeCompare(b.wellName)), routes);
  };

  // Debounced version - prevents rapid re-renders
  const debouncedMergeAndCallback = (force = false) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    // For initial load, call immediately
    if (!gotOutgoing || !gotConfigs) {
      mergeAndCallback(force);
      return;
    }

    // For subsequent updates, debounce to prevent rapid re-renders
    debounceTimer = setTimeout(() => {
      mergeAndCallback(force);
    }, DEBOUNCE_MS);
  };

  const unsubOutgoing = onValue(outgoingRef, (snapshot) => {
    gotOutgoing = true;
    if (!snapshot.exists()) {
      console.log('[wells.ts] No outgoing data exists');
      outgoingData = {};
    } else {
      const responses: Record<string, WellResponse> = {};
      snapshot.forEach((child) => {
        const childKey = child.key || '';
        const data = child.val();
        // Only process response_ packets (not history_, delete_, etc.)
        if (childKey.startsWith('response_') && !childKey.includes('delete') && data.wellName) {
          // Key by well name without spaces for easy lookup
          const key = data.wellName.replace(/\s/g, '');
          responses[key] = {
            ...data,
            responseId: childKey,
          };
        }
      });
      outgoingData = responses;
    }
    debouncedMergeAndCallback();
  });

  const unsubConfigs = onValue(configRef, (snapshot) => {
    gotConfigs = true;
    if (!snapshot.exists()) {
      console.log('[wells.ts] No config data exists');
      configData = {};
    } else {
      const configs: Record<string, WellConfig> = {};
      snapshot.forEach((child) => {
        configs[child.key!] = child.val();
      });
      // console.log(`[wells.ts] Loaded ${Object.keys(configs).length} well configs`);
      configData = configs;
    }
    debouncedMergeAndCallback();
  });

  return () => {
    clearTimeout(timeout);
    if (debounceTimer) clearTimeout(debounceTimer);
    unsubOutgoing();
    unsubConfigs();
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
  const processedRef = ref(db, 'packets/processed');
  const processedSnapshot = await get(processedRef);

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

  // Pulls are sorted newest first, so we iterate from oldest to newest (reverse)
  // Build up the "known" flow rates as we go
  const knownFlowRates: number[] = [];

  for (let i = pulls.length - 1; i >= 0; i--) {
    const pull = pulls[i];

    if (pull.flowRateDays && pull.flowRateDays > 0 && pull.flowRateDays < 365) {
      // Check anomaly against median of PREVIOUS rows (knownFlowRates)
      if (knownFlowRates.length >= 3) {
        const medianRate = median(knownFlowRates);
        pull.anomalyLevel = getFlowRateAnomalyLevel(pull.flowRateDays, medianRate);
      } else {
        pull.anomalyLevel = 0; // Not enough data to determine
      }

      // Add this rate to known rates for future comparisons
      // BUT only if it's not an anomaly (level 2) - anomalies don't pollute the median
      if (pull.anomalyLevel !== 2) {
        knownFlowRates.push(pull.flowRateDays);
      }
    } else {
      pull.anomalyLevel = 0; // No flow rate to evaluate
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
  if (configSnapshot.exists()) {
    configSnapshot.forEach((child) => {
      const key = child.key || '';
      if (key.toLowerCase().replace(/\s/g, '') === wellName.toLowerCase().replace(/\s/g, '')) {
        const config = child.val();
        tanks = config.tanks || config.numTanks || 1;
        pullBbls = config.pullBbls || 140;
        bottomLevel = config.bottomLevel || config.allowedBottom || 3;
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
      const pullHeightInches = (pullBbls / (20 * tanks)) * 12;
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
  newDateTimeUTC?: string
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
  };

  if (newDateTimeUTC) {
    editPacket.dateTimeUTC = newDateTimeUTC;
    editPacket.dateTime = new Date(newDateTimeUTC).toLocaleString();
  }

  const editRef = ref(db, `packets/incoming/${editPacketId}`);
  await set(editRef, editPacket);
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
export async function fetchAllPerformanceData(): Promise<Record<string, PerformanceRow[]>> {
  const db = getFirebaseDatabase();
  const perfRef = ref(db, 'performance');
  const snapshot = await get(perfRef);

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
