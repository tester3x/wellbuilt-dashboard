import * as functionsV1 from 'firebase-functions/v1';
import * as functionsV2 from 'firebase-functions/v2/scheduler';
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import Anthropic from '@anthropic-ai/sdk';

admin.initializeApp();
const db = admin.database();

// Format a Date to "MM/DD/YYYY H:MM AM/PM" (no comma — matches WB M/WB T format)
// Node's toLocaleString() produces "M/D/YYYY, H:MM:SS AM/PM" which Hermes can't parse
function formatLocalDateTime(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const year = d.getFullYear();
  let hours = d.getHours();
  const mins = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${month}/${day}/${year} ${hours}:${mins} ${ampm}`;
}

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

  console.log(`[Watchdog] Found ${strandedPackets.length} stranded packets - checking`);

  let retriggeredCount = 0;
  let alreadyProcessedCount = 0;

  // Delete and re-write each stranded packet to re-trigger onCreate
  for (const packet of strandedPackets) {
    const { key, data } = packet;

    // Skip edit and delete packets — they are handled by their own Cloud Functions
    // and should never be retriggered by the watchdog (causes ghost duplicate entries)
    if (data.requestType === 'edit' || data.requestType === 'delete') {
      console.log(`[Watchdog] ${data.wellName}: skipping ${data.requestType} packet (${key}), removing`);
      await db.ref(`packets/incoming/${key}`).remove();
      alreadyProcessedCount++;
      continue;
    }

    // FIX: Check if this packet was already processed before re-triggering.
    // Race condition: if processIncomingPull was slow (cold start), the packet
    // may still be in incoming/ even though it was already processed + outgoing written.
    // Re-triggering would cause processIncomingPull to run AGAIN, overwriting any
    // edits that were applied to the outgoing in between.
    const processedSnap = await db.ref(`packets/processed/${key}`).once('value');
    if (processedSnap.exists()) {
      console.log(`[Watchdog] ${data.wellName}: already processed (${key}), cleaning up stale incoming`);
      await db.ref(`packets/incoming/${key}`).remove();
      alreadyProcessedCount++;
      continue;
    }

    // For edit packets, check if the original was already processed + edited
    if (data.requestType === 'edit' && data.originalPacketId) {
      const origProcessedSnap = await db.ref(`packets/processed/${data.originalPacketId}`).once('value');
      if (origProcessedSnap.exists()) {
        const origPacket = origProcessedSnap.val();
        if (origPacket.editedAt) {
          console.log(`[Watchdog] ${data.wellName}: edit already applied to ${data.originalPacketId}, cleaning up`);
          await db.ref(`packets/incoming/${key}`).remove();
          alreadyProcessedCount++;
          continue;
        }
      }
    }

    // Delete old entry
    await db.ref(`packets/incoming/${key}`).remove();

    // Generate new key with current timestamp
    // Use YYYYMMDD_HHMMSS format (with underscore between date and time)
    // to match normal packet key format. Without the underscore, these keys
    // sort differently in Firebase (digits < underscore in ASCII) and pollute
    // calculateAFR's flow rate window.
    const cleanName = data.wellName.replace(/\s/g, '');
    const now2 = new Date();
    const datePart = now2.toISOString().replace(/[-]/g, '').substr(0, 8);
    const timePart = now2.toISOString().replace(/[-:T]/g, '').substr(8, 6);
    const rand = Math.random().toString(36).substr(2, 6);
    const newKey = `${datePart}_${timePart}_${cleanName}_${rand}`;

    // Write with new key to trigger onCreate
    data.packetId = newKey;
    data.requestType = data.requestType || 'pull';
    data._retriggeredBy = 'watchdog';
    data._retriggeredAt = new Date().toISOString();
    data._originalKey = key; // Track original key for debugging

    await db.ref(`packets/incoming/${newKey}`).set(data);
    console.log(`[Watchdog] Retriggered: ${data.wellName} (${key} -> ${newKey})`);
    retriggeredCount++;

    // Small delay between writes
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`[Watchdog] Done - retriggered ${retriggeredCount}, already processed ${alreadyProcessedCount}`);

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
  jobType?: string; // Commodity type from WB T (e.g. "Production Water", "Fresh Water")
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
  noLevel?: boolean; // True when driver didn't enter a top level (non-PW source)
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
  lastPullDriverId?: string | null;
  lastPullDriverName?: string | null;
  lastPullPacketId?: string | null;
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

// Filter out anomalies (5x+ off median) from flow rates.
// Uses two passes:
//   1. Progressive median — catches outliers as they appear, lets the well's
//      baseline drift over time (handles legitimate regime changes when paired
//      with step detection downstream).
//   2. Final pass with the OVERALL median of pass-1 results — catches early
//      outliers that were grandfathered in before there was enough baseline
//      data (matches the dashboard's anomaly badges so AFR and the UI agree).
// Returns rates with Tier 2 anomalies removed.
function filterAnomalies(flowRates: number[]): number[] {
  if (flowRates.length < 3) {
    return flowRates;
  }

  // Pass 1: progressive
  const knownRates: number[] = [];
  const passOne: number[] = [];
  for (const rate of flowRates) {
    if (knownRates.length >= 3) {
      const medianRate = median(knownRates);
      const level = getFlowRateAnomalyLevel(rate, medianRate);
      if (level < 2) {
        passOne.push(rate);
        knownRates.push(rate);
      }
      // Level 2 anomalies excluded from both.
    } else {
      // Not enough baseline yet — include for now; pass 2 will re-check.
      passOne.push(rate);
      knownRates.push(rate);
    }
  }

  // Pass 2: re-check every kept rate against the OVERALL median.
  // This catches early packets that got grandfathered in during pass 1.
  if (passOne.length < 5) {
    return passOne; // Too few to safely re-filter
  }
  const overallMedian = median(passOne);
  const filtered = passOne.filter(rate => getFlowRateAnomalyLevel(rate, overallMedian) < 2);

  if (filtered.length < 3) {
    return flowRates; // Fallback if too many filtered
  }
  return filtered;
}

// Calculate AFR from recent flow rates using Exponential Moving Average (EMA).
// EMA tracks gradual well slowdowns better than a fixed-window rolling average.
// Alpha = 0.4 gives ~60% weight to recent pulls while smoothing noise.
const EMA_ALPHA = 0.4;

async function calculateAFR(wellName: string, newFlowRateDays: number): Promise<number> {

  // Get recent processed packets for this well
  // NOTE: Don't use limitToLast() - Firebase sorts by key alphabetically,
  // not by timestamp. Watchdog-retriggered packets have squished keys
  // (YYYYMMDDHHMMSS) that sort after normal keys (YYYYMMDD_HHMMSS),
  // poisoning the rate window. Fetch all and sort by timestamp instead.
  const snapshot = await db.ref('packets/processed')
    .orderByChild('wellName')
    .equalTo(wellName)
    .once('value');

  // Collect rates with timestamps, sort by actual time, take most recent 15
  const rateEntries: { timestamp: number; rate: number }[] = [];

  snapshot.forEach((child) => {
    const data = child.val();
    const key = child.key || '';
    // Skip edit/delete/history packets
    if (key.startsWith('edit_') || key.startsWith('delete_') || key.startsWith('history_')) return;
    if (data.flowRateDays && data.flowRateDays > 0) {
      // Sort by timestamp. Prefer dateTimeUTC (always a valid ISO string) over
      // dateTime (locale-formatted by the WB M client and sometimes malformed,
      // e.g. "4/11/2026 3 PM" with no minutes — parses to NaN and corrupts sort).
      let ts = data.dateTimeUTC ? new Date(data.dateTimeUTC).getTime()
        : data.gaugeTime ? new Date(data.gaugeTime).getTime()
        : data.dateTime ? new Date(data.dateTime).getTime()
        : 0;
      if (isNaN(ts)) ts = 0;
      rateEntries.push({ timestamp: ts, rate: data.flowRateDays });
    }
  });

  // Sort by timestamp ascending (oldest first) and take the most recent 15
  rateEntries.sort((a, b) => a.timestamp - b.timestamp);
  const recent = rateEntries.slice(-15);
  const allRates = recent.map(e => e.rate);

  // Add the new rate
  if (newFlowRateDays > 0) {
    allRates.push(newFlowRateDays);
  }

  if (allRates.length === 0) return 0;
  if (allRates.length < 3) return allRates[allRates.length - 1];

  console.log(`[AFR] ${wellName}: ${allRates.length} raw rates`);

  // Filter out anomalies (2x off progressive median) before calculating AFR
  const rates = filterAnomalies(allRates);

  console.log(`[AFR] ${wellName}: ${rates.length} after anomaly filter`);

  if (rates.length === 0) return allRates[allRates.length - 1];
  if (rates.length < 3) return rates[rates.length - 1];

  // Step detection: Check if last 3 are ALL >10% off in same direction
  // Catches sudden regime changes (e.g., well workover, pump change)
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
      // Step detected - use median of last 3 to reset quickly
      const sorted = [...recentRates].sort((a, b) => a - b);
      console.log(`[AFR] ${wellName}: STEP DETECTED, median of last 3: ${sorted[1].toFixed(6)}`);
      return sorted[1];
    }
  }

  // EMA: Exponential Moving Average (alpha=0.4)
  // Seed with the first rate, then apply EMA formula chronologically.
  // Recent pulls get exponentially more weight, tracking drift without lag.
  let ema = rates[0];
  for (let i = 1; i < rates.length; i++) {
    ema = EMA_ALPHA * rates[i] + (1 - EMA_ALPHA) * ema;
  }

  console.log(`[AFR] ${wellName}: EMA(${rates.length} rates, α=${EMA_ALPHA}) = ${ema.toFixed(6)} (${(ema * 24 * 60).toFixed(1)} min/ft)`);
  return ema;
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

    // FIX: Stale/duplicate detection — prevents watchdog re-triggers from
    // overwriting edits. If the outgoing already has data for this pull
    // (same or newer timestamp), skip processing.
    if (prevResponse) {
      const incomingTimeMs = new Date(data.dateTimeUTC).getTime();
      const outgoingTimeMs = new Date(prevResponse.lastPullDateTimeUTC).getTime();

      if (!isNaN(incomingTimeMs) && !isNaN(outgoingTimeMs) && incomingTimeMs <= outgoingTimeMs) {
        // This pull is the same age or older than what's in the outgoing.
        // Could be: watchdog re-trigger, duplicate upload, or a pull that was
        // already processed and the outgoing was subsequently edited.
        console.log(`[STALE] ${wellName}: incoming (${data.dateTimeUTC}) not newer than outgoing (${prevResponse.lastPullDateTimeUTC}), skipping`);
        if (prevResponse.isEdit) {
          console.log(`[STALE] ${wellName}: outgoing has isEdit=true — this re-trigger would have overwritten the edit!`);
        }
        await snapshot.ref.remove();
        return null;
      }
    }

    // Immediately update down/up status so the app reflects the change
    // before the heavy AFR/bbls calculations finish
    await db.ref(`wells/${wellName}/status/isDown`).set(data.wellDown || false);

    // Calculate all fields
    const tankTopInches = (parseFloat(String(data.tankLevelFeet)) || 0) * 12;

    // No top level = not a production tank pull (fresh water, service work, etc.)
    // Log the packet but skip all tank math — don't corrupt existing well data
    if (tankTopInches <= 0) {
      console.log(`[NO-LEVEL] ${wellName}: No top level entered, skipping tank math`);

      const processedPacket: ProcessedPacket = {
        ...data,
        packetId,
        tankTopInches: 0,
        tankAfterInches: 0,
        tankAfterFeet: '',
        timeDif: '',
        timeDifDays: 0,
        recoveryInches: 0,
        flowRate: '',
        flowRateDays: 0,
        recoveryNeeded: 0,
        estTimeToPull: '',
        estDateTimePull: '',
        processedAt: new Date().toISOString(),
        noLevel: true,
      };

      await db.ref(`packets/processed/${packetId}`).set(processedPacket);
      await snapshot.ref.remove();

      console.log(`[NO-LEVEL] ${wellName}: Stored to processed (bbls=${data.bblsTaken}), existing well status preserved`);
      return null;
    }

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
      // Reject unreasonable flow rates (matches windowBblsPerDay safeguard)
      if (flowRateDays >= 365) {
        console.log(`[FlowRate] ${wellName}: rejecting anomalous ${flowRateDays.toFixed(2)} days/ft (timeDif=${timeDifDays.toFixed(4)}d, recovery=${recoveryInches}in)`);
        flowRateDays = 0;
      } else {
        flowRate = daysToHMMSS(flowRateDays);
      }
    }

    // Calculate AFR
    const afr = await calculateAFR(wellName, flowRateDays);

    // Calculate window-averaged and overnight bbls/day
    const bblPerFoot = tanks * 20;
    const historicalPulls = await getHistoricalPulls(wellName, 500);
    const pullTimeMs = new Date(data.dateTimeUTC).getTime();

    // Include current pull in historical data — it's not in packets/processed yet
    historicalPulls.push({
      key: packetId,
      timestamp: pullTimeMs,
      tankLevelFeet: parseFloat(String(data.tankLevelFeet)) || 0,
      bblsTaken: parseFloat(String(data.bblsTaken)) || 0,
      wellDown: data.wellDown === true || data.wellDown === ('true' as any),
    });
    historicalPulls.sort((a, b) => a.timestamp - b.timestamp);

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
      nextPullTime: estDateTimePull ? formatLocalDateTime(new Date(estDateTimePull)) : 'Unknown',
      nextPullTimeUTC: estDateTimePull,
      lastPullDateTime: data.dateTime || formatLocalDateTime(new Date(data.dateTimeUTC)),
      lastPullDateTimeUTC: data.dateTimeUTC,
      lastPullBbls: data.bblsTaken.toString(),
      lastPullTopLevel: inchesToFeetInches(tankTopInches),
      lastPullBottomLevel: inchesToFeetInches(tankAfterInches),
      lastPullDriverId: data.driverId || null,
      lastPullDriverName: data.driverName || null,
      lastPullPacketId: packetId,
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
        dateTime: data.dateTime || formatLocalDateTime(new Date(data.dateTimeUTC)),
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
        nextPullTime: estDateTimePull ? formatLocalDateTime(new Date(estDateTimePull)) : 'Unknown',
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

    // Await chat + JSA tracking — 1st gen CFs can kill fire-and-forget promises after return.
    // These are fast Firestore writes, adds ~1-2s to packet processing but guarantees delivery.
    try {
      await Promise.all([
        sendLevelToChat(data, packetId).catch(err => console.warn('[LevelChat] Send failed:', err)),
        trackJsaLocation(data).catch(err => console.warn('[JsaTrack] Tracking failed:', err)),
      ]);
    } catch (err) {
      console.warn('[PostProcess] Parallel tasks failed:', err);
    }

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

    // WB M sends the original packet ID as "packetId", dashboard sends as "originalPacketId"
    const originalPacketId = data.originalPacketId || data.packetId;
    const wellName = data.wellName;

    if (!originalPacketId) {
      console.error(`Edit failed: no originalPacketId or packetId on edit packet`);
      await snapshot.ref.remove();
      return null;
    }

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
    const rawDateTime = data.dateTime || origPacket.dateTime;
    // Strip seconds from display time (e.g. "4/9/2026, 2:40:00 PM" → "4/9/2026, 2:40 PM")
    const newDateTime = rawDateTime ? rawDateTime.replace(/:(\d{2})\s*(AM|PM)/i, ' $2') : '';

    // Apply wellDown edit — use edited value if present, otherwise keep original
    const newWellDown = data.wellDown !== undefined ? (data.wellDown === true || data.wellDown === 'true') : (origPacket.wellDown || false);

    // No top level = non-production-tank edit. Update basic fields only, skip tank math.
    if (newTankTopInches <= 0) {
      console.log(`[NO-LEVEL EDIT] ${wellName}: No top level, skipping tank math`);
      await db.ref(`packets/processed/${originalPacketId}`).update({
        tankTopInches: 0,
        tankLevelFeet: 0,
        bblsTaken: newBblsTaken,
        tankAfterInches: 0,
        tankAfterFeet: '',
        dateTimeUTC: newDateTimeUTC,
        dateTime: newDateTime,
        editedAt: new Date().toISOString(),
        editedBy: data.source || 'dashboard',
        noLevel: true,
        wellDown: newWellDown,
      });
      await db.ref(`wells/${wellName}/status/isDown`).set(newWellDown);
      await snapshot.ref.remove();
      return null;
    }

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
      if (flowRateDays >= 365) {
        console.log(`[FlowRate-Edit] Rejecting anomalous ${flowRateDays.toFixed(2)} days/ft`);
        flowRateDays = 0;
      } else {
        flowRate = daysToHMMSS(flowRateDays);
      }
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
      wellDown: newWellDown,
    };

    await db.ref(`packets/processed/${originalPacketId}`).update(updates);

    // Update well down status if this is the latest packet
    await db.ref(`wells/${wellName}/status/isDown`).set(newWellDown);

    // CASCADE: Recalculate flowRateDays on the NEXT packet after the edited one.
    // That packet's recovery was based on our old tankAfterInches — now stale.
    let nextPacketKey: string | null = null;
    let nextPacket: any = null;
    let closestNextTime = Infinity;

    prevOutgoingSnap.forEach((child) => {
      if (child.key === originalPacketId) return;
      const pkt = child.val();
      const pktTime = new Date(pkt.dateTimeUTC).getTime();
      if (pktTime > editedTime && pktTime < closestNextTime) {
        closestNextTime = pktTime;
        nextPacketKey = child.key;
        nextPacket = pkt;
      }
    });

    if (nextPacketKey && nextPacket && nextPacket.tankTopInches > 0) {
      // Recalculate the next packet's recovery + flowRate using our NEW tankAfterInches
      const nextRecovery = Math.max(0, nextPacket.tankTopInches - newTankAfterInches);
      const nextTimeDifDays = (closestNextTime - editedTime) / (1000 * 60 * 60 * 24);
      let nextFlowRateDays = 0;
      let nextFlowRate = '';
      if (nextRecovery > 0 && nextTimeDifDays > 0) {
        nextFlowRateDays = (nextTimeDifDays / nextRecovery) * 12;
        nextFlowRate = daysToHMMSS(nextFlowRateDays);
      }
      await db.ref(`packets/processed/${nextPacketKey}`).update({
        recoveryInches: nextRecovery,
        flowRateDays: nextFlowRateDays,
        flowRate: nextFlowRate,
      });
      console.log(`Edit cascade: Updated next packet ${nextPacketKey} — recovery=${nextRecovery.toFixed(1)}", flowRate=${nextFlowRate}`);
    }

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
            lastPullDateTime: newDateTime || formatLocalDateTime(new Date(newDateTimeUTC)),
            lastPullDateTimeUTC: newDateTimeUTC,
            timeTillPull: newWellDown ? 'Down' : (estTimeToPull || 'Calculating...'),
            nextPullTime: estDateTimePull ? formatLocalDateTime(new Date(estDateTimePull)) : 'Unknown',
            nextPullTimeUTC: estDateTimePull,
            isEdit: true,
            originalPacketId,
            wellDown: newWellDown,
            lastPullDriverId: origPacket.driverId || null,
            lastPullDriverName: origPacket.driverName || null,
            lastPullPacketId: originalPacketId,
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
          lastPullDateTime: newDateTime || formatLocalDateTime(new Date(newDateTimeUTC)),
          lastPullDateTimeUTC: newDateTimeUTC,
          timeTillPull: newWellDown ? 'Down' : (estTimeToPull || 'Calculating...'),
          nextPullTime: estDateTimePull ? formatLocalDateTime(new Date(estDateTimePull)) : 'Unknown',
          nextPullTimeUTC: estDateTimePull,
          wellDown: newWellDown,
          status: 'success',
          timestamp: responseTimestamp.toISOString(),
          timestampUTC: responseTimestamp.toISOString(),
          isEdit: true,
          originalPacketId,
          lastPullDriverId: origPacket.driverId || null,
          lastPullDriverName: origPacket.driverName || null,
          lastPullPacketId: originalPacketId,
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

    // Update performance/ row (WB M reads from here)
    // processIncomingPull writes these on initial pull, but edits were never synced — fix that
    try {
      const perfPullTime = new Date(newDateTimeUTC);
      const perfTimestamp = `${perfPullTime.getFullYear()}${String(perfPullTime.getMonth() + 1).padStart(2, '0')}${String(perfPullTime.getDate()).padStart(2, '0')}_${String(perfPullTime.getHours()).padStart(2, '0')}${String(perfPullTime.getMinutes()).padStart(2, '0')}${String(perfPullTime.getSeconds()).padStart(2, '0')}`;
      const perfDateStr = `${perfPullTime.getFullYear()}-${String(perfPullTime.getMonth() + 1).padStart(2, '0')}-${String(perfPullTime.getDate()).padStart(2, '0')}`;
      const perfWellKey = wellName.replace(/\s+/g, '_');
      const actualInches = Math.floor(newTankTopInches);

      // If date was edited, clean up the OLD performance row (different timestamp key)
      if (data.dateTimeUTC && data.dateTimeUTC !== origPacket.dateTimeUTC) {
        const oldPullTime = new Date(origPacket.dateTimeUTC);
        const oldPerfTimestamp = `${oldPullTime.getFullYear()}${String(oldPullTime.getMonth() + 1).padStart(2, '0')}${String(oldPullTime.getDate()).padStart(2, '0')}_${String(oldPullTime.getHours()).padStart(2, '0')}${String(oldPullTime.getMinutes()).padStart(2, '0')}${String(oldPullTime.getSeconds()).padStart(2, '0')}`;
        await db.ref(`performance/${perfWellKey}/rows/${oldPerfTimestamp}`).remove();
        console.log(`Edit: Removed old performance row ${oldPerfTimestamp} for ${wellName}`);
      }

      // Use predicted from original packet if available, otherwise default to actual
      const predictedInches = origPacket.predictedLevelInches
        ? Math.floor(Number(origPacket.predictedLevelInches))
        : actualInches;

      await db.ref(`performance/${perfWellKey}/rows/${perfTimestamp}`).set({
        d: perfDateStr,
        a: actualInches,
        p: predictedInches,
      });
      await db.ref(`performance/${perfWellKey}/wellName`).set(wellName);
      await db.ref(`performance/${perfWellKey}/updated`).set(new Date().toISOString());
      console.log(`Edit: Updated performance/ for ${wellName}: a=${actualInches} p=${predictedInches}`);
    } catch (perfError) {
      console.error(`Edit: Error updating performance/ for ${wellName}:`, perfError);
    }

    // ── Update wells/{wellName}/status (same structure as processIncomingPull) ──
    if (isLatestPull && afr > 0) {
      const editAfrMinutes = afr * 24 * 60;
      const editWellStatus = {
        wellName,
        config: {
          tanks,
          bottomLevel: bottomInches / 12,
          route: config.route || 'Unassigned',
          pullBbls,
        },
        current: {
          level: inchesToFeetInches(newTankAfterInches),
          levelInches: newTankAfterInches,
          asOf: new Date().toISOString(),
        },
        lastPull: {
          dateTime: newDateTime || formatLocalDateTime(new Date(newDateTimeUTC)),
          dateTimeUTC: newDateTimeUTC,
          topLevel: inchesToFeetInches(newTankTopInches),
          topLevelInches: newTankTopInches,
          bottomLevel: inchesToFeetInches(newTankAfterInches),
          bottomLevelInches: newTankAfterInches,
          bblsTaken: newBblsTaken,
          driverName: origPacket.driverName || '',
          packetId: originalPacketId,
        },
        calculated: {
          flowRate: daysToHMMSS(afr),
          flowRateMinutes: Math.round(editAfrMinutes * 100) / 100,
          bbls24hrs: Math.round((1 / afr) * tanks * 20) || 0,
          nextPullTime: (() => { const pullHeightIn = (pullBbls / 20 / tanks) * 12; const targetLvl = bottomInches + pullHeightIn; const recovNeeded = Math.max(0, targetLvl - newTankAfterInches); if (recovNeeded <= 0) return formatLocalDateTime(new Date(newDateTimeUTC)); const estDays = (recovNeeded / 12) * afr; const estDate = new Date(new Date(newDateTimeUTC).getTime() + estDays * 24 * 60 * 60 * 1000); return formatLocalDateTime(estDate); })(),
          nextPullTimeUTC: (() => { const pullHeightIn = (pullBbls / 20 / tanks) * 12; const targetLvl = bottomInches + pullHeightIn; const recovNeeded = Math.max(0, targetLvl - newTankAfterInches); if (recovNeeded <= 0) return newDateTimeUTC; const estDays = (recovNeeded / 12) * afr; return new Date(new Date(newDateTimeUTC).getTime() + estDays * 24 * 60 * 60 * 1000).toISOString(); })(),
          timeTillPull: newWellDown ? 'Down' : (() => { const pullHeightIn = (pullBbls / 20 / tanks) * 12; const targetLvl = bottomInches + pullHeightIn; const recovNeeded = Math.max(0, targetLvl - newTankAfterInches); if (recovNeeded <= 0) return '0:00'; return daysToHMM((recovNeeded / 12) * afr); })(),
        },
        isDown: newWellDown,
        updatedAt: new Date().toISOString(),
      };
      await db.ref(`wells/${wellName}/status`).set(editWellStatus);
      console.log(`Edit: Updated wells/${wellName}/status (full recalc)`);
    }

    // ── Cascade to Firestore: ticket doc, dispatch doc, invoice doc ──
    try {
      const firestore = admin.firestore();

      // Find ticket by packetId (submitTicket CF writes packetId on ticket docs)
      let ticketSnap = await firestore.collection('tickets')
        .where('packetId', '==', originalPacketId)
        .limit(1)
        .get();

      // Fallback: find by wellName/location + date (for tickets created before packetId was stored)
      if (ticketSnap.empty && wellName) {
        const origDate = origPacket.dateTime || '';
        // Normalize date to MM/DD/YYYY (WB T ticket format) from either "M/D/YYYY H:MM" or ISO
        let datePart = origDate.split(' ')[0] || origDate.split('T')[0] || '';
        if (datePart.includes('-')) {
          // ISO format YYYY-MM-DD → MM/DD/YYYY
          const [y, m, d] = datePart.split('-');
          datePart = `${m}/${d}/${y}`;
        } else if (datePart.includes('/')) {
          // M/D/YYYY → MM/DD/YYYY (pad with zeros)
          const parts = datePart.split('/');
          datePart = `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[2]}`;
        }
        console.log(`Edit: Firestore fallback searching date=${datePart} wellName=${wellName}`);
        if (datePart) {
          // Try wellName field first, then location (WB T uses 'location' for well name)
          for (const field of ['wellName', 'location']) {
            const fallbackSnap = await firestore.collection('tickets')
              .where(field, '==', wellName)
              .where('date', '==', datePart)
              .limit(5)
              .get();
            if (!fallbackSnap.empty) {
              // If multiple tickets for same well+date, match by BBLs (original or current)
              const origBbls = String(origPacket.bblsTaken);
              const match = fallbackSnap.docs.find(d => d.data().bbls === origBbls)
                || fallbackSnap.docs[0]; // Fallback to first if no BBL match
              ticketSnap = { empty: false, docs: [match] } as any;
              console.log(`Edit: Found ticket via fallback (${field}+date) for ${wellName}: ${match.id}`);
              break;
            }
          }
        }
      }

      if (!ticketSnap.empty) {
        const ticketDoc = ticketSnap.docs[0];
        const ticketData = ticketDoc.data();
        await ticketDoc.ref.update({
          bbls: String(newBblsTaken),
          top: inchesToFeetInches(newTankTopInches),
          bottom: inchesToFeetInches(newTankAfterInches),
          editedAt: admin.firestore.Timestamp.now(),
          editedBy: data.source || 'dashboard',
          packetId: originalPacketId, // Backfill for future edits
        });
        console.log(`Edit: Updated Firestore ticket ${ticketDoc.id} bbls=${newBblsTaken}`);

        // Cascade to dispatch doc if ticket has a dispatchId
        const dispatchId = ticketData.dispatchId;
        if (dispatchId) {
          // Recalculate totalBBL from all tickets for this dispatch
          const allTicketsSnap = await firestore.collection('tickets')
            .where('dispatchId', '==', dispatchId)
            .get();
          let totalBBL = 0;
          allTicketsSnap.forEach(t => {
            totalBBL += (t.id === ticketDoc.id ? newBblsTaken : (parseFloat(t.data().bbls) || 0));
          });
          await firestore.collection('dispatches').doc(dispatchId).update({
            totalBBL,
          });
          console.log(`Edit: Updated dispatch ${dispatchId} totalBBL=${totalBBL}`);
        }

        // Cascade to invoice doc if ticket has an invoiceDocId
        const invoiceDocId = ticketData.invoiceDocId;
        if (invoiceDocId) {
          // Recalculate totalBBL from all tickets for this invoice
          const invTicketsSnap = await firestore.collection('tickets')
            .where('invoiceDocId', '==', invoiceDocId)
            .get();
          let invTotalBBL = 0;
          invTicketsSnap.forEach(t => {
            invTotalBBL += (t.id === ticketDoc.id ? newBblsTaken : (parseFloat(t.data().bbls) || 0));
          });
          await firestore.collection('invoices').doc(invoiceDocId).update({
            totalBBL: invTotalBBL,
          });
          console.log(`Edit: Updated invoice ${invoiceDocId} totalBBL=${invTotalBBL}`);
        }
      } else {
        console.log(`Edit: No Firestore ticket found for packetId ${originalPacketId} — trying direct invoice search`);
      }

      // Direct invoice search — if ticket path didn't find/update the invoice,
      // search invoices directly by wellName + date. Payroll reads from invoices, not tickets.
      // This catches s_t mode jobs where ticket→invoice link may be missing.
      const origDate = origPacket.dateTime || '';
      let invoiceDatePart = origDate.split(' ')[0] || origDate.split('T')[0] || '';
      if (invoiceDatePart.includes('-')) {
        const [y, m, d] = invoiceDatePart.split('-');
        invoiceDatePart = `${m}/${d}/${y}`;
      } else if (invoiceDatePart.includes('/')) {
        const parts = invoiceDatePart.split('/');
        invoiceDatePart = `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[2]}`;
      }

      if (invoiceDatePart) {
        const invoiceSnap = await firestore.collection('invoices')
          .where('wellName', '==', wellName)
          .where('date', '==', invoiceDatePart)
          .limit(5)
          .get();

        if (!invoiceSnap.empty) {
          // Match by original BBLs or driver name
          const origBblNum = origPacket.bblsTaken;
          const driverName = origPacket.driverName || '';
          const match = invoiceSnap.docs.find(d => {
            const inv = d.data();
            return inv.totalBBL === origBblNum || inv.totalBBL === newBblsTaken
              || (driverName && (inv.driver || '').includes(driverName));
          }) || invoiceSnap.docs[0];

          const invData = match.data();
          if (invData.totalBBL !== newBblsTaken) {
            await match.ref.update({
              totalBBL: newBblsTaken,
              editedAt: admin.firestore.Timestamp.now(),
              editedBy: data.source || 'dashboard',
            });
            console.log(`Edit: Direct invoice update ${match.id} totalBBL: ${invData.totalBBL}→${newBblsTaken}`);
          } else {
            console.log(`Edit: Invoice ${match.id} already has correct totalBBL=${newBblsTaken}`);
          }
        } else {
          console.log(`Edit: No invoice found for ${wellName} on ${invoiceDatePart}`);
        }
      }
    } catch (fsErr) {
      // Non-blocking — RTDB is already updated, Firestore cascade is best-effort
      console.error(`Edit: Firestore cascade error (non-blocking):`, fsErr);
    }

    // Delete the edit request
    await snapshot.ref.remove();

    // Increment incoming_version so WB M app knows to refresh
    try {
      const versionSnap = await db.ref('packets/incoming_version').once('value');
      const currentVersion = parseInt(versionSnap.val(), 10) || 0;
      await db.ref('packets/incoming_version').set(currentVersion + 1);
      console.log(`Edit: Incremented incoming_version to ${currentVersion + 1}`);
    } catch (versionErr) {
      console.error('Edit: Failed to increment incoming_version:', versionErr);
    }

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

    // CASCADE: Before deleting, fix the next packet's flowRateDays.
    // The next packet's recovery was measured from this packet's tankAfterInches.
    // After deletion, it should use the PREVIOUS packet's tankAfterInches instead.
    if (deletedPacket && deletedPacket.dateTimeUTC) {
      const allWellSnap = await db.ref('packets/processed')
        .orderByChild('wellName')
        .equalTo(wellName)
        .once('value');

      const deletedTime = new Date(deletedPacket.dateTimeUTC).getTime();
      let prevPkt: any = null;
      let prevTime = 0;
      let nextKey: string | null = null;
      let nextPkt: any = null;
      let nextTime = Infinity;

      allWellSnap.forEach((child) => {
        if (child.key === targetPacketId) return;
        const pkt = child.val();
        const pktTime = new Date(pkt.dateTimeUTC).getTime();
        if (pktTime < deletedTime && pktTime > prevTime) {
          prevTime = pktTime;
          prevPkt = pkt;
        }
        if (pktTime > deletedTime && pktTime < nextTime) {
          nextTime = pktTime;
          nextKey = child.key;
          nextPkt = pkt;
        }
      });

      if (nextKey && nextPkt && nextPkt.tankTopInches > 0) {
        const prevAfterInches = prevPkt?.tankAfterInches || 0;
        const nextRecovery = prevAfterInches > 0 ? Math.max(0, nextPkt.tankTopInches - prevAfterInches) : 0;
        const nextTimeDif = prevTime > 0 ? (nextTime - prevTime) / (1000 * 60 * 60 * 24) : 0;
        let nextFlowRateDays = 0;
        let nextFlowRate = '';
        if (nextRecovery > 0 && nextTimeDif > 0) {
          nextFlowRateDays = (nextTimeDif / nextRecovery) * 12;
          nextFlowRate = daysToHMMSS(nextFlowRateDays);
        }
        await db.ref(`packets/processed/${nextKey}`).update({
          recoveryInches: nextRecovery,
          flowRateDays: nextFlowRateDays,
          flowRate: nextFlowRate,
          timeDifDays: nextTimeDif,
          timeDif: nextTimeDif > 0 ? daysToHMM(nextTimeDif) : '',
        });
        console.log(`Delete cascade: Updated next packet ${nextKey} — recovery=${nextRecovery.toFixed(1)}", flowRate=${nextFlowRate}`);
      }
    }

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

      // Clean up performance data for the deleted packet
      if (deletedPacket.dateTimeUTC) {
        try {
          const delTime = new Date(deletedPacket.dateTimeUTC);
          const perfTimestamp = `${delTime.getFullYear()}${String(delTime.getMonth() + 1).padStart(2, '0')}${String(delTime.getDate()).padStart(2, '0')}_${String(delTime.getHours()).padStart(2, '0')}${String(delTime.getMinutes()).padStart(2, '0')}${String(delTime.getSeconds()).padStart(2, '0')}`;
          const wellKey = wellName.replace(/\s+/g, '_');
          await db.ref(`performance/${wellKey}/rows/${perfTimestamp}`).remove();
          console.log(`Delete: Cleaned up performance row ${perfTimestamp} for ${wellName}`);
        } catch (perfErr) {
          console.error(`Delete: Failed to clean performance data:`, perfErr);
        }
      }

      // Always rebuild outgoing — wrapped in try/catch so delete completes even if rebuild fails
      try {
        if (latestPacket) {
          console.log(`Delete: Rebuilding outgoing for ${wellName} from packet ${latestPacket.packetId || 'unknown'} (dateTimeUTC=${latestPacket.dateTimeUTC})`);

          // Recalculate AFR from remaining packets
          const afr = await calculateAFR(wellName, latestPacket.flowRateDays || 0);
          console.log(`Delete: AFR for ${wellName} = ${afr}`);

          // Calculate windowBblsDay and overnightBblsDay from remaining historical pulls
          const bblPerFoot = tanks * 20;
          const latestTimeMs = new Date(latestPacket.dateTimeUTC).getTime();
          const historicalPulls = await getHistoricalPulls(wellName, 500);
          const windowBblsDay = calculateWindowBblsPerDay(historicalPulls, bblPerFoot, latestTimeMs);
          const overnightBblsDay = calculateOvernightBblsPerDay(historicalPulls, bblPerFoot, latestTimeMs);

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

          const deleteOldPromises: Promise<void>[] = [];
          oldResponses.forEach((child) => {
            deleteOldPromises.push(child.ref.remove());
          });
          await Promise.all(deleteOldPromises);

          const timestamp = new Date();
          const responseId = `response_${timestamp.toISOString().replace(/[-:]/g, '').replace('T', '_').split('.')[0]}_${cleanName}`;

          await db.ref(`packets/outgoing/${responseId}`).set({
            wellName,
            currentLevel: inchesToFeetInches(tankAfterInches),
            flowRate: afr > 0 ? daysToHMMSS(afr) : 'Unknown',
            bbls24hrs,
            timeTillPull: latestPacket.wellDown ? 'Down' : (estTimeToPull || 'Calculating...'),
            nextPullTime: estDateTimePull ? formatLocalDateTime(new Date(estDateTimePull)) : 'Unknown',
            nextPullTimeUTC: estDateTimePull,
            lastPullDateTime: latestPacket.dateTime || formatLocalDateTime(new Date(latestPacket.dateTimeUTC)),
            lastPullDateTimeUTC: latestPacket.dateTimeUTC,
            lastPullBbls: latestPacket.bblsTaken.toString(),
            lastPullTopLevel: inchesToFeetInches(latestPacket.tankTopInches),
            lastPullBottomLevel: inchesToFeetInches(tankAfterInches),
            lastPullDriverId: latestPacket.driverId || null,
            lastPullDriverName: latestPacket.driverName || null,
            lastPullPacketId: latestPacket.packetId || null,
            wellDown: latestPacket.wellDown || false,
            status: 'success',
            timestamp: timestamp.toISOString(),
            timestampUTC: timestamp.toISOString(),
            isEdit: true,  // Force WB M to accept this even though lastPullDateTimeUTC is older
            isDeleteRebuild: true,
            windowBblsDay: windowBblsDay > 0 ? windowBblsDay.toString() : null,
            overnightBblsDay: overnightBblsDay > 0 ? overnightBblsDay.toString() : null,
          });

          // Update well_config AFR
          if (afr > 0) {
            const afrMinutes = afr * 24 * 60;
            await db.ref(`well_config/${wellName}`).update({
              avgFlowRate: daysToHMMSS(afr),
              avgFlowRateMinutes: Math.round(afrMinutes * 100) / 100,
            });
          }

          console.log(`Delete: Rebuilt outgoing for ${wellName} from remaining data (windowBblsDay=${windowBblsDay}, overnightBblsDay=${overnightBblsDay})`);
        } else {
          // No remaining pulls — remove outgoing response entirely
          const oldResponses = await db.ref('packets/outgoing')
            .orderByChild('wellName')
            .equalTo(wellName)
            .once('value');

          const deleteOldPromises: Promise<void>[] = [];
          oldResponses.forEach((child) => {
            deleteOldPromises.push(child.ref.remove());
          });
          await Promise.all(deleteOldPromises);

          console.log(`Delete: No remaining pulls for ${wellName}, cleared outgoing`);
        }
      } catch (rebuildErr) {
        console.error(`Delete: FAILED to rebuild outgoing for ${wellName}:`, rebuildErr);
        // Outgoing is now stale, but at least the processed packet is deleted
        // Log the error details for debugging
        console.error(`Delete: latestPacket was:`, latestPacket ? {
          packetId: latestPacket.packetId,
          wellName: latestPacket.wellName,
          dateTimeUTC: latestPacket.dateTimeUTC,
          tankAfterInches: latestPacket.tankAfterInches,
          flowRateDays: latestPacket.flowRateDays,
        } : 'null');
      }
    }

    // Increment incoming_version so WB M app knows to refresh
    try {
      const versionSnap = await db.ref('packets/incoming_version').once('value');
      const currentVersion = parseInt(versionSnap.val(), 10) || 0;
      await db.ref('packets/incoming_version').set(currentVersion + 1);
      console.log(`Delete: Incremented incoming_version to ${currentVersion + 1}`);
    } catch (versionErr) {
      console.error('Delete: Failed to increment incoming_version:', versionErr);
    }

    // Archive delete request for audit trail (instead of just removing it)
    const auditData = {
      ...data,
      processedAt: new Date().toISOString(),
      deletedPacketData: deletedPacket ? {
        wellName: deletedPacket.wellName,
        dateTimeUTC: deletedPacket.dateTimeUTC,
        tankLevelFeet: deletedPacket.tankLevelFeet,
        bblsTaken: deletedPacket.bblsTaken,
        driverName: deletedPacket.driverName,
      } : null,
      result: deletedPacket ? 'rebuilt_from_previous' : 'packet_not_found',
    };
    await db.ref(`packets/processed/delete_${targetPacketId}`).set(auditData);
    await snapshot.ref.remove();

    console.log(`Delete complete for ${wellName}: ${targetPacketId}`);
    return null;
  });

// ============================================================
// WEEKLY DIESEL PRICE AUTO-FETCH
// Runs every Monday at 10:00 AM CT (16:00 UTC) — DOE publishes Mondays
// Fetches latest EIA diesel price for each company with a doeRegion set
// ============================================================

const EIA_API_KEY = '8mXuoSgL8cBJv4EXnzV2g201GToEOdQRalVHo1ej';

const DOE_REGION_TO_EIA: Record<string, string> = {
  us: 'NUS', padd1: 'R10', padd1a: 'R1X', padd1b: 'R1Y', padd1c: 'R1Z',
  padd2: 'R20', padd3: 'R30', padd4: 'R40', padd5: 'R50',
  padd5_no_ca: 'R5XCA', california: 'SCA',
};

// State → PADD region fallback (mirrors client-side STATE_TO_PADD)
const STATE_TO_PADD: Record<string, string> = {
  CT: 'padd1a', ME: 'padd1a', MA: 'padd1a', NH: 'padd1a', RI: 'padd1a', VT: 'padd1a',
  DE: 'padd1b', DC: 'padd1b', MD: 'padd1b', NJ: 'padd1b', NY: 'padd1b', PA: 'padd1b',
  FL: 'padd1c', GA: 'padd1c', NC: 'padd1c', SC: 'padd1c', VA: 'padd1c', WV: 'padd1c',
  IL: 'padd2', IN: 'padd2', IA: 'padd2', KS: 'padd2', KY: 'padd2', MI: 'padd2',
  MN: 'padd2', MO: 'padd2', NE: 'padd2', ND: 'padd2', SD: 'padd2', OH: 'padd2',
  OK: 'padd2', TN: 'padd2', WI: 'padd2',
  AL: 'padd3', AR: 'padd3', LA: 'padd3', MS: 'padd3', NM: 'padd3', TX: 'padd3',
  CO: 'padd4', ID: 'padd4', MT: 'padd4', UT: 'padd4', WY: 'padd4',
  AK: 'padd5', AZ: 'padd5', HI: 'padd5', NV: 'padd5', OR: 'padd5', WA: 'padd5',
  CA: 'california',
};

async function fetchDieselFromEIA(doeRegion: string): Promise<{ price: number; date: string } | null> {
  const duoarea = DOE_REGION_TO_EIA[doeRegion] || 'NUS';
  const url = `https://api.eia.gov/v2/petroleum/pri/gnd/data?api_key=${EIA_API_KEY}`
    + `&frequency=weekly&data[0]=value`
    + `&facets[duoarea][]=${duoarea}&facets[product][]=EPD2D`
    + `&sort[0][column]=period&sort[0][direction]=desc&length=1`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[DieselFetch] EIA API error: ${res.status} ${res.statusText}`);
      return null;
    }
    const json = await res.json();
    const row = json?.response?.data?.[0];
    if (!row?.value) {
      console.error(`[DieselFetch] No data returned for region ${doeRegion}`);
      return null;
    }
    return { price: parseFloat(row.value), date: row.period || new Date().toISOString().split('T')[0] };
  } catch (err) {
    console.error(`[DieselFetch] Fetch failed for ${doeRegion}:`, err);
    return null;
  }
}

export const weeklyDieselPriceFetch = functionsV2.onSchedule(
  { schedule: 'every tuesday 16:00', timeZone: 'UTC' },
  async () => {
    console.log('[DieselFetch] Starting weekly diesel price update...');
    const firestore = admin.firestore();

    // Get all companies that have a doeRegion configured
    const companiesSnap = await firestore.collection('companies').get();
    const companies: { id: string; doeRegion: string; name: string }[] = [];

    companiesSnap.forEach(doc => {
      const data = doc.data();
      const region = data.doeRegion || (data.state ? STATE_TO_PADD[data.state.toUpperCase()] : null);
      if (region) {
        companies.push({ id: doc.id, doeRegion: region, name: data.name || doc.id });
      }
    });

    if (companies.length === 0) {
      console.log('[DieselFetch] No companies with doeRegion configured, skipping');
      return;
    }

    console.log(`[DieselFetch] Fetching prices for ${companies.length} companies`);

    // Group by region to avoid duplicate API calls
    const regionMap = new Map<string, string[]>();
    for (const co of companies) {
      const existing = regionMap.get(co.doeRegion) || [];
      existing.push(co.id);
      regionMap.set(co.doeRegion, existing);
    }

    // Fetch once per unique region
    const regionPrices = new Map<string, { price: number; date: string }>();
    for (const [region] of regionMap) {
      const result = await fetchDieselFromEIA(region);
      if (result) {
        regionPrices.set(region, result);
        console.log(`[DieselFetch] ${region}: $${result.price} (${result.date})`);
      }
    }

    // Update each company
    let updated = 0;
    for (const co of companies) {
      const priceData = regionPrices.get(co.doeRegion);
      if (!priceData) continue;

      // Check if price already saved for this date (idempotent)
      const existingSnap = await firestore.collection('diesel_prices')
        .where('companyId', '==', co.id)
        .where('date', '==', priceData.date)
        .limit(1)
        .get();

      if (!existingSnap.empty) {
        console.log(`[DieselFetch] ${co.name}: Already has price for ${priceData.date}, skipping`);
        continue;
      }

      // Save to price history
      await firestore.collection('diesel_prices').add({
        companyId: co.id,
        price: priceData.price,
        date: priceData.date,
        source: 'EIA Auto-Fetch',
        updatedBy: 'system',
        createdAt: admin.firestore.Timestamp.now(),
      });

      // Update company's current price
      await firestore.collection('companies').doc(co.id).update({
        currentDieselPrice: priceData.price,
      });

      updated++;
      console.log(`[DieselFetch] ${co.name}: Updated to $${priceData.price}`);
    }

    console.log(`[DieselFetch] Complete. Updated ${updated}/${companies.length} companies.`);
  }
);

// Manual trigger endpoint for testing the diesel fetch (callable from dashboard)
export const triggerDieselFetch = httpsV2.onRequest(
  { cors: true },
  async (req, res) => {
    console.log('[DieselFetch] Manual trigger...');
    const firestore = admin.firestore();

    const companiesSnap = await firestore.collection('companies').get();
    const results: { company: string; region: string; price?: number; date?: string; error?: string }[] = [];

    const regionCache = new Map<string, { price: number; date: string } | null>();

    for (const doc of companiesSnap.docs) {
      const data = doc.data();
      const region = data.doeRegion || (data.state ? STATE_TO_PADD[data.state.toUpperCase()] : null);
      if (!region) continue;

      // Fetch once per region
      if (!regionCache.has(region)) {
        regionCache.set(region, await fetchDieselFromEIA(region));
      }
      const priceData = regionCache.get(region);

      if (!priceData) {
        results.push({ company: data.name || doc.id, region, error: 'Fetch failed' });
        continue;
      }

      // Check idempotency
      const existingSnap = await firestore.collection('diesel_prices')
        .where('companyId', '==', doc.id)
        .where('date', '==', priceData.date)
        .limit(1)
        .get();

      if (existingSnap.empty) {
        await firestore.collection('diesel_prices').add({
          companyId: doc.id,
          price: priceData.price,
          date: priceData.date,
          source: 'EIA Manual Trigger',
          updatedBy: 'admin',
          createdAt: admin.firestore.Timestamp.now(),
        });

        await firestore.collection('companies').doc(doc.id).update({
          currentDieselPrice: priceData.price,
        });
      }

      results.push({ company: data.name || doc.id, region, price: priceData.price, date: priceData.date });
    }

    res.json({ success: true, updated: results.length, results });
  }
);

// ============================================================
// PHOTO CLEANUP: Auto-delete expired CYA photos from Storage
// Runs daily at 3am. Per-company retention from photoRetentionDays.
// ============================================================
export const cleanupExpiredPhotos = functionsV2.onSchedule('every day 03:00', async (event) => {
  console.log('[PhotoCleanup] Starting expired photo cleanup...');
  const firestore = admin.firestore();
  const storage = admin.storage().bucket();

  // 1. Load all companies to get per-company retention
  const companiesSnap = await firestore.collection('companies').get();
  const retentionByCompany: Record<string, number> = {};
  companiesSnap.docs.forEach(doc => {
    const data = doc.data();
    retentionByCompany[doc.id] = data.photoRetentionDays || 30;
  });

  // 2. Query closed invoices with photos
  const invoicesSnap = await firestore.collection('invoices')
    .where('status', '==', 'closed')
    .get();

  let deletedCount = 0;
  let cleanedInvoices = 0;

  for (const doc of invoicesSnap.docs) {
    const data = doc.data();
    const photos: string[] = data.photos || [];
    if (photos.length === 0) continue;

    // Check if past retention window
    const closedAt = data.closedAt?.toDate?.() || data.closedAt;
    if (!closedAt) continue;

    const companyId = data.companyId || '';
    const retentionDays = retentionByCompany[companyId] || 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    const closedDate = closedAt instanceof Date ? closedAt : new Date(closedAt);
    if (closedDate > cutoff) continue; // Not expired yet

    // 3. Delete each photo from Storage
    for (const url of photos) {
      try {
        const match = url.match(/\/o\/(.+?)\?/);
        if (!match) continue;
        const filePath = decodeURIComponent(match[1]);
        await storage.file(filePath).delete().catch(() => {});
        deletedCount++;
      } catch (err) {
        console.warn('[PhotoCleanup] Failed to delete photo:', err);
      }
    }

    // 4. Clear photos array on invoice
    await doc.ref.update({ photos: [] });
    cleanedInvoices++;
  }

  console.log(`[PhotoCleanup] Done. Deleted ${deletedCount} photos from ${cleanedInvoices} invoices.`);
});

// ============================================================
// WB CHAT — Auto-create threads and post system messages
// ============================================================

const firestoreDb = admin.firestore();

/** Get dispatch/admin user participant IDs for a company */
async function getDispatchParticipants(companyId: string): Promise<{ ids: string[]; names: Record<string, string> }> {
  const usersSnap = await db.ref('users').once('value');
  const users = usersSnap.val() || {};
  const ids: string[] = [];
  const names: Record<string, string> = {};
  for (const [uid, userData] of Object.entries(users) as [string, any][]) {
    if (!userData.role || !['admin', 'manager', 'it'].includes(userData.role)) continue;
    // WB admin (no companyId) sees all, hauler admin sees their company only
    if (userData.companyId && userData.companyId !== companyId) continue;
    const pid = `user:${uid}`;
    ids.push(pid);
    names[pid] = userData.displayName || userData.email || 'Dispatch';
  }
  return { ids, names };
}

/** Post a system message to a thread */
async function postSystemMessage(
  threadId: string,
  text: string,
  systemType: string,
  systemData?: Record<string, any>,
) {
  const now = admin.firestore.Timestamp.now();
  await firestoreDb.collection('chat_threads').doc(threadId).collection('messages').add({
    text,
    senderId: 'system',
    senderName: 'WellBuilt',
    timestamp: now,
    type: 'system',
    systemType,
    ...(systemData ? { systemData } : {}),
  });
  // Update thread lastMessage
  await firestoreDb.collection('chat_threads').doc(threadId).update({
    lastMessage: {
      text: text.length > 100 ? text.substring(0, 100) + '...' : text,
      senderId: 'system',
      senderName: 'WellBuilt',
      timestamp: now,
      type: 'system',
    },
    updatedAt: now,
  });
}

// ── sendLevelToChat: Fire-and-forget level report to driver's dispatch chat threads ──
async function sendLevelToChat(data: PullPacket, packetId: string): Promise<void> {
  try {
    const driverHash = data.driverId;
    if (!driverHash) {
      console.log('[LevelChat] No driverId on packet, skipping');
      return;
    }

    // Get driver info from RTDB
    const driverSnap = await db.ref(`drivers/approved/${driverHash}`).once('value');
    if (!driverSnap.exists()) {
      console.log('[LevelChat] Driver not found in approved:', driverHash.slice(0, 8));
      return;
    }
    const driverData = driverSnap.val();
    const companyId = driverData.companyId;
    if (!companyId) {
      console.log('[LevelChat] No companyId on driver, skipping');
      return;
    }
    const driverName = driverData.legalName || driverData.displayName || data.driverName || 'Driver';

    // Check company config for sendLevelToDispatch toggle
    const companyDoc = await firestoreDb.collection('companies').doc(companyId).get();
    if (!companyDoc.exists) {
      console.log('[LevelChat] Company doc not found:', companyId);
      return;
    }
    const companyConfig = companyDoc.data() || {};
    if (!companyConfig.sendLevelToDispatch) {
      return; // Feature not enabled for this company
    }

    // Build message from template or default
    const templateStr: string = companyConfig.levelReportTemplate ||
      '📊 Level Report\nWell: {wellName}\nTop: {top} | Bottom: {bottom}\nBBLs: {bbls}\nTime: {time}';

    // Format levels as feet'inches"
    const topInches = (parseFloat(String(data.tankLevelFeet)) || 0) * 12;
    const tanks = companyConfig.tanks || 1; // fallback; not critical for display
    const bblsInInches = data.bblsTaken > 0 ? (data.bblsTaken / 20 / tanks) * 12 : 0;
    const bottomInches = topInches - bblsInInches;
    const topStr = inchesToFeetInches(topInches);
    const bottomStr = inchesToFeetInches(Math.max(0, bottomInches));

    // Format date + time from packet
    const fullTimeStr = data.dateTime || (data.dateTimeUTC ? formatLocalDateTime(new Date(data.dateTimeUTC)) : '');
    // Split into date and time parts: "04/11/2026 9:12 PM" → date="04/11/2026", time="9:12 PM"
    const timeParts = fullTimeStr.split(' ');
    const dateStr = timeParts[0] || '';
    const timeOnlyStr = timeParts.slice(1).join(' ') || fullTimeStr; // fallback to full string

    let message = templateStr;
    message = message.replace(/\{wellName\}/gi, data.wellName || '');
    message = message.replace(/\{well\}/gi, data.wellName || ''); // alias for {wellName}
    message = message.replace(/\{top\}/gi, topStr);
    message = message.replace(/\{bottom\}/gi, bottomStr);
    message = message.replace(/\{bbls\}/gi, String(data.bblsTaken || 0));
    message = message.replace(/\{date\}/gi, dateStr);
    message = message.replace(/\{time\}/gi, timeOnlyStr);
    message = message.replace(/\{driverName\}/gi, driverName);

    // Find driver's direct chat threads with dispatch users
    const driverPid = `driver:${driverHash}`;
    const threadsSnap = await firestoreDb.collection('chat_threads')
      .where('type', '==', 'direct')
      .where('participants', 'array-contains', driverPid)
      .get();

    if (threadsSnap.empty) {
      console.log('[LevelChat] No direct threads for driver:', driverHash.slice(0, 8));
      return;
    }

    // Filter to threads where the other participant is a Dashboard user (user:*)
    const dispatchThreads = threadsSnap.docs.filter(d => {
      const participants: string[] = d.data().participants || [];
      return participants.some(p => p.startsWith('user:') && p !== driverPid);
    });

    if (dispatchThreads.length === 0) {
      console.log('[LevelChat] No dispatch threads for driver:', driverHash.slice(0, 8));
      return;
    }

    // Send to each dispatch thread
    const now = admin.firestore.Timestamp.now();
    for (const threadDoc of dispatchThreads) {
      try {
        const batch = firestoreDb.batch();
        const msgRef = firestoreDb.collection('chat_threads').doc(threadDoc.id).collection('messages').doc();
        batch.set(msgRef, {
          text: message,
          senderId: driverPid,
          senderName: driverName,
          timestamp: now,
          type: 'level_report',
          clientId: `level_${Date.now()}_${threadDoc.id.slice(0, 6)}`,
        });
        batch.update(firestoreDb.collection('chat_threads').doc(threadDoc.id), {
          lastMessage: {
            text: message.length > 100 ? message.substring(0, 100) + '...' : message,
            senderId: driverPid,
            senderName: 'Level Report',
            timestamp: now,
            type: 'system',
          },
          updatedAt: now,
        });
        await batch.commit();
        console.log('[LevelChat] Level sent to thread:', threadDoc.id);
      } catch (threadErr) {
        console.warn('[LevelChat] Failed to send to thread', threadDoc.id, threadErr);
      }
    }

    console.log(`[LevelChat] Sent level report for ${data.wellName} to ${dispatchThreads.length} thread(s)`);
  } catch (err) {
    console.error('[LevelChat] Error (non-blocking):', err);
  }
}

// ── onShiftCreate: Create shift thread when driver starts shift ────────────
export const onShiftCreate = functionsV1.firestore
  .document('driver_shifts/{shiftId}')
  .onCreate(async (snap, context) => {
    const shift = snap.data();
    if (!shift) return;

    const driverId = shift.driverId || shift.driverHash || '';
    const driverName = shift.driverName || shift.displayName || 'Driver';
    const companyId = shift.companyId || '';
    if (!driverId || !companyId) return;

    const driverPid = `driver:${driverId}`;
    const { ids: dispatchIds, names: dispatchNames } = await getDispatchParticipants(companyId);

    // Skip thread creation if this company has no dispatchers — otherwise
    // we create a phantom thread with only the driver as a participant,
    // which shows up as a useless self-chat in their drawer.
    if (dispatchIds.length === 0) {
      console.log(`[WBChat] Skipping shift thread for ${driverName} — company ${companyId} has no dispatchers configured`);
      return;
    }

    const participants = [driverPid, ...dispatchIds];
    const participantNames: Record<string, string> = { [driverPid]: driverName, ...dispatchNames };

    const now = admin.firestore.Timestamp.now();
    const threadRef = await firestoreDb.collection('chat_threads').add({
      type: 'shift',
      companyId,
      shiftId: context.params.shiftId,
      title: driverName,
      subtitle: 'Shift',
      participants,
      participantNames,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastRead: {},
    });

    await postSystemMessage(threadRef.id, `${driverName} started their shift`, 'shift_started', { driverName });
    console.log(`[WBChat] Shift thread created: ${threadRef.id} for ${driverName}`);
  });

// ── onShiftUpdate: Archive shift thread when shift ends ────────────────────
export const onShiftUpdate = functionsV1.firestore
  .document('driver_shifts/{shiftId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    if (!after) return;

    // Detect shift end (logoutAt set, or status changed to ended)
    const shiftEnded = (!before.logoutAt && after.logoutAt) || (!before.endedAt && after.endedAt);
    if (!shiftEnded) return;

    // Find the shift thread and archive it
    const threadsSnap = await firestoreDb.collection('chat_threads')
      .where('type', '==', 'shift')
      .where('shiftId', '==', context.params.shiftId)
      .limit(1)
      .get();

    if (!threadsSnap.empty) {
      const threadDoc = threadsSnap.docs[0];
      const driverName = after.driverName || after.displayName || 'Driver';
      await postSystemMessage(threadDoc.id, `${driverName} ended their shift`, 'shift_ended', { driverName });
      await threadDoc.ref.update({ status: 'archived', updatedAt: admin.firestore.Timestamp.now() });
      console.log(`[WBChat] Shift thread archived: ${threadDoc.id}`);
    }
  });

// ── onDispatchCreate: Post to shift thread + create well/group threads ─────
export const onDispatchCreate = functionsV1.firestore
  .document('dispatches/{jobId}')
  .onCreate(async (snap, context) => {
    const job = snap.data();
    if (!job) return;

    const driverHash = job.driverHash || '';
    const driverName = job.driverFirstName || job.driverName || 'Driver';
    const companyId = job.companyId || '';
    const wellName = job.ndicWellName || job.wellName || '';
    if (!driverHash || !companyId) return;

    const driverPid = `driver:${driverHash}`;

    // 1. Post to driver's active shift thread
    const shiftThreads = await firestoreDb.collection('chat_threads')
      .where('type', '==', 'shift')
      .where('participants', 'array-contains', driverPid)
      .where('status', '==', 'active')
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    if (!shiftThreads.empty) {
      const shiftThread = shiftThreads.docs[0];
      const jobType = job.jobType === 'service' ? 'Service Work' : 'Production Water';
      await postSystemMessage(
        shiftThread.id,
        `Job assigned: ${wellName} (${jobType})`,
        'job_assigned',
        { wellName, driverName, jobType },
      );
    }

    // 2. Service group thread
    if (job.serviceGroupId) {
      const existingGroup = await firestoreDb.collection('chat_threads')
        .where('type', '==', 'service_group')
        .where('serviceGroupId', '==', job.serviceGroupId)
        .where('companyId', '==', companyId)
        .limit(1)
        .get();

      if (existingGroup.empty) {
        // Create new service group thread
        const { ids: dispatchIds, names: dispatchNames } = await getDispatchParticipants(companyId);
        const now = admin.firestore.Timestamp.now();
        const threadRef = await firestoreDb.collection('chat_threads').add({
          type: 'service_group',
          companyId,
          serviceGroupId: job.serviceGroupId,
          title: wellName || 'Service Crew',
          subtitle: job.serviceType || 'Service Work',
          participants: [driverPid, ...dispatchIds],
          participantNames: { [driverPid]: driverName, ...dispatchNames },
          status: 'active',
          createdAt: now,
          updatedAt: now,
          lastRead: {},
        });
        await postSystemMessage(threadRef.id, `${driverName} joined the crew`, 'driver_joined', { driverName });
      } else {
        // Add driver to existing group thread
        const threadDoc = existingGroup.docs[0];
        const existing = threadDoc.data();
        if (!existing.participants.includes(driverPid)) {
          await threadDoc.ref.update({
            participants: admin.firestore.FieldValue.arrayUnion(driverPid),
            [`participantNames.${driverPid}`]: driverName,
            updatedAt: admin.firestore.Timestamp.now(),
          });
          await postSystemMessage(threadDoc.id, `${driverName} joined the crew`, 'driver_joined', { driverName });
        }
      }
    }

    // 3. Well thread — create/update when 2+ drivers have active jobs at same well
    if (wellName) {
      const sameWellJobs = await firestoreDb.collection('dispatches')
        .where('wellName', '==', job.wellName)
        .where('companyId', '==', companyId)
        .where('status', 'in', ['pending', 'accepted', 'in_progress'])
        .get();

      // Collect unique driver hashes
      const driverHashes = new Set<string>();
      const driverNames: Record<string, string> = {};
      sameWellJobs.docs.forEach(d => {
        const data = d.data();
        if (data.driverHash) {
          driverHashes.add(data.driverHash);
          driverNames[`driver:${data.driverHash}`] = data.driverFirstName || data.driverName || 'Driver';
        }
      });

      if (driverHashes.size >= 2) {
        const existingWell = await firestoreDb.collection('chat_threads')
          .where('type', '==', 'well')
          .where('wellName', '==', wellName)
          .where('companyId', '==', companyId)
          .where('status', '==', 'active')
          .limit(1)
          .get();

        const { ids: dispatchIds, names: dispatchNames } = await getDispatchParticipants(companyId);
        const allParticipants = [...Array.from(driverHashes).map(h => `driver:${h}`), ...dispatchIds];
        const allNames = { ...driverNames, ...dispatchNames };

        if (existingWell.empty) {
          const now = admin.firestore.Timestamp.now();
          const threadRef = await firestoreDb.collection('chat_threads').add({
            type: 'well',
            companyId,
            wellName,
            title: wellName,
            subtitle: `${driverHashes.size} drivers`,
            participants: allParticipants,
            participantNames: allNames,
            status: 'active',
            createdAt: now,
            updatedAt: now,
            lastRead: {},
          });
          await postSystemMessage(threadRef.id, `${driverHashes.size} drivers at ${wellName}`, 'driver_joined', { wellName });
          console.log(`[WBChat] Well thread created: ${threadRef.id} for ${wellName}`);
        } else {
          // Update participants
          const threadDoc = existingWell.docs[0];
          await threadDoc.ref.update({
            participants: allParticipants,
            participantNames: allNames,
            subtitle: `${driverHashes.size} drivers`,
            updatedAt: admin.firestore.Timestamp.now(),
          });
        }
      }
    }

    console.log(`[WBChat] Dispatch created: ${context.params.jobId} for ${driverName} at ${wellName}`);
  });

// ── onDispatchUpdate: Post status changes to shift thread ──────────────────
export const onDispatchUpdate = functionsV1.firestore
  .document('dispatches/{jobId}')
  .onUpdate(async (change) => {
    const before = change.before.data();
    const after = change.after.data();
    if (!after || !before) return;

    // Only post on status changes
    if (before.status === after.status) return;

    const driverHash = after.driverHash || '';
    const driverName = after.driverFirstName || after.driverName || 'Driver';
    const wellName = after.ndicWellName || after.wellName || '';
    const companyId = after.companyId || '';
    if (!driverHash) return;

    const driverPid = `driver:${driverHash}`;

    // Find driver's active shift thread
    const shiftThreads = await firestoreDb.collection('chat_threads')
      .where('type', '==', 'shift')
      .where('participants', 'array-contains', driverPid)
      .where('status', '==', 'active')
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    if (shiftThreads.empty) return;
    const shiftThreadId = shiftThreads.docs[0].id;

    // Status change messages
    const statusMessages: Record<string, string> = {
      accepted: `${driverName} accepted ${wellName}`,
      in_progress: `${driverName} en route to ${wellName}`,
      completed: `${driverName} completed ${wellName}${after.bbls ? ` — ${after.bbls} BBL` : ''}`,
      declined: `${driverName} declined ${wellName}${after.declineReason ? `: ${after.declineReason}` : ''}`,
      cancelled: `Job cancelled: ${wellName}`,
    };

    const msg = statusMessages[after.status];
    if (msg) {
      await postSystemMessage(shiftThreadId, msg, 'status_change', {
        status: after.status,
        wellName,
        driverName,
        bbls: after.bbls,
      });
    }

    // Archive service group thread when all jobs completed
    if (after.status === 'completed' && after.serviceGroupId) {
      const groupJobs = await firestoreDb.collection('dispatches')
        .where('serviceGroupId', '==', after.serviceGroupId)
        .where('companyId', '==', companyId)
        .get();
      const allDone = groupJobs.docs.every(d => {
        const s = d.data().status;
        return s === 'completed' || s === 'cancelled';
      });
      if (allDone) {
        const groupThreads = await firestoreDb.collection('chat_threads')
          .where('type', '==', 'service_group')
          .where('serviceGroupId', '==', after.serviceGroupId)
          .limit(1)
          .get();
        if (!groupThreads.empty) {
          await groupThreads.docs[0].ref.update({ status: 'archived', updatedAt: admin.firestore.Timestamp.now() });
        }
      }
    }
  });

// ── onProjectWrite: Create/update project thread ───────────────────────────
export const onProjectWrite = functionsV1.firestore
  .document('projects/{projectId}')
  .onWrite(async (change, context) => {
    const after = change.after.exists ? change.after.data() : null;
    if (!after) return; // Deleted

    const companyId = after.companyId || '';
    const projectName = after.name || 'Project';

    // Collect all driver participants
    const driverHashes = new Set<string>();
    (after.dayDriverHashes || []).forEach((h: string) => driverHashes.add(h));
    (after.nightDriverHashes || []).forEach((h: string) => driverHashes.add(h));
    // Also check driverSchedule
    if (after.driverSchedule) {
      Object.values(after.driverSchedule).forEach((hashes: any) => {
        if (Array.isArray(hashes)) hashes.forEach((h: string) => driverHashes.add(h));
      });
    }

    // Look up driver names from RTDB
    const driverNames: Record<string, string> = {};
    for (const hash of driverHashes) {
      const driverSnap = await db.ref(`drivers/approved/${hash}`).once('value');
      const driverData = driverSnap.val();
      if (driverData) {
        const name = driverData.legalName?.split(' ')[0] || driverData.displayName || 'Driver';
        driverNames[`driver:${hash}`] = name;
      }
    }

    const { ids: dispatchIds, names: dispatchNames } = await getDispatchParticipants(companyId);
    const allParticipants = [...Array.from(driverHashes).map(h => `driver:${h}`), ...dispatchIds];
    const allNames = { ...driverNames, ...dispatchNames };

    // Check for existing project thread
    const existing = await firestoreDb.collection('chat_threads')
      .where('type', '==', 'project')
      .where('projectId', '==', context.params.projectId)
      .limit(1)
      .get();

    const now = admin.firestore.Timestamp.now();

    if (existing.empty) {
      // Create project thread
      const threadRef = await firestoreDb.collection('chat_threads').add({
        type: 'project',
        companyId,
        projectId: context.params.projectId,
        title: projectName,
        subtitle: after.serviceType || 'Project',
        participants: allParticipants,
        participantNames: allNames,
        status: after.status === 'completed' ? 'archived' : 'active',
        createdAt: now,
        updatedAt: now,
        lastRead: {},
      });
      await postSystemMessage(threadRef.id, `Project started: ${projectName}`, 'job_assigned', { wellName: projectName });
      console.log(`[WBChat] Project thread created: ${threadRef.id} for ${projectName}`);
    } else {
      // Update participants and status
      const threadDoc = existing.docs[0];
      await threadDoc.ref.update({
        participants: allParticipants,
        participantNames: allNames,
        title: projectName,
        subtitle: `${driverHashes.size} drivers · ${after.serviceType || 'Project'}`,
        status: after.status === 'completed' ? 'archived' : 'active',
        updatedAt: now,
      });

      // Post shift handoff notes as messages
      const before = change.before.exists ? change.before.data() : null;
      if (before && after.updates && after.updates.length > (before.updates?.length || 0)) {
        const newUpdates = after.updates.slice(before.updates?.length || 0);
        for (const update of newUpdates) {
          await postSystemMessage(
            threadDoc.id,
            update.text || update.note || 'Shift update',
            'status_change',
            { driverName: update.author || 'Unknown' },
          );
        }
      }
    }
  });

// ============================================================
// BYOJSA: Parse a JSA PDF using Claude AI
// Extracts steps, hazards, controls, PPE items into structured JSON
// ============================================================

const JSA_EXTRACTION_PROMPT = `You are extracting structured data from a Job Safety Analysis (JSA) document.

Extract the following and return ONLY valid JSON (no markdown fences, no commentary):

{
  "name": "Template name (company name + JSA or the document title)",
  "steps": [
    {
      "id": "kebab-case-id-from-title",
      "title": "Step title exactly as written",
      "items": [
        { "hazard": "All hazards for this step combined into one string", "controls": "All controls for this step combined into one string" }
      ]
    }
  ],
  "ppeItems": [
    { "id": "kebab-case-id", "label": "PPE item name" }
  ],
  "preparedItems": [
    { "id": "kebab-case-id", "label": "Checklist item text" }
  ]
}

Rules:
- Extract ALL steps in document order.
- CRITICAL: Each step should have exactly ONE item in its "items" array. Combine ALL hazards for that step into a single "hazard" string, and ALL controls/recommended actions for that step into a single "controls" string. Use bullet points or newlines to separate multiple items within each string. Do NOT split hazards and controls into separate pairs — keep them together as one block per step, exactly as the original document groups them.
- Extract ALL PPE items mentioned anywhere in the document.
- Extract any "prepared for work", "pre-job checklist", or similar readiness items as preparedItems.
- If no preparedItems are found, use these defaults: [{"id":"trained","label":"I am properly trained for the job"},{"id":"tools-and-ppe","label":"I have the tools & PPE needed for work"},{"id":"sds","label":"SDS"}]
- Generate kebab-case IDs from titles (e.g., "Driving on location" → "driving-on-location").
- Preserve original wording exactly — do not rephrase or summarize.
- Return ONLY the JSON object. No explanation, no markdown.`;

export const parseJsaPdf = httpsV2.onCall(
  { timeoutSeconds: 120, memory: '512MiB' },
  async (request) => {
    const { pdfBase64, fileName, companyId } = request.data as {
      pdfBase64?: string; fileName?: string; companyId?: string;
    };

    if (!pdfBase64 || !companyId) {
      throw new httpsV2.HttpsError('invalid-argument', 'pdfBase64 and companyId are required');
    }

    // Save PDF to Storage using admin SDK (no client-side auth needed)
    const storagePath = `jsa_templates/${companyId}/${fileName || 'jsa.pdf'}`;
    try {
      const bucket = admin.storage().bucket();
      const file = bucket.file(storagePath);
      const buffer = Buffer.from(pdfBase64, 'base64');
      await file.save(buffer, { contentType: 'application/pdf' });
      console.log(`[parseJsaPdf] Saved PDF to ${storagePath} (${buffer.length} bytes)`);
    } catch (err: any) {
      console.error('[parseJsaPdf] Storage save failed:', err.message);
      // Non-fatal — continue with parsing even if storage save fails
    }

    // Call Claude API
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new httpsV2.HttpsError('failed-precondition', 'ANTHROPIC_API_KEY not set in functions/.env file');
    }
    const client = new Anthropic({ apiKey });

    let responseText: string;
    try {
      const message = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
            },
            { type: 'text', text: JSA_EXTRACTION_PROMPT },
          ],
        }],
      });

      const textBlock = message.content.find((b: any) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new Error('No text response from Claude');
      }
      responseText = textBlock.text;
    } catch (err: any) {
      console.error('[parseJsaPdf] Claude API error:', err.message);
      throw new httpsV2.HttpsError('internal', 'AI analysis failed: ' + err.message);
    }

    // Parse JSON response (strip markdown fences if present)
    let parsed: any;
    try {
      let jsonStr = responseText.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      parsed = JSON.parse(jsonStr);
    } catch (err: any) {
      console.error('[parseJsaPdf] JSON parse failed. Raw response:', responseText.substring(0, 500));
      throw new httpsV2.HttpsError('internal', 'Failed to parse AI response as JSON');
    }

    // Validate structure
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      throw new httpsV2.HttpsError('internal', 'AI extraction returned no steps');
    }
    if (!Array.isArray(parsed.ppeItems)) {
      parsed.ppeItems = [];
    }
    if (!Array.isArray(parsed.preparedItems)) {
      parsed.preparedItems = [
        { id: 'trained', label: 'I am properly trained for the job' },
        { id: 'tools-and-ppe', label: 'I have the tools & PPE needed for work' },
        { id: 'sds', label: 'SDS' },
      ];
    }

    console.log(`[parseJsaPdf] Extracted ${parsed.steps.length} steps, ${parsed.ppeItems.length} PPE items for company ${companyId}`);

    return {
      name: parsed.name || 'Custom JSA',
      steps: parsed.steps,
      ppeItems: parsed.ppeItems,
      preparedItems: parsed.preparedItems,
      storagePath,
      storageUrl: `https://storage.googleapis.com/${admin.storage().bucket().name}/${storagePath}`,
    };
  },
);

// ── trackJsaLocation: Add well to jsa_day_status for per_location JSA tracking ──
// Called fire-and-forget from processIncomingPull.
// Maintains a per-driver per-day doc with all locations visited.
// WB T reads this doc to check if a new well needs a JSA.
async function trackJsaLocation(data: PullPacket): Promise<void> {
  try {
    const driverHash = data.driverId;
    const wellName = data.wellName;
    if (!driverHash || !wellName) return;

    // Get driver's companyId to check if JSA mode is enabled
    const driverSnap = await admin.database().ref(`drivers/approved/${driverHash}`).once('value');
    const driverData = driverSnap.val();
    if (!driverData) return;
    const companyId = driverData.companyId;
    if (!companyId) return;

    // Check company's jsaMode — only track if per_location or per_load
    const companyDoc = await firestoreDb.collection('companies').doc(companyId).get();
    const jsaMode = companyDoc.data()?.jsaMode || 'off';
    if (jsaMode === 'off' || jsaMode === 'per_shift') return; // per_shift doesn't need location tracking

    // Build doc ID: {driverHash}_{YYYY-MM-DD}
    const today = new Date().toISOString().slice(0, 10);
    const docId = `${driverHash}_${today}`;

    // Add well to acknowledged locations (arrayUnion = no duplicates)
    await firestoreDb.collection('jsa_day_status').doc(docId).set({
      driverHash,
      driverName: driverData.displayName || driverData.legalName || '',
      companyId,
      date: today,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      locations: admin.firestore.FieldValue.arrayUnion(wellName.toUpperCase()),
    }, { merge: true });

    console.log(`[JsaTrack] Added ${wellName} to jsa_day_status/${docId}`);
  } catch (err) {
    console.warn('[JsaTrack] Failed:', err);
  }
}

// ============================================================
// PHASE 6 — TRUTH LAYER SHADOW ENDPOINTS
// Read-only, admin-gated wrappers around the truth/canonical stack.
// These do NOT replace any existing endpoint. See src/truth/README.md.
// ============================================================
export {
  getIntegratedTruthForDay,
  getDashboardReadModelForDay,
  getRAGIngestBundleForDay,
  getShadowComparisonForDay,
} from './truth/truthWrappers';
export { exportTruthRagForDay } from './truth/truthRagExport';

// ============================================================
// PHASE 7 — FIRST CONTROLLED PRODUCTION READ CONSUMER
// Per-driver day summary derived from the truth/canonical stack.
// The legacy Driver Logs path remains the default; this callable backs a
// Truth/Compare toggle on /admin/driverlogs.
// ============================================================
export { getTruthDriverDaySummary } from './truth/truthDaySummary';

// ============================================================
// PHASE 8 — OPERATIONALIZED DERIVED RAG EXPORT LANE
// Admin-gated list/detail/rerun callables over truth_rag_exports. No new
// scheduler is registered; see truth/truthRagScheduled.ts for the disabled
// template used to promote to a live schedule in a later phase.
// ============================================================
export { listTruthRagExports, getTruthRagExportRun } from './truth/truthRagHistory';
export { rerunTruthRagExportForDay } from './truth/truthRagRerun';

// ============================================================
// PHASE 10 — IDENTITY HEALTH + STABILIZATION VISIBILITY
// Admin-gated read-only surface over canonical operator identity health.
// Pure diagnostics — no fixes, no write behavior, no canonical enforcement.
// ============================================================
export { getIdentityHealthView } from './truth/truthIdentityHealth';

// ============================================================
// PHASE 11 — CANONICAL LOCATION TRUST ADOPTION
// Admin-gated read-only location-health surface. Visibility only — no
// severity scoring, no risk flags, no canonical enforcement. Custom /
// fallback locations remain first-class operational reality.
// ============================================================
export { getLocationHealthView } from './truth/truthLocationHealth';

// ============================================================
// PHASE 17 — MANUAL LOCATION APPROVAL (FIRST WRITE-CAPABLE PATH)
// Admin-gated single-action callable that persists an approval record
// to RTDB (truth_overrides/location_approvals/{scope}/{safeKey}).
// Subsequent getLocationHealthView reads fold this in, overriding the
// derived review disposition and attaching an effectiveConvergence
// block with rule 'manual_approval'. Source truth — canonicalLocations,
// preferredName, aliases — is never modified.
//
// PHASE 19 — adds the paired `revokeTruthLocationApproval` callable.
// Soft-delete (active: false + revoke audit fields), idempotent, same
// admin gate. Revoked records stop participating in read-path
// overrides, letting Phase 18 SWD auto-backing take over where it
// applies.
// ============================================================
export {
  approveTruthLocation,
  revokeTruthLocationApproval,
} from './truth/truthLocationApproval';

// ============================================================
// PHASE 21/22 — SWD REFERENCE RUNTIME CATALOG (MANAGEMENT SURFACE)
// PHASE 21: `addTruthSwdReference` promotes an SWD/disposal name into
// a writable RTDB catalog (truth_reference/swd_catalog/{safeKey}).
// Subsequent getLocationHealthView reads merge this with the static
// seed (shared/truth-layer/data/swdReference.ts).
//
// PHASE 22: adds safe management paths.
//   - `deactivateTruthSwdReference`: soft-delete (active: false +
//     deactivate audit fields). Idempotent. Deactivated entries drop
//     out of the match set on the next shadow read.
//   - `listTruthSwdReference`: admin-gated read of active + inactive
//     runtime entries for the Truth Debug §8 management panel.
//     Runtime entries only — static seed is code-deployed.
// No hard-delete path.
// ============================================================
export {
  addTruthSwdReference,
  deactivateTruthSwdReference,
  listTruthSwdReference,
} from './truth/truthSwdReference';
