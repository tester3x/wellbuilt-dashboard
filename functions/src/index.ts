import * as functionsV1 from 'firebase-functions/v1';
import * as functionsV2 from 'firebase-functions/v2/scheduler';
import * as admin from 'firebase-admin';

admin.initializeApp();
const db = admin.database();

// ============================================================
// WATCHDOG: Catches stranded packets that failed to process
// Runs every 5 minutes, reprocesses any packets stuck in incoming/
// ============================================================
export const watchdogStrandedPackets = functionsV2.onSchedule('every 5 minutes', async (event) => {
  console.log('[Watchdog] Checking for stranded packets...');

  const incomingSnap = await db.ref('packets/incoming').once('value');

  if (!incomingSnap.exists()) {
    console.log('[Watchdog] No packets in incoming - all clear');
    return;
  }

  const packets = incomingSnap.val();
  const keys = Object.keys(packets);
  const now = Date.now();
  const TWO_MINUTES = 2 * 60 * 1000;

  // Group by unique timestamp+well to detect duplicates
  const uniquePackets: Record<string, { key: string; data: any; arrivedAt: number }> = {};

  for (const key of keys) {
    const data = packets[key];
    const groupKey = `${data.dateTimeUTC || data.dateTime}_${data.wellName}`;

    // Estimate arrival time from packetId (format: YYYYMMDD_HHMMSS_...)
    const match = key.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
    let arrivedAt = now - TWO_MINUTES - 1000; // Default: assume old enough
    if (match) {
      arrivedAt = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`).getTime();
    }

    // Keep only first occurrence of each unique packet
    if (!uniquePackets[groupKey] || arrivedAt < uniquePackets[groupKey].arrivedAt) {
      uniquePackets[groupKey] = { key, data, arrivedAt };
    }
  }

  // Delete all duplicates and re-trigger unique ones that are old enough
  const allKeys = new Set(keys);
  const keepKeys = new Set(Object.values(uniquePackets).map(p => p.key));
  const duplicateKeys = [...allKeys].filter(k => !keepKeys.has(k));

  // Delete duplicates
  if (duplicateKeys.length > 0) {
    console.log(`[Watchdog] Deleting ${duplicateKeys.length} duplicate packets`);
    for (const key of duplicateKeys) {
      await db.ref(`packets/incoming/${key}`).remove();
    }
  }

  // Check which unique packets are stranded (older than 2 minutes)
  const strandedPackets = Object.values(uniquePackets).filter(p => {
    const age = now - p.arrivedAt;
    return age > TWO_MINUTES;
  });

  if (strandedPackets.length === 0) {
    console.log(`[Watchdog] No stranded packets (${Object.keys(uniquePackets).length} pending, all recent)`);
    return;
  }

  console.log(`[Watchdog] Found ${strandedPackets.length} stranded packets - reprocessing`);

  // Delete and re-write each stranded packet to re-trigger onCreate
  for (const packet of strandedPackets) {
    const { key, data } = packet;

    // Delete old entry
    await db.ref(`packets/incoming/${key}`).remove();

    // Generate new key with current timestamp
    const cleanName = data.wellName.replace(/\s/g, '');
    const ts = new Date().toISOString().replace(/[-:T]/g, '').substr(0, 14);
    const rand = Math.random().toString(36).substr(2, 6);
    const newKey = `${ts}_${cleanName}_${rand}`;

    // Write with new key to trigger onCreate
    data.packetId = newKey;
    data.requestType = data.requestType || 'pull';
    data._retriggeredBy = 'watchdog';
    data._retriggeredAt = new Date().toISOString();

    await db.ref(`packets/incoming/${newKey}`).set(data);
    console.log(`[Watchdog] Retriggered: ${data.wellName} (${key} -> ${newKey})`);

    // Small delay between writes
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`[Watchdog] Done - retriggered ${strandedPackets.length} packets`);

  // Update health status
  await db.ref('system_health/watchdog').set({
    lastRun: new Date().toISOString(),
    strandedFound: strandedPackets.length,
    duplicatesDeleted: duplicateKeys.length,
    status: 'ok'
  });
});

// ============================================================
// HEALTH CHECK: Runs every 10 minutes, verifies system is working
// Writes status to system_health/ so dashboard can show alerts
// ============================================================
export const healthCheck = functionsV2.onSchedule('every 10 minutes', async (event) => {
  const now = new Date();
  console.log('[HealthCheck] Running system health check...');

  // Check 1: Is processIncomingPull working?
  // Look at most recent processed packet
  const processedSnap = await db.ref('packets/processed')
    .orderByChild('processedAt')
    .limitToLast(1)
    .once('value');

  let lastProcessedAge = -1;
  let lastProcessedWell = 'unknown';

  processedSnap.forEach((child) => {
    const data = child.val();
    if (data.processedAt) {
      lastProcessedAge = (now.getTime() - new Date(data.processedAt).getTime()) / (1000 * 60 * 60); // hours
      lastProcessedWell = data.wellName || 'unknown';
    }
  });

  // Check 2: Anything stuck in incoming?
  const incomingSnap = await db.ref('packets/incoming').once('value');
  const stuckCount = incomingSnap.exists() ? Object.keys(incomingSnap.val()).length : 0;

  // Check 3: How many wells have outgoing data?
  const outgoingSnap = await db.ref('packets/outgoing').once('value');
  const activeWells = outgoingSnap.exists() ? Object.keys(outgoingSnap.val()).length : 0;

  // Check 4: How many wells in new unified structure?
  const wellsSnap = await db.ref('wells').once('value');
  const unifiedWells = wellsSnap.exists() ? Object.keys(wellsSnap.val()).length : 0;

  // Determine overall status
  let status = 'ok';
  let message = 'All systems operational';

  if (stuckCount > 5) {
    status = 'warning';
    message = `${stuckCount} packets stuck in incoming queue`;
  }

  if (stuckCount > 20) {
    status = 'critical';
    message = `CRITICAL: ${stuckCount} packets stuck - processing may be down`;
  }

  // Write health status
  await db.ref('system_health/overall').set({
    lastCheck: now.toISOString(),
    status,
    message,
    metrics: {
      lastProcessedHoursAgo: Math.round(lastProcessedAge * 10) / 10,
      lastProcessedWell,
      stuckIncoming: stuckCount,
      activeWells,
      unifiedWells, // Wells in new structure
    }
  });

  console.log(`[HealthCheck] Status: ${status} - ${message}`);
});

// Well config defaults
const DEFAULTS = {
  bottomLevel: 3, // feet
  tanks: 1,
  pullBbls: 140,
};

interface PullPacket {
  packetId: string;
  wellName: string;
  tankLevelFeet: number;
  bblsTaken: number;
  dateTimeUTC: string;
  dateTime?: string;
  driverName?: string;
  driverId?: string;
  requestType: string;
  timezone?: string;
  wellDown?: boolean;
  predictedLevelInches?: number;
}

interface ProcessedPacket extends PullPacket {
  // Calculated fields
  tankTopInches: number;
  tankAfterInches: number;
  tankAfterFeet: string; // "5'11"" format
  timeDif: string; // "H:MM" format
  timeDifDays: number;
  recoveryInches: number;
  flowRate: string; // "H:MM:SS" format
  flowRateDays: number;
  recoveryNeeded: number;
  estTimeToPull: string; // "H:MM" format
  estDateTimePull: string; // ISO string
  processedAt: string;
}

interface OutgoingResponse {
  wellName: string;
  currentLevel: string;
  flowRate: string;
  bbls24hrs: string;
  timeTillPull: string;
  nextPullTime: string;
  nextPullTimeUTC: string;
  lastPullDateTime: string;
  lastPullDateTimeUTC: string;
  lastPullBbls: string;
  lastPullTopLevel: string;
  lastPullBottomLevel: string;
  wellDown: boolean;
  status: string;
  timestamp: string;
  timestampUTC: string;
  isEdit?: boolean;
  originalPacketId?: string;
  windowBblsDay?: string | null;
  overnightBblsDay?: string | null;
}

// NEW UNIFIED STRUCTURE - Single source of truth
interface WellStatus {
  wellName: string;
  config: {
    tanks: number;
    bottomLevel: number;  // feet
    route: string;
    pullBbls: number;
  };
  current: {
    level: string;        // "5'2\"" format
    levelInches: number;
    asOf: string;         // ISO timestamp
  };
  lastPull: {
    dateTime: string;     // Local display format
    dateTimeUTC: string;  // ISO timestamp
    topLevel: string;     // "6'8\"" format
    topLevelInches: number;
    bottomLevel: string;  // "5'2\"" format
    bottomLevelInches: number;
    bblsTaken: number;
    driverName?: string;
    packetId: string;
  };
  calculated: {
    flowRate: string;         // "H:MM:SS" format (AFR)
    flowRateMinutes: number;  // AFR in minutes per foot
    bbls24hrs: number;
    nextPullTime: string;     // Local display format
    nextPullTimeUTC: string;  // ISO timestamp
    timeTillPull: string;     // "H:MM" format
  };
  isDown: boolean;
  updatedAt: string;  // ISO timestamp
}

// Helper: Convert inches to feet'inches" format
function inchesToFeetInches(inches: number): string {
  const feet = Math.floor(inches / 12);
  const remainingInches = Math.floor(inches % 12);
  return `${feet}'${remainingInches}"`;
}

// Helper: Parse feet'inches" to inches
function feetInchesToInches(str: string): number {
  if (!str) return 0;
  const match = str.match(/(\d+)'(\d+)"/);
  if (match) {
    return parseInt(match[1]) * 12 + parseInt(match[2]);
  }
  return 0;
}

// Helper: Format days to H:MM
function daysToHMM(days: number): string {
  const totalMinutes = Math.floor(days * 24 * 60);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${hours}:${mins.toString().padStart(2, '0')}`;
}

// Helper: Format days to H:MM:SS
function daysToHMMSS(days: number): string {
  const totalSeconds = Math.floor(days * 24 * 60 * 60);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// ========== BBLs/Day Calculation Functions ==========
// Ported from WB Mobile functions/index.js — must stay in sync

interface HistoricalPull {
  key: string;
  timestamp: number;
  tankLevelFeet: number;
  bblsTaken: number;
  wellDown: boolean;
}

/**
 * Parse packet timestamp from dateTimeUTC or dateTime field.
 */
function parsePacketTimestamp(packet: any): number {
  if (packet.dateTimeUTC) {
    return new Date(packet.dateTimeUTC).getTime();
  }
  if (packet.dateTime) {
    const match = packet.dateTime.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+)(?::(\d+))?\s*(AM|PM)?/i);
    if (match) {
      const [, month, day, year, hours, minutes, seconds, ampm] = match;
      let h = parseInt(hours);
      if (ampm) {
        if (ampm.toUpperCase() === 'PM' && h !== 12) h += 12;
        if (ampm.toUpperCase() === 'AM' && h === 12) h = 0;
      }
      return new Date(
        parseInt(year), parseInt(month) - 1, parseInt(day),
        h, parseInt(minutes), parseInt(seconds || '0')
      ).getTime();
    }
  }
  return NaN;
}

/**
 * Get historical pulls for a well from packets/processed.
 * Filters out wellHistory requests, history_ keys, and wasEdited packets.
 */
async function getHistoricalPulls(wellName: string, limit: number = 50): Promise<HistoricalPull[]> {
  try {
    const snapshot = await db.ref('packets/processed')
      .orderByChild('wellName')
      .equalTo(wellName)
      .once('value');

    const packets = snapshot.val();
    if (!packets) return [];

    const pulls: HistoricalPull[] = [];
    for (const [key, packet] of Object.entries(packets) as [string, any][]) {
      if (packet.requestType === 'wellHistory' ||
          key.startsWith('history_') ||
          packet.wasEdited === true) {
        continue;
      }
      const ts = parsePacketTimestamp(packet);
      if (isNaN(ts)) continue;

      pulls.push({
        key,
        timestamp: ts,
        tankLevelFeet: parseFloat(packet.tankLevelFeet) || 0,
        bblsTaken: parseFloat(packet.bblsTaken) || 0,
        wellDown: packet.wellDown === true || packet.wellDown === 'true',
      });
    }

    pulls.sort((a, b) => a.timestamp - b.timestamp);
    return pulls.slice(-limit);
  } catch (error) {
    console.error(`[getHistoricalPulls] Error for ${wellName}:`, error);
    return [];
  }
}

/**
 * CST/CDT offset in milliseconds.
 * CST = UTC-6, CDT = UTC-5. DST: 2nd Sunday March → 1st Sunday November.
 */
function getCSTOffset(timestampMs: number): number {
  const date = new Date(timestampMs);
  const year = date.getUTCFullYear();
  const marchFirst = new Date(Date.UTC(year, 2, 1));
  const marchSecondSun = new Date(Date.UTC(year, 2, 8 + (7 - marchFirst.getUTCDay()) % 7, 8));
  const novFirst = new Date(Date.UTC(year, 10, 1));
  const novFirstSun = new Date(Date.UTC(year, 10, 1 + (7 - novFirst.getUTCDay()) % 7, 7));
  if (timestampMs >= marchSecondSun.getTime() && timestampMs < novFirstSun.getTime()) {
    return -5 * 60 * 60 * 1000; // CDT
  }
  return -6 * 60 * 60 * 1000; // CST
}

/**
 * Get the 6am-6am window end for a timestamp.
 * Before 6am → window ends at 6am same day. 6am or after → 6am next day.
 */
function getWindowEnd(timestampMs: number): number {
  const cstOffset = getCSTOffset(timestampMs);
  const localMs = timestampMs + cstOffset;
  const localDate = new Date(localMs);
  const hour = localDate.getUTCHours();
  const sixAmLocal = new Date(localDate);
  sixAmLocal.setUTCHours(6, 0, 0, 0);
  const sixAmUtc = sixAmLocal.getTime() - cstOffset;
  return hour < 6 ? sixAmUtc : sixAmUtc + 24 * 60 * 60 * 1000;
}

/**
 * Get the production date (yyyy-mm-dd) for a timestamp using 6am boundary.
 */
function getProductionDate(timestampMs: number): string {
  const cstOffset = getCSTOffset(timestampMs);
  const localMs = timestampMs + cstOffset;
  const d = new Date(localMs);
  if (d.getUTCHours() < 6) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Window-averaged bbls/day.
 * Groups flow rates by 6am-6am window, averages current window (falls back to previous).
 */
function calculateWindowBblsPerDay(historicalPulls: HistoricalPull[], bblPerFoot: number, pullTimestamp: number): number {
  if (!historicalPulls || historicalPulls.length < 2) return 0;

  const currentWindowEnd = getWindowEnd(pullTimestamp);
  const windowFlowRates = new Map<number, number[]>();

  for (let i = 1; i < historicalPulls.length; i++) {
    const current = historicalPulls[i];
    const previous = historicalPulls[i - 1];
    if (current.wellDown || previous.wellDown) continue;

    const timeDifDays = (current.timestamp - previous.timestamp) / (1000 * 60 * 60 * 24);
    if (timeDifDays <= 0) continue;

    const prevBottomFeet = Math.max(previous.tankLevelFeet - (previous.bblsTaken / bblPerFoot), 0);
    const recoveryFeet = current.tankLevelFeet - prevBottomFeet;
    if (recoveryFeet <= 0) continue;

    const flowRateDays = timeDifDays / recoveryFeet;
    if (flowRateDays <= 0 || flowRateDays >= 365) continue;

    const windowEnd = getWindowEnd(current.timestamp);
    const existing = windowFlowRates.get(windowEnd) || [];
    existing.push(flowRateDays);
    windowFlowRates.set(windowEnd, existing);
  }

  let flowRates = windowFlowRates.get(currentWindowEnd);
  if (!flowRates || flowRates.length === 0) {
    const prevWindowEnd = currentWindowEnd - 24 * 60 * 60 * 1000;
    flowRates = windowFlowRates.get(prevWindowEnd);
  }
  if (!flowRates || flowRates.length === 0) return 0;

  const avgFlowRateDays = flowRates.reduce((a, b) => a + b, 0) / flowRates.length;
  if (avgFlowRateDays <= 0) return 0;

  return Math.round((1 / avgFlowRateDays) * bblPerFoot);
}

/**
 * Overnight/longest-gap bbls/day.
 * Finds the longest time gap between pulls in the current 6am window.
 */
function calculateOvernightBblsPerDay(historicalPulls: HistoricalPull[], bblPerFoot: number, pullTimestamp: number): number {
  if (!historicalPulls || historicalPulls.length < 2) return 0;

  // Driver's manual method: most recent pull from any previous day → first pull today.
  const todayDate = new Date(pullTimestamp).toISOString().slice(0, 10);

  let firstPullToday: HistoricalPull | null = null;
  let lastPullPrevDay: HistoricalPull | null = null;

  // Pulls are chronological (oldest first). Walk backwards.
  for (let i = historicalPulls.length - 1; i >= 0; i--) {
    const pull = historicalPulls[i];
    const pullDate = new Date(pull.timestamp).toISOString().slice(0, 10);

    if (pullDate === todayDate) {
      firstPullToday = pull; // Keeps overwriting — last one standing is earliest today
    } else {
      lastPullPrevDay = pull; // Most recent pull from a previous day
      break;
    }
  }

  if (!firstPullToday || !lastPullPrevDay) return 0;
  if (firstPullToday.wellDown || lastPullPrevDay.wellDown) return 0;

  const timeDifDays = (firstPullToday.timestamp - lastPullPrevDay.timestamp) / (1000 * 60 * 60 * 24);
  if (timeDifDays <= 0) return 0;

  const prevBottomFeet = Math.max(lastPullPrevDay.tankLevelFeet - (lastPullPrevDay.bblsTaken / bblPerFoot), 0);
  const recoveryFeet = firstPullToday.tankLevelFeet - prevBottomFeet;
  if (recoveryFeet <= 0) return 0;

  const flowRateDays = timeDifDays / recoveryFeet;
  return Math.round((1 / flowRateDays) * bblPerFoot);
}

/**
 * Write daily production log to Firebase.
 * Stores AFR, window-averaged, and overnight bbls/day for comparison.
 */
async function writeProductionLog(
  wellName: string, pullTimestamp: number,
  afrBblsDay: number, windowBblsDay: number, overnightBblsDay: number
): Promise<void> {
  try {
    const wellKey = wellName.replace(/\s+/g, '_');
    const prodDate = getProductionDate(pullTimestamp);
    const ref = db.ref(`production/${wellKey}/${prodDate}`);
    const current = (await ref.once('value')).val();
    const pullCount = (current?.n || 0) + 1;

    await ref.set({
      a: afrBblsDay || 0,
      w: windowBblsDay || 0,
      o: overnightBblsDay || 0,
      u: new Date().toISOString(),
      n: pullCount,
    });
    await db.ref(`production/${wellKey}/wellName`).set(wellName);
    console.log(`[Production] ${wellName} ${prodDate}: afr=${afrBblsDay} window=${windowBblsDay} overnight=${overnightBblsDay} pulls=${pullCount}`);
  } catch (error) {
    console.error(`[Production] Error writing log for ${wellName}:`, error);
  }
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
function getFlowRateAnomalyLevel(flowRate: number, medianRate: number): number {
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

// Filter out anomalies from flow rates using PROGRESSIVE median-based detection
// Each rate is checked against median of rates BEFORE it (chronologically)
// Returns flow rates with 5x+ outliers removed (Tier 2 anomalies excluded)
function filterAnomalies(flowRates: number[]): number[] {
  if (flowRates.length < 3) {
    return flowRates;
  }

  // flowRates are in chronological order (oldest first from Firebase query)
  // Build up known rates progressively and filter anomalies
  const knownRates: number[] = [];
  const filtered: number[] = [];

  for (const rate of flowRates) {
    if (knownRates.length >= 3) {
      const medianRate = median(knownRates);
      const level = getFlowRateAnomalyLevel(rate, medianRate);

      if (level < 2) {
        // Not an anomaly - include in filtered and add to known
        filtered.push(rate);
        knownRates.push(rate);
      }
      // Level 2 anomalies are excluded from both filtered AND knownRates
    } else {
      // Not enough data yet to detect anomalies - include everything
      filtered.push(rate);
      knownRates.push(rate);
    }
  }

  if (filtered.length < 3) {
    return flowRates; // Fallback if too many filtered
  }

  return filtered;
}

// Calculate AFR from recent flow rates (with anomaly detection)
async function calculateAFR(wellName: string, newFlowRateDays: number): Promise<number> {

  // Get recent processed packets for this well
  const snapshot = await db.ref('packets/processed')
    .orderByChild('wellName')
    .equalTo(wellName)
    .limitToLast(15) // Get more to account for anomalies being filtered
    .once('value');

  const allRates: number[] = [];

  snapshot.forEach((child) => {
    const data = child.val();
    if (data.flowRateDays && data.flowRateDays > 0) {
      allRates.push(data.flowRateDays);
    }
  });

  // Add the new rate
  if (newFlowRateDays > 0) {
    allRates.push(newFlowRateDays);
  }

  if (allRates.length === 0) return 0;
  if (allRates.length < 3) return allRates[allRates.length - 1];

  // Filter out anomalies (5x off median) before calculating AFR
  const rates = filterAnomalies(allRates);

  if (rates.length === 0) return allRates[allRates.length - 1]; // Fallback to newest
  if (rates.length < 3) return rates[rates.length - 1];

  // Step detection: Check if last 3 are ALL >10% off in same direction
  const STEP_THRESHOLD = 0.10;
  if (rates.length >= 5) {
    const preStepRates = rates.slice(0, -3);
    const recentRates = rates.slice(-3);
    const preStepAvg = preStepRates.reduce((a, b) => a + b, 0) / preStepRates.length;

    let allHigher = true;
    let allLower = true;

    for (const rate of recentRates) {
      const deviation = (rate - preStepAvg) / preStepAvg;
      if (deviation <= STEP_THRESHOLD) allHigher = false;
      if (deviation >= -STEP_THRESHOLD) allLower = false;
    }

    if (allHigher || allLower) {
      // Step detected - use median of last 3
      const sorted = [...recentRates].sort((a, b) => a - b);
      return sorted[1];
    }
  }

  // Use 5-pull rolling average (or all if less than 5)
  const windowSize = Math.min(5, rates.length);
  const recentRates = rates.slice(-windowSize);
  return recentRates.reduce((a, b) => a + b, 0) / recentRates.length;
}

// Main function: Process incoming pull packets
export const processIncomingPull = functionsV1.database
  .ref('packets/incoming/{packetId}')
  .onCreate(async (snapshot, context) => {
    const packetId = context.params.packetId;
    const data = snapshot.val() as PullPacket;

    // Skip non-pull requests (delete, edit handled separately)
    // Treat missing requestType as 'pull' — WB M app historically didn't set it on pull packets
    const reqType = data.requestType || 'pull';
    if (reqType !== 'pull') {
      return null;
    }

    const wellName = data.wellName;
    const cleanName = wellName.replace(/\s/g, '');

    console.log(`Processing pull for ${wellName}: ${packetId}`);

    // Get well config - try with spaces first (dashboard format), fall back to no spaces (legacy)
    let configSnap = await db.ref(`well_config/${wellName}`).once('value');
    if (!configSnap.exists()) {
      // Try legacy format without spaces
      configSnap = await db.ref(`well_config/${cleanName}`).once('value');
    }
    const config = configSnap.val() || {};
    const bottomInches = (config.bottomLevel || config.allowedBottom || DEFAULTS.bottomLevel) * 12;
    const tanks = config.tanks || config.numTanks || DEFAULTS.tanks;
    const pullBbls = config.pullBbls || DEFAULTS.pullBbls;

    // Get current outgoing response (previous row data)
    const outgoingSnap = await db.ref('packets/outgoing')
      .orderByChild('wellName')
      .equalTo(wellName)
      .limitToLast(1)
      .once('value');

    let prevTankAfterInches = 0;
    let prevTimestamp = '';
    let prevResponse: any = null;

    outgoingSnap.forEach((child) => {
      const prev = child.val();
      prevTankAfterInches = feetInchesToInches(prev.lastPullBottomLevel);
      prevTimestamp = prev.lastPullDateTimeUTC;
      prevResponse = prev;
    });

    // Calculate all fields
    const tankTopInches = data.tankLevelFeet * 12;
    const bblsInInches = data.bblsTaken > 0 ? (data.bblsTaken / 20 / tanks) * 12 : 0;
    const tankAfterInches = tankTopInches - bblsInInches;

    // Time Dif
    let timeDifDays = 0;
    let timeDif = '';
    if (prevTimestamp) {
      const currentDT = new Date(data.dateTimeUTC).getTime();
      const prevDT = new Date(prevTimestamp).getTime();
      if (!isNaN(currentDT) && !isNaN(prevDT) && currentDT > prevDT) {
        timeDifDays = (currentDT - prevDT) / (1000 * 60 * 60 * 24);
        timeDif = daysToHMM(timeDifDays);
      }
    }

    // Recovery Inches
    let recoveryInches = 0;
    if (prevTankAfterInches > 0) {
      recoveryInches = Math.max(0, tankTopInches - prevTankAfterInches);
    }

    // Flow Rate (days per foot)
    let flowRateDays = 0;
    let flowRate = '';
    if (recoveryInches > 0 && timeDifDays > 0) {
      flowRateDays = (timeDifDays / recoveryInches) * 12;
      flowRate = daysToHMMSS(flowRateDays);
    }

    // Calculate AFR
    const afr = await calculateAFR(wellName, flowRateDays);

    // Calculate window-averaged and overnight bbls/day
    const bblPerFoot = tanks * 20;
    const historicalPulls = await getHistoricalPulls(wellName, 500);
    const pullTimeMs = new Date(data.dateTimeUTC).getTime();
    const windowBblsDay = calculateWindowBblsPerDay(historicalPulls, bblPerFoot, pullTimeMs);
    const overnightBblsDay = calculateOvernightBblsPerDay(historicalPulls, bblPerFoot, pullTimeMs);
    console.log(`[BblsDay] ${wellName}: window=${windowBblsDay} overnight=${overnightBblsDay}`);

    // Recovery Needed
    const pullHeightInches = (pullBbls / 20 / tanks) * 12;
    const targetLevel = bottomInches + pullHeightInches;
    const recoveryNeeded = Math.max(0, targetLevel - tankAfterInches);

    // Est Time to Pull
    let estTimeToPull = '';
    let estDateTimePull = '';
    if (afr > 0 && recoveryNeeded > 0) {
      const estDays = (recoveryNeeded / 12) * afr;
      estTimeToPull = daysToHMM(estDays);
      const pullDate = new Date(data.dateTimeUTC);
      const estDate = new Date(pullDate.getTime() + estDays * 24 * 60 * 60 * 1000);
      estDateTimePull = estDate.toISOString();
    } else if (recoveryNeeded === 0) {
      estTimeToPull = '0:00';
      estDateTimePull = data.dateTimeUTC;
    }

    // Build processed packet with all calculated fields
    const processedPacket: ProcessedPacket = {
      ...data,
      packetId,
      tankTopInches,
      tankAfterInches,
      tankAfterFeet: inchesToFeetInches(tankAfterInches),
      timeDif,
      timeDifDays,
      recoveryInches,
      flowRate,
      flowRateDays,
      recoveryNeeded,
      estTimeToPull,
      estDateTimePull,
      processedAt: new Date().toISOString(),
    };

    // Write to processed/
    await db.ref(`packets/processed/${packetId}`).set(processedPacket);

    // Calculate current level (for outgoing response)
    // At time of pull, current level = tank after
    // This will be updated by a scheduled function to reflect growth over time
    const currentLevelInches = tankAfterInches;

    // BBLs per 24 hours
    let bbls24hrs = '0';
    if (afr > 0) {
      const bbls24 = (1 / afr) * 20 * tanks;
      bbls24hrs = Math.round(bbls24).toString();
    }

    // Build outgoing response
    const timestamp = new Date();
    const outgoingResponse: OutgoingResponse = {
      wellName,
      currentLevel: inchesToFeetInches(currentLevelInches),
      flowRate: afr > 0 ? daysToHMMSS(afr) : 'Unknown',
      bbls24hrs,
      timeTillPull: data.wellDown ? 'Down' : (estTimeToPull || 'Calculating...'),
      nextPullTime: estDateTimePull ? new Date(estDateTimePull).toLocaleString() : 'Unknown',
      nextPullTimeUTC: estDateTimePull,
      lastPullDateTime: data.dateTime || new Date(data.dateTimeUTC).toLocaleString(),
      lastPullDateTimeUTC: data.dateTimeUTC,
      lastPullBbls: data.bblsTaken.toString(),
      lastPullTopLevel: inchesToFeetInches(tankTopInches),
      lastPullBottomLevel: inchesToFeetInches(tankAfterInches),
      wellDown: data.wellDown || false,
      status: 'success',
      timestamp: timestamp.toISOString(),
      timestampUTC: timestamp.toISOString(),
      windowBblsDay: windowBblsDay > 0 ? windowBblsDay.toString() : null,
      overnightBblsDay: overnightBblsDay > 0 ? overnightBblsDay.toString() : null,
    };

    // Write to outgoing/ (delete old responses for this well first)
    const oldResponses = await db.ref('packets/outgoing')
      .orderByChild('wellName')
      .equalTo(wellName)
      .once('value');

    const deletePromises: Promise<void>[] = [];
    oldResponses.forEach((child) => {
      deletePromises.push(child.ref.remove());
    });
    await Promise.all(deletePromises);

    // Write new response
    const responseId = `response_${timestamp.toISOString().replace(/[-:]/g, '').replace('T', '_').split('.')[0]}_${cleanName}`;
    await db.ref(`packets/outgoing/${responseId}`).set(outgoingResponse);

    // Write performance data for Performance screen
    // Format: performance/{wellKey}/rows/{timestamp} = { d, a, p }
    try {
      const pullTime = new Date(data.dateTimeUTC);
      const perfTimestamp = `${pullTime.getFullYear()}${String(pullTime.getMonth() + 1).padStart(2, '0')}${String(pullTime.getDate()).padStart(2, '0')}_${String(pullTime.getHours()).padStart(2, '0')}${String(pullTime.getMinutes()).padStart(2, '0')}${String(pullTime.getSeconds()).padStart(2, '0')}`;
      const perfDateStr = `${pullTime.getFullYear()}-${String(pullTime.getMonth() + 1).padStart(2, '0')}-${String(pullTime.getDate()).padStart(2, '0')}`;
      const wellKey = wellName.replace(/\s+/g, '_');
      const actualInches = Math.floor(data.tankLevelFeet * 12);

      // Best: use predictedLevelInches from packet (what driver saw on screen)
      let predictedInches: number | undefined;
      if (data.predictedLevelInches !== undefined && data.predictedLevelInches !== null) {
        predictedInches = Math.floor(Number(data.predictedLevelInches));
      } else if (prevResponse && prevResponse.currentLevel && prevResponse.flowRate && prevResponse.flowRate !== 'Unknown') {
        // Fallback: calculate from previous response (what driver was looking at)
        const levelMatch = prevResponse.currentLevel.match(/(\d+)'(\d+)"/);
        const flowMatch = prevResponse.flowRate.match(/^(\d+):(\d{2}):(\d{2})$/);
        if (levelMatch && flowMatch) {
          const prevBottomFeet = parseInt(levelMatch[1]) + parseInt(levelMatch[2]) / 12;
          const afrDays = (parseInt(flowMatch[1]) + parseInt(flowMatch[2]) / 60 + parseInt(flowMatch[3]) / 3600) / 24;
          const prevTime = new Date(prevResponse.timestampUTC || prevResponse.timestamp).getTime();
          const timeDiffDays = (pullTime.getTime() - prevTime) / (1000 * 60 * 60 * 24);
          if (afrDays > 0 && timeDiffDays > 0) {
            const growthFeet = timeDiffDays / afrDays;
            predictedInches = Math.floor((prevBottomFeet + growthFeet) * 12);
          }
        }
      }

      if (predictedInches === undefined) {
        predictedInches = actualInches;
      }

      await db.ref(`performance/${wellKey}/rows/${perfTimestamp}`).set({
        d: perfDateStr,
        a: actualInches,
        p: predictedInches,
      });
      await db.ref(`performance/${wellKey}/wellName`).set(wellName);
      await db.ref(`performance/${wellKey}/updated`).set(new Date().toISOString());
      console.log(`[Performance] ${wellName}: a=${actualInches} p=${predictedInches}`);
    } catch (perfError) {
      console.error(`[Performance] Error writing data for ${wellName}:`, perfError);
    }

    // Update well_config with calculated AFR so app stays in sync
    // This is the SINGLE SOURCE OF TRUTH for flow rate
    if (afr > 0) {
      const afrMinutes = afr * 24 * 60; // Convert days to minutes
      await db.ref(`well_config/${wellName}`).update({
        avgFlowRate: daysToHMMSS(afr),
        avgFlowRateMinutes: Math.round(afrMinutes * 100) / 100, // Round to 2 decimal places
      });
      console.log(`Updated well_config/${wellName} avgFlowRate: ${daysToHMMSS(afr)} (${afrMinutes.toFixed(2)} min)`);
    }

    // ============================================================
    // NEW UNIFIED STRUCTURE - Write to wells/{name}/status + history
    // This is THE single source of truth going forward
    // ============================================================
    const afrMinutes = afr > 0 ? afr * 24 * 60 : 0;

    const wellStatus: WellStatus = {
      wellName,
      config: {
        tanks,
        bottomLevel: bottomInches / 12, // Convert back to feet
        route: config.route || 'Unassigned',
        pullBbls,
      },
      current: {
        level: inchesToFeetInches(currentLevelInches),
        levelInches: currentLevelInches,
        asOf: new Date().toISOString(),
      },
      lastPull: {
        dateTime: data.dateTime || new Date(data.dateTimeUTC).toLocaleString(),
        dateTimeUTC: data.dateTimeUTC,
        topLevel: inchesToFeetInches(tankTopInches),
        topLevelInches: tankTopInches,
        bottomLevel: inchesToFeetInches(tankAfterInches),
        bottomLevelInches: tankAfterInches,
        bblsTaken: data.bblsTaken,
        driverName: data.driverName,
        packetId,
      },
      calculated: {
        flowRate: afr > 0 ? daysToHMMSS(afr) : 'Unknown',
        flowRateMinutes: Math.round(afrMinutes * 100) / 100,
        bbls24hrs: parseInt(bbls24hrs) || 0,
        nextPullTime: estDateTimePull ? new Date(estDateTimePull).toLocaleString() : 'Unknown',
        nextPullTimeUTC: estDateTimePull || '',
        timeTillPull: data.wellDown ? 'Down' : (estTimeToPull || 'Calculating...'),
      },
      isDown: data.wellDown || false,
      updatedAt: new Date().toISOString(),
    };

    // Write to wells/{wellName}/status (THE source of truth)
    await db.ref(`wells/${wellName}/status`).set(wellStatus);

    console.log(`[NEW] Wrote wells/${wellName}/status`);

    // Write production log (AFR + window + overnight bbls/day for comparison)
    const afrBblsDay = afr > 0 ? Math.round((1 / afr) * bblPerFoot) : 0;
    await writeProductionLog(wellName, pullTimeMs, afrBblsDay, windowBblsDay, overnightBblsDay);

    // Delete from incoming/
    await snapshot.ref.remove();

    console.log(`Processed ${wellName}: ${packetId} -> ${responseId}`);

    return null;
  });

// Handle edit requests — updates processed packet and recalculates dependent fields
export const processEditRequest = functionsV1.database
  .ref('packets/incoming/{packetId}')
  .onCreate(async (snapshot, context) => {
    const data = snapshot.val();

    if (data.requestType !== 'edit') {
      return null;
    }

    const originalPacketId = data.originalPacketId;
    const wellName = data.wellName;

    console.log(`Processing edit for ${wellName}: ${originalPacketId}`);

    // Read the original processed packet
    const origSnap = await db.ref(`packets/processed/${originalPacketId}`).once('value');
    if (!origSnap.exists()) {
      console.error(`Edit failed: packet ${originalPacketId} not found in processed/`);
      await snapshot.ref.remove();
      return null;
    }
    const origPacket = origSnap.val();

    // Get well config
    const cleanName = wellName.replace(/\s/g, '');
    let configSnap = await db.ref(`well_config/${wellName}`).once('value');
    if (!configSnap.exists()) {
      configSnap = await db.ref(`well_config/${cleanName}`).once('value');
    }
    const config = configSnap.val() || {};
    const tanks = config.tanks || config.numTanks || DEFAULTS.tanks;
    const pullBbls = config.pullBbls || DEFAULTS.pullBbls;
    const bottomInches = (config.bottomLevel || config.allowedBottom || DEFAULTS.bottomLevel) * 12;

    // Apply edits — accept from dashboard (tankTopInches) or WB M (tankLevelFeet)
    let newTankTopInches = origPacket.tankTopInches;
    if (data.tankTopInches !== undefined) {
      newTankTopInches = data.tankTopInches; // Dashboard sends inches
    } else if (data.tankLevelFeet !== undefined) {
      newTankTopInches = data.tankLevelFeet * 12; // WB M sends feet
    }
    const newBblsTaken = data.bblsTaken !== undefined ? data.bblsTaken : origPacket.bblsTaken;

    // Apply date/time edit if present
    const newDateTimeUTC = data.dateTimeUTC || origPacket.dateTimeUTC;
    const newDateTime = data.dateTime || origPacket.dateTime;

    // Recalculate tankAfter
    const bblsInInches = newBblsTaken > 0 ? (newBblsTaken / 20 / tanks) * 12 : 0;
    const newTankAfterInches = newTankTopInches - bblsInInches;

    // Get the previous pull's data for timeDif/recovery/flowRate recalc
    const prevOutgoingSnap = await db.ref('packets/processed')
      .orderByChild('wellName')
      .equalTo(wellName)
      .once('value');

    // Find the pull immediately before the edited one (by timestamp)
    const editedTime = new Date(newDateTimeUTC).getTime();
    let prevTankAfterInches = 0;
    let prevTimestamp = '';

    prevOutgoingSnap.forEach((child) => {
      if (child.key === originalPacketId) return; // Skip self
      const pkt = child.val();
      const pktTime = new Date(pkt.dateTimeUTC).getTime();
      if (pktTime < editedTime) {
        // This is a candidate for "previous pull"
        if (!prevTimestamp || pktTime > new Date(prevTimestamp).getTime()) {
          prevTankAfterInches = pkt.tankAfterInches || 0;
          prevTimestamp = pkt.dateTimeUTC;
        }
      }
    });

    // Recalculate timeDif, recovery, flowRate
    let timeDifDays = origPacket.timeDifDays || 0;
    let timeDif = origPacket.timeDif || '';
    let recoveryInches = 0;
    let flowRateDays = 0;
    let flowRate = '';

    if (prevTimestamp) {
      const currentDT = new Date(newDateTimeUTC).getTime();
      const prevDT = new Date(prevTimestamp).getTime();
      if (!isNaN(currentDT) && !isNaN(prevDT) && currentDT > prevDT) {
        timeDifDays = (currentDT - prevDT) / (1000 * 60 * 60 * 24);
        timeDif = daysToHMM(timeDifDays);
      }
    }

    if (prevTankAfterInches > 0) {
      recoveryInches = Math.max(0, newTankTopInches - prevTankAfterInches);
    }

    if (recoveryInches > 0 && timeDifDays > 0) {
      flowRateDays = (timeDifDays / recoveryInches) * 12;
      flowRate = daysToHMMSS(flowRateDays);
    }

    // Update the processed packet with new values
    const updates: { [key: string]: any } = {
      tankTopInches: newTankTopInches,
      tankLevelFeet: newTankTopInches / 12,
      bblsTaken: newBblsTaken,
      tankAfterInches: newTankAfterInches,
      tankAfterFeet: inchesToFeetInches(newTankAfterInches),
      recoveryInches,
      flowRateDays,
      flowRate,
      timeDif,
      timeDifDays,
      dateTimeUTC: newDateTimeUTC,
      dateTime: newDateTime,
      editedAt: new Date().toISOString(),
      editedBy: data.source || 'dashboard',
    };

    await db.ref(`packets/processed/${originalPacketId}`).update(updates);

    // Recalculate AFR and update outgoing response if this was the most recent pull
    const afr = await calculateAFR(wellName, flowRateDays);

    // Recalculate window/overnight bbls/day (edit may have changed flow rates)
    const editBblPerFoot = tanks * 20;
    const editHistoricalPulls = await getHistoricalPulls(wellName, 500);
    const editPullTimeMs = new Date(origPacket.dateTimeUTC).getTime();
    const editWindowBblsDay = calculateWindowBblsPerDay(editHistoricalPulls, editBblPerFoot, editPullTimeMs);
    const editOvernightBblsDay = calculateOvernightBblsPerDay(editHistoricalPulls, editBblPerFoot, editPullTimeMs);

    // Check if this is the most recent pull for the well
    const outgoingSnap = await db.ref('packets/outgoing')
      .orderByChild('wellName')
      .equalTo(wellName)
      .limitToLast(1)
      .once('value');

    let isLatestPull = false;
    let hasOutgoing = false;
    outgoingSnap.forEach((child) => {
      hasOutgoing = true;
      const resp = child.val();
      // If the outgoing response points to this packet's timestamp, it's the latest
      // Check both original and new dateTimeUTC in case date was edited
      if (resp.lastPullDateTimeUTC === origPacket.dateTimeUTC || resp.lastPullDateTimeUTC === newDateTimeUTC) {
        isLatestPull = true;
      }
    });

    // If no outgoing response exists for this well at all, treat as latest
    // (fixes wells that never got an outgoing response due to requestType bug)
    if (!hasOutgoing) {
      isLatestPull = true;
    }

    if (isLatestPull && afr > 0) {
      // Recalculate outgoing response fields
      const pullHeightInches = (pullBbls / 20 / tanks) * 12;
      const targetLevel = bottomInches + pullHeightInches;
      const recoveryNeeded = Math.max(0, targetLevel - newTankAfterInches);

      let estTimeToPull = '';
      let estDateTimePull = '';
      if (recoveryNeeded > 0) {
        const estDays = (recoveryNeeded / 12) * afr;
        estTimeToPull = daysToHMM(estDays);
        const pullDate = new Date(newDateTimeUTC);
        const estDate = new Date(pullDate.getTime() + estDays * 24 * 60 * 60 * 1000);
        estDateTimePull = estDate.toISOString();
      } else {
        estTimeToPull = '0:00';
        estDateTimePull = newDateTimeUTC;
      }

      const bbls24 = (1 / afr) * 20 * tanks;
      const bbls24hrs = Math.round(bbls24).toString();

      if (hasOutgoing) {
        // Update existing outgoing response
        outgoingSnap.forEach((child) => {
          child.ref.update({
            currentLevel: inchesToFeetInches(newTankAfterInches),
            flowRate: daysToHMMSS(afr),
            bbls24hrs,
            lastPullTopLevel: inchesToFeetInches(newTankTopInches),
            lastPullBottomLevel: inchesToFeetInches(newTankAfterInches),
            lastPullBbls: newBblsTaken.toString(),
            lastPullDateTime: newDateTime || new Date(newDateTimeUTC).toLocaleString(),
            lastPullDateTimeUTC: newDateTimeUTC,
            timeTillPull: origPacket.wellDown ? 'Down' : (estTimeToPull || 'Calculating...'),
            nextPullTime: estDateTimePull ? new Date(estDateTimePull).toLocaleString() : 'Unknown',
            nextPullTimeUTC: estDateTimePull,
            isEdit: true,
            originalPacketId,
            windowBblsDay: editWindowBblsDay > 0 ? editWindowBblsDay.toString() : null,
            overnightBblsDay: editOvernightBblsDay > 0 ? editOvernightBblsDay.toString() : null,
          });
        });
      } else {
        // No outgoing response exists — create one
        const responseTimestamp = new Date();
        const responseId = `response_${responseTimestamp.toISOString().replace(/[-:]/g, '').replace('T', '_').split('.')[0]}_${cleanName}`;
        await db.ref(`packets/outgoing/${responseId}`).set({
          wellName,
          currentLevel: inchesToFeetInches(newTankAfterInches),
          flowRate: daysToHMMSS(afr),
          bbls24hrs,
          lastPullTopLevel: inchesToFeetInches(newTankTopInches),
          lastPullBottomLevel: inchesToFeetInches(newTankAfterInches),
          lastPullBbls: newBblsTaken.toString(),
          lastPullDateTime: newDateTime || new Date(newDateTimeUTC).toLocaleString(),
          lastPullDateTimeUTC: newDateTimeUTC,
          timeTillPull: origPacket.wellDown ? 'Down' : (estTimeToPull || 'Calculating...'),
          nextPullTime: estDateTimePull ? new Date(estDateTimePull).toLocaleString() : 'Unknown',
          nextPullTimeUTC: estDateTimePull,
          wellDown: origPacket.wellDown || false,
          status: 'success',
          timestamp: responseTimestamp.toISOString(),
          timestampUTC: responseTimestamp.toISOString(),
          isEdit: true,
          originalPacketId,
          windowBblsDay: editWindowBblsDay > 0 ? editWindowBblsDay.toString() : null,
          overnightBblsDay: editOvernightBblsDay > 0 ? editOvernightBblsDay.toString() : null,
        });
        console.log(`Edit: Created new outgoing response for ${wellName} (none existed)`);
      }

      // Update well_config AFR
      const afrMinutes = afr * 24 * 60;
      await db.ref(`well_config/${wellName}`).update({
        avgFlowRate: daysToHMMSS(afr),
        avgFlowRateMinutes: Math.round(afrMinutes * 100) / 100,
      });

      console.log(`Edit: Updated outgoing + AFR for ${wellName}`);
    }

    // Delete the edit request
    await snapshot.ref.remove();

    console.log(`Edit complete for ${wellName}: ${originalPacketId}`);
    return null;
  });

// Handle delete requests — removes from processed and recalculates outgoing from remaining data
export const processDeleteRequest = functionsV1.database
  .ref('packets/incoming/{packetId}')
  .onCreate(async (snapshot, context) => {
    const data = snapshot.val();

    if (data.requestType !== 'delete') {
      return null;
    }

    const targetPacketId = data.packetId;
    const wellName = data.wellName;

    console.log(`Processing delete for ${wellName}: ${targetPacketId}`);

    // Read the packet before deleting (to check if it was the latest)
    const targetSnap = await db.ref(`packets/processed/${targetPacketId}`).once('value');
    const deletedPacket = targetSnap.exists() ? targetSnap.val() : null;

    // Delete from processed
    await db.ref(`packets/processed/${targetPacketId}`).remove();

    // If the deleted packet was the latest pull, recalculate outgoing from the new latest
    if (deletedPacket) {
      const cleanName = wellName.replace(/\s/g, '');

      // Get well config
      let configSnap = await db.ref(`well_config/${wellName}`).once('value');
      if (!configSnap.exists()) {
        configSnap = await db.ref(`well_config/${cleanName}`).once('value');
      }
      const config = configSnap.val() || {};
      const tanks = config.tanks || config.numTanks || DEFAULTS.tanks;
      const pullBbls = config.pullBbls || DEFAULTS.pullBbls;
      const bottomInches = (config.bottomLevel || config.allowedBottom || DEFAULTS.bottomLevel) * 12;

      // Find the new latest pull for this well
      const remainingSnap = await db.ref('packets/processed')
        .orderByChild('wellName')
        .equalTo(wellName)
        .once('value');

      let latestPacket: any = null;
      let latestTime = 0;

      remainingSnap.forEach((child) => {
        const pkt = child.val();
        const pktTime = new Date(pkt.dateTimeUTC).getTime();
        if (pktTime > latestTime) {
          latestTime = pktTime;
          latestPacket = pkt;
        }
      });

      if (latestPacket) {
        // Recalculate AFR from remaining packets
        const afr = await calculateAFR(wellName, latestPacket.flowRateDays || 0);

        const tankAfterInches = latestPacket.tankAfterInches || 0;
        const pullHeightInches = (pullBbls / 20 / tanks) * 12;
        const targetLevel = bottomInches + pullHeightInches;
        const recoveryNeeded = Math.max(0, targetLevel - tankAfterInches);

        let estTimeToPull = '';
        let estDateTimePull = '';
        if (afr > 0 && recoveryNeeded > 0) {
          const estDays = (recoveryNeeded / 12) * afr;
          estTimeToPull = daysToHMM(estDays);
          const pullDate = new Date(latestPacket.dateTimeUTC);
          const estDate = new Date(pullDate.getTime() + estDays * 24 * 60 * 60 * 1000);
          estDateTimePull = estDate.toISOString();
        } else if (recoveryNeeded === 0) {
          estTimeToPull = '0:00';
          estDateTimePull = latestPacket.dateTimeUTC;
        }

        const bbls24 = afr > 0 ? (1 / afr) * 20 * tanks : 0;
        const bbls24hrs = Math.round(bbls24).toString();

        // Delete old outgoing responses for this well and write new one
        const oldResponses = await db.ref('packets/outgoing')
          .orderByChild('wellName')
          .equalTo(wellName)
          .once('value');

        const deletePromises: Promise<void>[] = [];
        oldResponses.forEach((child) => {
          deletePromises.push(child.ref.remove());
        });
        await Promise.all(deletePromises);

        const timestamp = new Date();
        const responseId = `response_${timestamp.toISOString().replace(/[-:]/g, '').replace('T', '_').split('.')[0]}_${cleanName}`;

        await db.ref(`packets/outgoing/${responseId}`).set({
          wellName,
          currentLevel: inchesToFeetInches(tankAfterInches),
          flowRate: afr > 0 ? daysToHMMSS(afr) : 'Unknown',
          bbls24hrs,
          timeTillPull: latestPacket.wellDown ? 'Down' : (estTimeToPull || 'Calculating...'),
          nextPullTime: estDateTimePull ? new Date(estDateTimePull).toLocaleString() : 'Unknown',
          nextPullTimeUTC: estDateTimePull,
          lastPullDateTime: latestPacket.dateTime || new Date(latestPacket.dateTimeUTC).toLocaleString(),
          lastPullDateTimeUTC: latestPacket.dateTimeUTC,
          lastPullBbls: latestPacket.bblsTaken.toString(),
          lastPullTopLevel: inchesToFeetInches(latestPacket.tankTopInches),
          lastPullBottomLevel: inchesToFeetInches(tankAfterInches),
          wellDown: latestPacket.wellDown || false,
          status: 'success',
          timestamp: timestamp.toISOString(),
          timestampUTC: timestamp.toISOString(),
        });

        // Update well_config AFR
        if (afr > 0) {
          const afrMinutes = afr * 24 * 60;
          await db.ref(`well_config/${wellName}`).update({
            avgFlowRate: daysToHMMSS(afr),
            avgFlowRateMinutes: Math.round(afrMinutes * 100) / 100,
          });
        }

        console.log(`Delete: Rebuilt outgoing for ${wellName} from remaining data`);
      } else {
        // No remaining pulls — remove outgoing response entirely
        const oldResponses = await db.ref('packets/outgoing')
          .orderByChild('wellName')
          .equalTo(wellName)
          .once('value');

        const deletePromises: Promise<void>[] = [];
        oldResponses.forEach((child) => {
          deletePromises.push(child.ref.remove());
        });
        await Promise.all(deletePromises);

        console.log(`Delete: No remaining pulls for ${wellName}, cleared outgoing`);
      }
    }

    // Delete the delete request
    await snapshot.ref.remove();

    console.log(`Delete complete for ${wellName}: ${targetPacketId}`);
    return null;
  });
