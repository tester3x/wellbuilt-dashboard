import {isProvisionalPull,reportedTrackingBottom} from './watchdog/barrelDecision';
import { resolveTankBblPerFoot } from './tankCalibration';
import {refreshFlowWindow} from './refreshFlowWindow';
import {effectiveFlow} from './effectiveFlow';
import * as functionsV1 from 'firebase-functions/v1';
import * as functionsV2 from 'firebase-functions/v2/scheduler';
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { upsertCanonicalJob } from './canonical-jobs/upsertCanonicalJob';
import { logCanonicalDiag } from './canonical-jobs/diag';
import { ANTHROPIC_API_KEY, logRedacted, toSafeProviderError } from './secrets';
import { createAnthropicClient } from './ai/anthropicClient';
import { buildProcessedRecord } from './processedRecord';
import {
  ambiguousEditVerdict,
  comparePullEquivalence,
  editAlreadyApplied,
  editMaterialChange,
  evaluateIncomingPull,
  isStaleRevision,
  orphanEditVerdict,
  packetIdCollisionVerdict,
  quarantineIncomingPacket,
  removeIncomingPacket,
  resolveEditTarget,
  strandedPacketVerdict,
} from './packetGuards';
import {
  buildAppliedEditEvent,
  normalizeEditSource,
  normalizeOriginAppContext,
  resolveEditAuditContext,
  resolveEditEventId,
} from './editHistory';
import { notifyIncomingVersionBestEffort } from './incomingVersionPublish';
import {
  commitPullClaim,
  counterpartStorageKey,
  logicalPullId,
  markPullClaimApplied,
  shouldApplyCrossKeyGuard,
} from './security/operational/crossKeyPullClaim';
import { computePullRevision } from './security/operational/pullCorrectionSignal';
import {
  prepareEditOutbox,
  executeEditOutbox,
  retryStrandedEditRequest,
  reconcileAllPendingOutboxRecords,
  type EditOutboxRecord,
} from './security/operational/editOutbox';


admin.initializeApp();
admin.firestore().settings({ ignoreUndefinedProperties: true });
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

  // Separate edit packets from standard pull packets
  const pullKeys: string[] = [];
  const editKeys: string[] = [];

  for (const key of keys) {
    const data = packets[key];
    if (data && data.requestType === 'edit') {
      editKeys.push(key);
    } else {
      pullKeys.push(key);
    }
  }

  let retriggeredCount = 0;
  let alreadyProcessedCount = 0;

  // Handle stranded edit packets via durable outbox retry instead of quarantining
  for (const key of editKeys) {
    const data = packets[key];
    const match = key.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
    let arrivedAt = now - TWO_MINUTES - 1000;
    if (match) {
      arrivedAt = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`).getTime();
    }
    const age = now - arrivedAt;
    if (age > TWO_MINUTES) {
      console.log(`[Watchdog] ${data.wellName}: re-entering stranded edit packet (${key}, age=${Math.round(age / 1000)}s) via edit outbox`);
      const retryResult = await retryStrandedEditRequest(db, admin.firestore(), key, data);
      if (retryResult.ok) {
        retriggeredCount++;
      } else {
        console.warn(`[Watchdog] ${data.wellName}: failed re-entering stranded edit (${key}):`, retryResult.error);
      }
    }
  }

  // Group pull packets by unique timestamp+well to detect duplicates
  const uniquePackets: Record<string, { key: string; data: any; arrivedAt: number }> = {};
  const arrivedAtByKey: Record<string, number> = {};

  for (const key of pullKeys) {
    const data = packets[key];
    const groupKey = `${data.dateTimeUTC || data.dateTime}_${data.wellName}`;

    // Estimate arrival time from packetId (format: YYYYMMDD_HHMMSS_...)
    const match = key.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
    let arrivedAt = now - TWO_MINUTES - 1000; // Default: assume old enough
    if (match) {
      arrivedAt = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`).getTime();
    }
    arrivedAtByKey[key] = arrivedAt;

    // Keep only first occurrence of each unique packet
    if (!uniquePackets[groupKey] || arrivedAt < uniquePackets[groupKey].arrivedAt) {
      uniquePackets[groupKey] = { key, data, arrivedAt };
    }
  }

  // Quarantine duplicates and re-trigger unique ones that are old enough
  const allPullKeys = new Set(pullKeys);
  const keepKeys = new Set(Object.values(uniquePackets).map(p => p.key));
  const duplicateKeys = [...allPullKeys].filter(k => !keepKeys.has(k));

  // GS3 follow-up: "duplicates" are grouped only by dateTimeUTC+well and can
  // be DISTINCT legitimate submissions (the real 8:32 PM twins differed in
  // BBLs but shared the group key). Never delete them — quarantine
  // losslessly; a failed quarantine leaves the packet in incoming.
  if (duplicateKeys.length > 0) {
    console.log(`[Watchdog] Quarantining ${duplicateKeys.length} duplicate-grouped packets`);
    for (const key of duplicateKeys) {
      await quarantineIncomingPacket(db.ref(), {
        packetId: key,
        packet: packets[key],
        verdict: strandedPacketVerdict({
          ageMs: now - arrivedAtByKey[key],
          context: `duplicate-grouped incoming packet (same dateTimeUTC+well as retained key); may be a distinct legitimate submission`,
        }),
        nowMs: now,
      });
    }
  }

  // Check which unique pull packets are stranded (older than 2 minutes)
  const strandedPackets = Object.values(uniquePackets).filter(p => {
    const age = now - p.arrivedAt;
    return age > TWO_MINUTES;
  });

  if (strandedPackets.length === 0 && editKeys.length === 0) {
    console.log(`[Watchdog] No stranded packets (${Object.keys(uniquePackets).length} pending, all recent)`);
    return;
  }

  console.log(`[Watchdog] Found ${strandedPackets.length} stranded pull packets - checking`);

  // Delete and re-write each stranded packet to re-trigger onCreate
  for (const packet of strandedPackets) {
    const { key, data } = packet;

    // Skip delete packets — they are handled by their own Cloud Functions
    if (data.requestType === 'delete') {
      console.log(`[Watchdog] ${data.wellName}: skipping ${data.requestType} packet (${key}), quarantining`);
      await quarantineIncomingPacket(db.ref(), {
        packetId: key,
        packet: data,
        verdict: strandedPacketVerdict({
          ageMs: now - packet.arrivedAt,
          context: `stranded ${data.requestType} packet — handled by its own function and never watchdog-retriggered; its handler did not consume it`,
        }),
        nowMs: now,
      });
      alreadyProcessedCount++;
      continue;
    }

    // FIX: Check if this packet was already processed before re-triggering.
    // Race condition: if processIncomingPull was slow (cold start), the packet
    // may still be in incoming/ even though it was already processed + outgoing written.
    // Re-triggering would cause processIncomingPull to run AGAIN, overwriting any
    // edits that were applied to the outgoing in between.
    const processedSnap = await db.ref(`packets/processed/${key}`).once('value');
    const logicalId = logicalPullId(key);
    const claimSnap = logicalId
      ? await db.ref(`packets/pull_claims/${logicalId}`).once('value')
      : null;
    const claim = claimSnap?.val() || null;
    const counterpartSnap = logicalId
      ? await db.ref(`packets/processed/${counterpartStorageKey(key)}`).once('value')
      : null;
    if (processedSnap.exists() || counterpartSnap?.exists() || (claim && claim.phase === 'applied' && claim.winnerKey !== key)) {
      console.log(`[Watchdog] ${data.wellName}: pull already claimed (${key}), cleaning up stale incoming`);
      await db.ref(`packets/incoming/${key}`).remove();
      alreadyProcessedCount++;
      continue;
    }
    if (claim && claim.winnerKey === key && claim.phase === 'claimed') {
      if (typeof claim.executionUntilMs === 'number' && claim.executionUntilMs > Date.now()) {
        continue;
      }
      await db.ref(`packets/incoming/${key}`).set(null);
      await db.ref(`packets/incoming/${key}`).set(data);
      console.log(`[Watchdog] Retriggered same pull key after lease expiry: ${key}`);
      retriggeredCount++;
      continue;
    }
    if (claim && claim.winnerKey && claim.winnerKey !== key) {
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

    // Re-key to trigger onCreate
    data.packetId = newKey;
    data.requestType = data.requestType || 'pull';
    data._retriggeredBy = 'watchdog';
    data._retriggeredAt = new Date().toISOString();
    data._originalKey = key; // Track original key for debugging

    // GS3 follow-up: remove-old + write-new as ONE atomic multi-location
    // update — the old delete-then-set left a crash window where the packet
    // vanished entirely. Both writes commit or neither does.
    await db.ref().update({
      [`packets/incoming/${key}`]: null,
      [`packets/incoming/${newKey}`]: data,
    });
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
    status: 'ok',
  });
});

// ============================================================
// EDIT OUTBOX RECONCILIATION: Runs every 5 minutes, sweeps
// any pending or stranded edit outbox records across the system
// ============================================================
export const reconcilePendingEditOutbox = functionsV2.onSchedule('every 5 minutes', async (event) => {
  console.log('[reconcilePendingEditOutbox] Running scheduled edit outbox sweep...');
  const outcome = await reconcileAllPendingOutboxRecords(db, admin.firestore());
  console.log(
    `[reconcilePendingEditOutbox] Sweep complete: checked=${outcome.checked}, reconciled=${outcome.reconciled}, failed=${outcome.failed}`,
  );
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
  loadLine: 0, // feet — universal anti-negative display floor; per-well override via well_config.loadLine
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
  /** Recovery provenance: when a corrected replacement pull is submitted to
   *  recover a losslessly-quarantined original (Mechanism A), this carries the
   *  ORIGINAL rejected packetId. It is a passthrough field — preserved onto the
   *  processed record so the recovery runner + audit can correlate. */
  recoveredFromPacketId?: string;
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
  lastPullRevision?: string | null;
  companyId?: string;
}

function outgoingCompanyId(config: { companyId?: unknown } | null | undefined): string {
  const cid = typeof config?.companyId === 'string' ? config.companyId.trim() : '';
  return cid || 'liquid-gold';
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
  provisional?: boolean;
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
        provisional: isProvisionalPull(packet),
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
    if (current.wellDown || previous.wellDown || current.provisional || previous.provisional) continue;

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
  if (firstPullToday.wellDown || lastPullPrevDay.wellDown || firstPullToday.provisional || lastPullPrevDay.provisional) return 0;

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

// Filter out anomalies (2x+ off median) from flow rates.
// Uses two passes plus a regime-shift escape:
//   1. Progressive median — catches outliers as they appear, lets the well's
//      baseline drift over time (handles legitimate regime changes when paired
//      with step detection downstream).
//   1b. Regime-shift detection — if the LAST N pulls were all rejected as Tier-2
//       anomalies in the SAME direction, the baseline itself is stale (e.g. a
//       fresh-tank start followed by a long lapse, pump replacement, or workover).
//       Reseed from the rejection run as the new baseline and recurse. Mirrors
//       the step detector at lines ~755-778 but operates on rates that filtered
//       OUT, which the step detector can't see.
//   2. Final pass with the OVERALL median of pass-1 results — catches early
//      outliers that were grandfathered in before there was enough baseline
//      data (matches the dashboard's anomaly badges so AFR and the UI agree).
// Returns rates with Tier 2 anomalies removed.
const REGIME_SHIFT_THRESHOLD = 3;
function filterAnomalies(flowRates: number[]): number[] {
  if (flowRates.length < 3) {
    return flowRates;
  }

  // Pass 1: progressive (also tracks rejection direction for regime-shift detection)
  const knownRates: number[] = [];
  const passOne: number[] = [];
  // 0 = accepted, +1 = rejected as higher than baseline, -1 = rejected as lower
  const directions: number[] = [];
  for (const rate of flowRates) {
    if (knownRates.length >= 3) {
      const medianRate = median(knownRates);
      const level = getFlowRateAnomalyLevel(rate, medianRate);
      if (level < 2) {
        passOne.push(rate);
        knownRates.push(rate);
        directions.push(0);
      } else {
        directions.push(rate > medianRate ? 1 : -1);
      }
    } else {
      // Not enough baseline yet — include for now; pass 2 will re-check.
      passOne.push(rate);
      knownRates.push(rate);
      directions.push(0);
    }
  }

  // Pass 1b: regime-shift escape. Scan tail for consecutive same-direction
  // Tier-2 rejections. If we find a run of REGIME_SHIFT_THRESHOLD or more,
  // the baseline is stale — reseed from the rejection run and recurse.
  let runDir = 0;
  let runStart = -1;
  for (let i = directions.length - 1; i >= 0; i--) {
    const d = directions[i];
    if (d === 0) break;
    if (runDir === 0) runDir = d;
    if (d !== runDir) break;
    runStart = i;
  }
  if (runStart >= 0 && (directions.length - runStart) >= REGIME_SHIFT_THRESHOLD) {
    console.log(`[AFR] regime shift detected: ${directions.length - runStart} consecutive ${runDir > 0 ? 'slower' : 'faster'} rejections, reseeding from index ${runStart}`);
    return filterAnomalies(flowRates.slice(runStart));
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

  const flowConfig=(await db.ref('well_config/'+wellName).once('value')).val()||{};
  const windowed=effectiveFlow(snapshot.val()||{},flowConfig);
  if(windowed)return windowed.averageDays;

  // Collect rates with timestamps, sort by actual time, take most recent 15
  const rateEntries: { timestamp: number; rate: number }[] = [];

  snapshot.forEach((child) => {
    const data = child.val();
    const key = child.key || '';
    // Skip edit/delete/history packets
    if (key.startsWith('edit_') || key.startsWith('delete_') || key.startsWith('history_') || isProvisionalPull(data)) return;
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
    const bblPerFoot = Number(data.tankLevelFeet) > 0 ? resolveTankBblPerFoot(config) : 0;
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

        // ─── Exact-ID idempotency — BEFORE every future/stale guard ─────────
    // WB-M retries with STABLE ids: a replay of an id already in
    // packets/processed is an idempotent retry of a successful operation,
    // not stale data. Never re-process/enrich, never quarantine it.
    const alreadyProcessedSnap = await db.ref(`packets/processed/${packetId}`).once('value');
    if (alreadyProcessedSnap.exists()) {
      const alreadyProcessed = alreadyProcessedSnap.val();
      const equivalence = comparePullEquivalence(data as any, alreadyProcessed);
      if (equivalence.equivalent) {
        console.log(`[IDEMPOTENT_REPLAY_ALREADY_PROCESSED] ${wellName}: ${packetId} — duplicate incoming removed; processed record stands`);
        // The positive outcome WB-M reconciles against IS the existing
        // packets/processed/<id> record (its reconciler reads that path
        // directly). Deliberately NOT rewriting packets/outgoing here:
        // outgoing carries the well's LATEST pull, and recreating a
        // response for an older replayed id would regress
        // lastPullDateTimeUTC and re-arm the stale guard against newer
        // pulls — the exact GS3 failure shape.
        await removeIncomingPacket(db.ref(), packetId);
        return null;
      }
      console.log(`[QUARANTINE] ${wellName}: PACKET_ID_COLLISION — ${equivalence.differences.join('; ')}`);
      await quarantineIncomingPacket(db.ref(), {
        packetId,
        packet: data,
        verdict: packetIdCollisionVerdict(equivalence.differences),
        nowMs: Date.now(),
      });
      return null;
    }

    // Same physical pull may also arrive under the idem_ storage key.
    // Claim that identity before any well, outgoing, performance, or
    // canonical-job write. The loser is retired; a conflicting payload
    // is quarantined and does not replace the winner.
    if (shouldApplyCrossKeyGuard(reqType)) {
      const logicalId = logicalPullId(packetId);
      if (logicalId) {
        const outcome = await commitPullClaim(db.ref(`packets/pull_claims/${logicalId}`), {
          storageKey: packetId,
          companyId: (data as any).companyId || null,
          driverId: data.driverId || null,
          wellName,
          bblsTaken: data.bblsTaken,
          tankLevelFeet: data.tankLevelFeet,
        });
        if (outcome === 'busy') {
          console.log(`[CROSS_KEY_BUSY] ${logicalId}: execution lease held`);
          return null;
        }
        if (outcome === 'retire') {
          console.log(`[CROSS_KEY_RETIRE] ${logicalId}: ${packetId} already claimed`);
          await removeIncomingPacket(db.ref(), packetId);
          return null;
        }
        if (outcome === 'conflict' || outcome === 'cross_tenant') {
          await quarantineIncomingPacket(db.ref(), {
            packetId,
            packet: data,
            verdict: {
              action: 'quarantine',
              reason: outcome === 'cross_tenant' ? 'CROSS_KEY_TENANT' : 'CROSS_KEY_CONFLICT',
              readableReason: outcome === 'cross_tenant'
                ? 'Counterpart pull belongs to a different company or driver. Incoming held; winner unchanged.'
                : 'Counterpart pull has different well, barrels, or tank level. Incoming held; winner unchanged.',
              comparedWatermarkUTC: null,
            },
            nowMs: Date.now(),
          });
          return null;
        }
      }
    }

    // ─── GS3 7/21/2026 guards: future-time + lossless quarantine ────────
    // A pull entered as 11:07 PM instead of 11:07 AM became this well's
    // outgoing watermark; five legitimate packets then compared "stale"
    // against the poisoned value and were irrecoverably deleted here.
    // Replaces the old [STALE] `snapshot.ref.remove()`: every rejection —
    // future incoming time, future-poisoned watermark, or genuine staleness
    // — now lands in packets/rejected via ONE atomic update, BEFORE any
    // well state (isDown, outgoing, processed, performance, production,
    // wellStatus, enrichment) is touched. A failed quarantine write leaves
    // the incoming packet intact for retry. See packetGuards.ts.
    const guardVerdict = evaluateIncomingPull({
      incomingDateTimeUTC: data.dateTimeUTC,
      hasOutgoingResponse: prevResponse !== null,
      watermarkDateTimeUTC: prevResponse ? prevResponse.lastPullDateTimeUTC : undefined,
      nowMs: Date.now(),
    });
    if (guardVerdict.action === 'quarantine') {
      console.log(`[QUARANTINE] ${wellName}: ${guardVerdict.reason} — ${guardVerdict.readableReason}`);
      if (guardVerdict.reason === 'STALE_PULL_TIME' && prevResponse.isEdit) {
        console.log(`[QUARANTINE] ${wellName}: outgoing has isEdit=true — processing would have overwritten the edit`);
      }
      await quarantineIncomingPacket(db.ref(), {
        packetId,
        packet: data,
        verdict: guardVerdict,
        nowMs: Date.now(),
      });
      return null;
    }

    // ─── wellDown authoritative-write protection (5/8/2026) ─────────────
    // Pull ≠ Reactivate. Routine WB T pulls hardcode wellDown=false in the
    // packet (utils/firebase.ts:2529, 2584); without this guard, every
    // WB T pull clobbered an admin-marked-down well back to active. Field-
    // confirmed Gabriel 7 5/7/2026: well marked down at 14:06 UTC, flipped
    // back to active by Mike's 15:54 pull packet at the CF processedAt.
    //
    // Only an explicit authoritative signal (wellDownIsAuthoritative=true
    // accompanied by a boolean wellDown field) is allowed to flip isDown.
    // Non-authoritative packets — including all WB T pulls and any legacy
    // client that doesn't set the authority flag — preserve the existing
    // isDown value. Mark-down + (future) clear-down both come from
    // dashboard with the authority flag set; field clients are non-
    // authoritative by default.
    const incomingHasAuthoritativeWellDown =
      (data as any).wellDownIsAuthoritative === true &&
      typeof (data as any).wellDown === 'boolean';
    const existingIsDownSnap = await db.ref(`wells/${wellName}/status/isDown`).once('value');
    const existingIsDown = existingIsDownSnap.val() === true;
    const nextIsDown = incomingHasAuthoritativeWellDown
      ? ((data as any).wellDown === true)
      : existingIsDown;

    // Immediately update down/up status so the app reflects the change
    // before the heavy AFR/bbls calculations finish
    await db.ref(`wells/${wellName}/status/isDown`).set(nextIsDown);
    if (incomingHasAuthoritativeWellDown) {
      const targetConfigKey = configSnap.key || wellName;
      await db.ref(`well_config/${targetConfigKey}/isDown`).set(nextIsDown);
    }

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

    const bblsInInches = data.bblsTaken > 0 ? (data.bblsTaken / bblPerFoot) * 12 : 0;
    let tankAfterInches = reportedTrackingBottom(data,tankTopInches) ?? (tankTopInches - bblsInInches);
    const reportedBottom=Number((data as any).watchdogProvenance?.reportedBottomFeet)*12;
    if(config.flowWindowMinimumRecoveryInches && (data as any).source==='whatsapp_watchdog' && (data as any).watchdogProvenance?.principalId==='laptop-watchdog-v2' && (data as any).watchdogProvenance?.reportedBottomFeet!=null && Number.isFinite(reportedBottom) && reportedBottom>=0 && reportedBottom<=tankTopInches && Math.abs(reportedBottom-tankAfterInches)<=2)tankAfterInches=reportedBottom;

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

    if(isProvisionalPull(data)||prevResponse?.provisionalBarrels===true){flowRateDays=0;flowRate='';}
    const flowHistorySnap=Number(config.flowWindowMinimumRecoveryInches)>=3
      ? await db.ref('packets/processed').orderByChild('wellName').equalTo(wellName).once('value') : null;
    const windowed=flowHistorySnap&&!isProvisionalPull(data)?effectiveFlow({...flowHistorySnap.val(),[packetId]:{...data,packetId,tankTopInches,tankAfterInches,wellDown:nextIsDown}},config):null;
    if(windowed){const sample=windowed.results.find(r=>r.packetId===packetId);flowRateDays=sample?.flowRateDays||0;flowRate=flowRateDays>0?daysToHMMSS(flowRateDays):'';recoveryInches=sample?.recoveryInches||0;timeDifDays=sample?.timeDifDays||0;timeDif=timeDifDays>0?daysToHMM(timeDifDays):'';}
    const afr = isProvisionalPull(data)?(Number(config.avgFlowRateMinutes)/1440||await calculateAFR(wellName,0)):(windowed?windowed.averageDays:await calculateAFR(wellName, flowRateDays));

    // Calculate window-averaged and overnight bbls/day
    // bblPerFoot is the configured total active bank calibration.
    const historicalPulls = await getHistoricalPulls(wellName, 500);
    const pullTimeMs = new Date(data.dateTimeUTC).getTime();

    // Include current pull in historical data — it's not in packets/processed yet
    historicalPulls.push({
      key: packetId,
      timestamp: pullTimeMs,
      tankLevelFeet: parseFloat(String(data.tankLevelFeet)) || 0,
      bblsTaken: parseFloat(String(data.bblsTaken)) || 0,
      wellDown: data.wellDown === true || data.wellDown === ('true' as any),
      provisional: isProvisionalPull(data),
    });
    historicalPulls.sort((a, b) => a.timestamp - b.timestamp);

    const windowBblsDay = windowed ? 0 : calculateWindowBblsPerDay(historicalPulls, bblPerFoot, pullTimeMs);
    const overnightBblsDay = windowed ? 0 : calculateOvernightBblsPerDay(historicalPulls, bblPerFoot, pullTimeMs);
    console.log(`[BblsDay] ${wellName}: window=${windowBblsDay} overnight=${overnightBblsDay}`);

    // Recovery Needed
    const pullHeightInches = (pullBbls / bblPerFoot) * 12;
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

    const initialFlowRate = afr > 0 ? daysToHMMSS(afr) : 'Unknown';
    const initialBottomFI = inchesToFeetInches(tankAfterInches);
    const initialRevision = afr > 0
      ? computePullRevision(packetId, initialBottomFI, data.dateTimeUTC, initialFlowRate)
      : null;

    // Build processed packet with all calculated fields, then strip client
    // trail-only helpers — extracted to buildProcessedRecord (behavior-
    // preserving). The `...data` spread preserves passthrough fields, incl.
    // recoveredFromPacketId (Mechanism A recovery provenance), onto the record.
    const processedClean = buildProcessedRecord(data as unknown as Record<string, unknown>, {
      packetId,
      tankTopInches,
      tankAfterInches,
      tankAfterFeet: initialBottomFI,
      timeDif,
      timeDifDays,
      recoveryInches,
      flowRate,
      flowRateDays,
      recoveryNeeded,
      estTimeToPull,
      estDateTimePull,
      processedAt: new Date().toISOString(),
      lastPullRevision: initialRevision,
    });
    await db.ref(`packets/processed/${packetId}`).set(processedClean);

    // Materialize queued post-Send correction trail (product: Send is the edit boundary).
    await materializeQueuedEditTrail(packetId, data as any);

    // Calculate current level (for outgoing response)
    // At time of pull, current level = tank after
    // This will be updated by a scheduled function to reflect growth over time
    const currentLevelInches = tankAfterInches;

    // BBLs per 24 hours
    let bbls24hrs = '0';
    if (afr > 0) {
      const bbls24 = (1 / afr) * bblPerFoot;
      bbls24hrs = Math.round(bbls24).toString();
    }

    // Build outgoing response
    const timestamp = new Date();
    const outgoingResponse: OutgoingResponse = {
      wellName,
      currentLevel: inchesToFeetInches(currentLevelInches),
      flowRate: initialFlowRate,
      ...({provisionalBarrels:isProvisionalPull(data),flowRateMeasuredAtUTC:isProvisionalPull(data)||prevResponse?.provisionalBarrels===true?(prevResponse?.flowRateMeasuredAtUTC||prevResponse?.lastPullDateTimeUTC||''):data.dateTimeUTC} as any),
      bbls24hrs,
      timeTillPull: nextIsDown ? 'Down' : (estTimeToPull || 'Calculating...'),
      nextPullTime: estDateTimePull ? formatLocalDateTime(new Date(estDateTimePull)) : 'Unknown',
      nextPullTimeUTC: estDateTimePull,
      lastPullDateTime: data.dateTime || formatLocalDateTime(new Date(data.dateTimeUTC)),
      lastPullDateTimeUTC: data.dateTimeUTC,
      lastPullBbls: data.bblsTaken.toString(),
      lastPullTopLevel: inchesToFeetInches(tankTopInches),
      lastPullBottomLevel: initialBottomFI,
      lastPullDriverId: data.driverId || null,
      lastPullDriverName: data.driverName || null,
      lastPullPacketId: packetId,
      lastPullRevision: initialRevision,
      wellDown: nextIsDown,
      companyId: outgoingCompanyId(config),
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
        ...(typeof data.driverName === 'string' ? { driverName: data.driverName } : {}),
        packetId,
      },
      calculated: {
        flowRate: afr > 0 ? daysToHMMSS(afr) : 'Unknown',
        flowRateMinutes: Math.round(afrMinutes * 100) / 100,
        ...({provisionalBarrels:isProvisionalPull(data),flowRateMeasuredAtUTC:isProvisionalPull(data)||prevResponse?.provisionalBarrels===true?(prevResponse?.flowRateMeasuredAtUTC||prevResponse?.lastPullDateTimeUTC||''):data.dateTimeUTC} as any),
        bbls24hrs: parseInt(bbls24hrs) || 0,
        nextPullTime: estDateTimePull ? formatLocalDateTime(new Date(estDateTimePull)) : 'Unknown',
        nextPullTimeUTC: estDateTimePull || '',
        timeTillPull: nextIsDown ? 'Down' : (estTimeToPull || 'Calculating...'),
      },
      isDown: nextIsDown,
      updatedAt: new Date().toISOString(),
    };

    // Write to wells/{wellName}/status (THE source of truth)
    await db.ref(`wells/${wellName}/status`).set(wellStatus);

    console.log(`[NEW] Wrote wells/${wellName}/status`);
    await refreshFlowWindow(db,wellName);

    await notifyIncomingVersionBestEffort(db.ref('packets/incoming_version'), {
      outgoingCommitted: true,
      pullAccepted: true,
    });

    // Write production log (AFR + window + overnight bbls/day for comparison)
    const afrBblsDay = afr > 0 ? Math.round((1 / afr) * bblPerFoot) : 0;
    await writeProductionLog(wellName, pullTimeMs, afrBblsDay, windowBblsDay, overnightBblsDay);

    // ── Canonical-completion receipt ──────────────────────────────────────
    // The sequential write chain above (processed → outgoing/current →
    // performance → AFR/config → wells/status → production) is NOT atomic. This
    // final marker is written ONLY after every required canonical write for this
    // pull has succeeded, so it — not the EARLY processed-row existence — is the
    // authoritative completion signal. Recovery annotation + WB-M reconciliation
    // gate on this receipt; a crash anywhere above leaves processed present WITHOUT
    // the marker, i.e. an explicit "processed-but-incomplete" state. Anything
    // below (canonical_jobs / Firestore back-patch) is best-effort and advisory.
    await db.ref(`packets/processed/${packetId}`).update({
      canonicalProcessingComplete: true,
      canonicalProcessingBottomInches: tankAfterInches,
      canonicalProcessingCompletedAt: admin.database.ServerValue.TIMESTAMP,
    });
    if (shouldApplyCrossKeyGuard(reqType)) {
      const logicalId = logicalPullId(packetId);
      if (logicalId) {
        await db.ref(`packets/pull_claims/${logicalId}`).transaction((current) => {
          if (!current) return;
          return markPullClaimApplied(current, packetId) || current;
        });
      }
    }

    // ── canonical_jobs + Phase 1.2 server-side back-patch ─────────────────
    // Best-effort. Failure here never blocks packet processing — canonical_jobs
    // has no readers in Phase 1, and the Firestore back-patches are advisory
    // (client also writes invoice.packetId locally as belt-and-suspenders).
    //
    // Phase 1.2 adds: read context fields (invoiceDocId, dispatchId, companyId,
    // invoicingMode, originAppContext) from the packet; pass into the canonical
    // upsert; back-patch invoices/{invoiceDocId} + dispatches/{dispatchId}.
    try {
      // Phase 1.2 — pull context fields stamped by WB T client
      // (sendWbMobileTankPacket / submitTicket relay). All optional —
      // WB M-originated packets won't have these.
      const ctxInvoiceDocId =
        typeof (data as any).invoiceDocId === 'string' ? (data as any).invoiceDocId : null;
      const ctxDispatchId =
        typeof (data as any).dispatchId === 'string' ? (data as any).dispatchId : null;
      const ctxCompanyId =
        typeof (data as any).companyId === 'string' ? (data as any).companyId : null;
      const ctxInvoicingMode =
        typeof (data as any).invoicingMode === 'string' ? (data as any).invoicingMode : null;
      const ctxOriginAppContext =
        (data as any).originAppContext === 'wbt' ? 'wbt' : 'wbm';

      // Resolve companyId — prefer packet-supplied, fall back to driver lookup.
      let driverCompanyId: string | null = ctxCompanyId;
      if (!driverCompanyId && data.driverId) {
        try {
          const driverSnap = await db
            .ref(`drivers/approved/${data.driverId}/companyId`)
            .once('value');
          if (driverSnap.exists()) {
            driverCompanyId = String(driverSnap.val());
          }
        } catch {
          // best-effort only
        }
      }

      const bblsNum =
        typeof data.bblsTaken === 'number'
          ? data.bblsTaken
          : parseFloat(String(data.bblsTaken)) || null;
      const tankLevelFeetNum = parseFloat(String(data.tankLevelFeet)) || null;
      const tankAfterFeetNum = tankAfterInches > 0 ? tankAfterInches / 12 : null;

      const result = await upsertCanonicalJob(
        {
          packetId,
          // Phase 1.2 — link invoice/dispatch at create time when context present
          invoiceDocId: ctxInvoiceDocId,
          dispatchId: ctxDispatchId,
          companyId: driverCompanyId,
          driverHash: data.driverId ?? null,
          driverName: data.driverName ?? null,
          wellName,
          wellConfigKey: wellName,
          bblsTaken: bblsNum,
          tankLevelFeet: tankLevelFeetNum,
          tankAfterFeet: tankAfterFeetNum,
          dateTimeUTC: data.dateTimeUTC ?? null,
          // Source = origin app context (wbt vs wbm). Defaults wbm for legacy
          // WB M-direct packets that don't carry the context fields.
          source: ctxOriginAppContext,
        },
        {
          type: 'packet_sent',
          actorDriverHash: data.driverId ?? null,
          actorSource: ctxOriginAppContext,
          extra: {
            packetId,
            wellName: wellName ?? null,
            bbls: bblsNum,
            invoiceDocId: ctxInvoiceDocId,
            dispatchId: ctxDispatchId,
            invoicingMode: ctxInvoicingMode,
          },
        },
      );

      if (result.missingCompanyId) {
        await logCanonicalDiag({
          level: 'warn',
          source: 'cf',
          event: 'canonical.job_missing_companyId',
          payload: {
            canonicalJobId: result.canonicalJobId,
            packetId,
            wellName: wellName ?? null,
            callsite: 'processIncomingPull',
          },
        });
      }

      // ── Phase 1.2 back-patch: invoices/{invoiceDocId} ─────────────────
      if (ctxInvoiceDocId) {
        try {
          const fs = admin.firestore();
          await fs.collection('invoices').doc(ctxInvoiceDocId).update({
            packetId,
            canonicalJobId: result.canonicalJobId,
            packetProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
            packetDateTimeUTC: data.dateTimeUTC ?? null,
            packetSnapshot: {
              bblsTaken: bblsNum,
              tankLevelFeet: tankLevelFeetNum,
              wellName: wellName ?? null,
            },
          });
          await logCanonicalDiag({
            level: 'info',
            source: 'cf',
            event: 'canonical.invoice_patched',
            payload: {
              invoiceDocId: ctxInvoiceDocId,
              packetId,
              canonicalJobId: result.canonicalJobId,
              callsite: 'processIncomingPull',
            },
          });
        } catch (invErr) {
          // Most common cause: invoice was deleted between depart and
          // packet processing (driver cancelled the job). Non-fatal.
          await logCanonicalDiag({
            level: 'warn',
            source: 'cf',
            event: 'canonical.invoice_patch_skipped',
            payload: {
              invoiceDocId: ctxInvoiceDocId,
              packetId,
              message: String((invErr as Error)?.message || invErr).slice(0, 200),
              callsite: 'processIncomingPull',
            },
          });
        }
      }

      // ── Phase 1.2 back-patch: dispatches/{dispatchId} ─────────────────
      if (ctxDispatchId) {
        try {
          const fs = admin.firestore();
          const dispPatch: Record<string, any> = {
            lastPullPacketId: packetId,
            lastPullPacketAt: admin.firestore.FieldValue.serverTimestamp(),
            canonicalJobId: result.canonicalJobId,
            // Multi-load history — arrayUnion is idempotent on reprocess.
            pullPacketIds: admin.firestore.FieldValue.arrayUnion(packetId),
          };
          if (initialRevision) {
            dispPatch.lastPullRevision = initialRevision;
            dispPatch.lastPullBottomLevel = initialBottomFI;
            dispPatch.lastPullDateTimeUTC = data.dateTimeUTC;
            dispPatch.flowRate = initialFlowRate;
            dispPatch.lastPullCorrection = {
              packetId,
              revision: initialRevision,
              bottomLevel: initialBottomFI,
              pullDateTimeUTC: data.dateTimeUTC,
              flowRate: initialFlowRate,
              publishedAt: admin.firestore.FieldValue.serverTimestamp(),
              publishedAtMs: Date.now(),
              wellName,
              companyId: driverCompanyId,
              driverId: data.driverId || null,
            };
          }
          await fs.collection('dispatches').doc(ctxDispatchId).update(dispPatch);
          await logCanonicalDiag({
            level: 'info',
            source: 'cf',
            event: 'canonical.dispatch_patched',
            payload: {
              dispatchId: ctxDispatchId,
              packetId,
              canonicalJobId: result.canonicalJobId,
              callsite: 'processIncomingPull',
            },
          });
        } catch (dispErr) {
          await logCanonicalDiag({
            level: 'warn',
            source: 'cf',
            event: 'canonical.dispatch_patch_skipped',
            payload: {
              dispatchId: ctxDispatchId,
              packetId,
              message: String((dispErr as Error)?.message || dispErr).slice(0, 200),
              callsite: 'processIncomingPull',
            },
          });
        }
      }
    } catch (err) {
      console.warn(
        '[canonical_jobs] processIncomingPull upsert failed:',
        (err as Error)?.message || err,
      );
      try {
        await logCanonicalDiag({
          level: 'error',
          source: 'cf',
          event: 'canonical.job_upsert_failed',
          payload: {
            packetId,
            wellName: wellName ?? null,
            message: String((err as Error)?.message || err).slice(0, 200),
            callsite: 'processIncomingPull',
          },
        });
      } catch {
        // never throw from a logger
      }
    }

    // Delete from incoming/
    await snapshot.ref.remove();

    console.log(`Processed ${wellName}: ${packetId} -> ${responseId}`);

    // Await chat + JSA tracking — 1st gen CFs can kill fire-and-forget promises after return.
    // These are fast Firestore writes, adds ~1-2s to packet processing but guarantees delivery.
    try {
      await Promise.all([
        sendLevelToChat(data, packetId, { tankAfterInches, tanks, bblPerFoot }).catch(err => console.warn('[LevelChat] Send failed:', err)),
        trackJsaLocation(data).catch(err => console.warn('[JsaTrack] Tracking failed:', err)),
      ]);
    } catch (err) {
      console.warn('[PostProcess] Parallel tasks failed:', err);
    }

    return null;
  });

/**
 * When a pull was corrected after Send while still queued, WB-M stamps
 * pendingEditEvents on the payload. On first process, materialize those as
 * canonical editHistory events + editedAt/editCount so the row never looks
 * never-edited. Idempotent per eventId.
 */
async function materializeQueuedEditTrail(
  packetId: string,
  data: Record<string, any>,
): Promise<void> {
  const pending = data.pendingEditEvents;
  if (!Array.isArray(pending) || pending.length === 0) return;

  const nowIso = new Date().toISOString();
  const originalSubmissionAt =
    (typeof data.originalSubmittedAt === 'string' && data.originalSubmittedAt) ||
    (typeof data.dateTimeUTC === 'string' && data.dateTimeUTC) ||
    nowIso;

  const multi: Record<string, unknown> = {};
  let seq = 0;
  for (const raw of pending) {
    if (!raw || typeof raw !== 'object') continue;
    const eventId = resolveEditEventId({
      incomingPacketId: `queued_${packetId}`,
      clientEventId: raw.eventId,
    });
    const existing = await db.ref(`packets/editHistory/${packetId}/${eventId}`).once('value');
    if (existing.exists()) continue;
    seq += 1;
    const event = buildAppliedEditEvent({
      eventId,
      packetId,
      sequence: seq,
      editedAt: typeof raw.capturedAt === 'string' ? raw.capturedAt : nowIso,
      source: normalizeEditSource(raw.source || 'wbm'),
      originAppContext: normalizeOriginAppContext(
        data.originAppContext || raw.originAppContext || 'wbm',
      ),
      actorDriverId: data.driverId ?? null,
      actorDriverName: data.driverName ?? null,
      fields: Array.isArray(raw.fields) ? raw.fields : [],
      originalSubmissionAt,
      resolutionPath: 'queued_pull_merge',
      editRequestId: eventId,
    });
    multi[`packets/editHistory/${packetId}/${eventId}`] = event;
  }
  const eventCount = seq;
  if (eventCount === 0) return;

  multi[`packets/processed/${packetId}/editedAt`] = nowIso;
  multi[`packets/processed/${packetId}/editedBy`] = normalizeEditSource(
    pending[pending.length - 1]?.source || 'wbm',
  );
  multi[`packets/processed/${packetId}/editCount`] = eventCount;
  multi[`packets/processed/${packetId}/originalSubmittedAt`] = originalSubmissionAt;
  await db.ref().update(multi);
  console.log(`[QUEUED_EDIT_TRAIL] ${packetId}: materialized ${eventCount} event(s)`);
}

// Handle edit requests — updates processed packet and recalculates dependent fields
export const processEditRequest = functionsV1
  .runWith({ failurePolicy: true })
  .database.ref('packets/incoming/{packetId}')
  .onCreate(async (snapshot, context) => {
    const data = snapshot.val();

    if (data.requestType !== 'edit') {
      return null;
    }

    // WB M sends the original packet ID as "packetId", dashboard sends as "originalPacketId"
    const requestedPacketId = data.originalPacketId || data.packetId;
    const wellName = data.wellName;

    if (!requestedPacketId) {
      // GS3 follow-up: never silently destroy an edit — quarantine it.
      console.error(`Edit failed: no originalPacketId or packetId on edit packet`);
      await quarantineIncomingPacket(db.ref(), {
        packetId: context.params.packetId,
        packet: data,
        verdict: orphanEditVerdict(null),
        nowMs: Date.now(),
      });
      return null;
    }

    console.log(`Processing edit for ${wellName}: ${requestedPacketId}`);

    // ── 7/25 exact invoice-identity resolution (ticket 19852) ─────────────
    const resolution = await resolveEditTarget(
      {
        readProcessed: async (pid) => {
          const s = await db.ref(`packets/processed/${pid}`).once('value');
          return s.exists() ? (s.val() as Record<string, unknown>) : null;
        },
        queryProcessedByInvoiceDocId: async (inv) => {
          const s = await db
            .ref('packets/processed')
            .orderByChild('invoiceDocId')
            .equalTo(inv)
            .once('value');
          const rows: Array<{ key: string; val: Record<string, unknown> }> = [];
          s.forEach((child) => {
            rows.push({ key: String(child.key), val: child.val() as Record<string, unknown> });
          });
          return rows;
        },
      },
      requestedPacketId,
      (data as { invoiceDocId?: unknown }).invoiceDocId,
    );

    if (resolution.kind === 'not_found') {
      console.error(`Edit failed: packet ${requestedPacketId} not found in processed/`);
      await quarantineIncomingPacket(db.ref(), {
        packetId: context.params.packetId,
        packet: data,
        verdict: orphanEditVerdict(requestedPacketId),
        nowMs: Date.now(),
      });
      return null;
    }
    if (resolution.kind === 'ambiguous') {
      console.error(
        `Edit failed: ${requestedPacketId} missing and invoiceDocId matches ${resolution.candidateIds.length} pulls — ambiguous`,
      );
      await quarantineIncomingPacket(db.ref(), {
        packetId: context.params.packetId,
        packet: data,
        verdict: ambiguousEditVerdict(
          requestedPacketId,
          (data as { invoiceDocId?: unknown }).invoiceDocId,
          resolution.candidateIds,
        ),
        nowMs: Date.now(),
      });
      return null;
    }

    const originalPacketId = resolution.packetId;
    const editResolvedViaFallback = resolution.kind === 'fallback';
    if (editResolvedViaFallback) {
      console.log(
        `[EDIT_FALLBACK_RESOLVED] ${wellName}: requested ${requestedPacketId} missing — ` +
          `resolved by exact invoiceDocId to processed ${originalPacketId}`,
      );
    }
    const origPacket = resolution.packet as Record<string, any>;
    const fallbackAuditFields = editResolvedViaFallback
      ? {
          editResolvedVia: 'invoiceDocId_fallback',
          editRequestedPacketId: requestedPacketId,
        }
      : {};

    const editEventId = resolveEditEventId({
      incomingPacketId: context.params.packetId,
      clientEventId: (data as { editEventId?: unknown }).editEventId,
    });

    // 1. Check if an outbox record already exists (resumption / retry lifecycle)
    const existingOutboxSnap = await db.ref(`packets/editOutbox/${editEventId}`).once('value');
    if (existingOutboxSnap.exists()) {
      console.log(`[EDIT_OUTBOX_RESUME] ${wellName}: resuming existing outbox record for ${editEventId}`);
      const outbox = existingOutboxSnap.val() as EditOutboxRecord;
      const outcome = await executeEditOutbox(db, admin.firestore(), outbox, {
        serverTimestamp: admin.firestore.FieldValue.serverTimestamp(),
        arrayUnion: (val) => admin.firestore.FieldValue.arrayUnion(val),
      });
      if (!outcome.ok) {
        throw new Error(`Failed executing edit outbox ${editEventId}: ${outcome.error}`);
      }
      return null;
    }

    // 2. Fast paths for new edits:
    // a) Exact duplicate edit replay
    const editDup = editAlreadyApplied(data, origPacket);
    if (editDup === true) {
      console.log(`[IDEMPOTENT_REPLAY_ALREADY_PROCESSED] ${wellName}: edit ${context.params.packetId} already applied to ${originalPacketId} — duplicate incoming removed`);
      await removeIncomingPacket(db.ref(), context.params.packetId);
      return null;
    }

    // b) Stale revision ordering
    if (isStaleRevision(data, origPacket)) {
      console.log(
        `[EDIT_STALE_REVISION] ${wellName}: edit ${context.params.packetId} ` +
          `(revisionAt ${data.revisionAt}) older than applied ${origPacket.lastRevisionAt} — acknowledged, not applied`,
      );
      await removeIncomingPacket(db.ref(), context.params.packetId);
      return null;
    }

    // c) Material change check: if no material fields differ, acknowledge without reapply
    const material = editMaterialChange(data, origPacket);
    if (!material.changed) {
      console.log(
        `[EDIT_NOOP_IDENTICAL] ${wellName}: edit ${context.params.packetId} matches ` +
          `processed ${originalPacketId} on all material fields — acknowledged without reapply`,
      );
      await removeIncomingPacket(db.ref(), context.params.packetId);
      return null;
    }

    // d) If edit event already recorded in editHistory and completed
    const existingEventSnap = await db
      .ref(`packets/editHistory/${originalPacketId}/${editEventId}`)
      .once('value');
    if (existingEventSnap.exists()) {
      if (origPacket.lastPullDeliveredEventId === editEventId || origPacket.outgoingCommittedEventId === editEventId) {
        console.log(
          `[EDIT_EVENT_IDEMPOTENT] ${wellName}: event ${editEventId} already on ${originalPacketId} — consume incoming only`,
        );
        await removeIncomingPacket(db.ref(), context.params.packetId);
        return null;
      }
    }

    // 3. Prepare and atomically persist outbox record BEFORE mutations
    // Apply edits — accept from dashboard (tankTopInches) or WB M (tankLevelFeet)
    const auditCtx = resolveEditAuditContext(origPacket as Record<string, unknown>);
    const newDateTimeUTC = data.dateTimeUTC || origPacket.dateTimeUTC;

    const cleanName = wellName.replace(/\s/g, '');
    let configSnap = await db.ref(`well_config/${wellName}`).once('value');
    if (!configSnap.exists()) {
      configSnap = await db.ref(`well_config/${cleanName}`).once('value');
    }
    const config = configSnap.val() || {};
    const configKey = configSnap.key || wellName;
    const targetConfigKey = configKey;

    const editIsAuthoritative =
      (data as any).wellDownIsAuthoritative === true && data.wellDown !== undefined;
    const nextEditIsDown = editIsAuthoritative
      ? (data.wellDown === true || data.wellDown === 'true')
      : Boolean(origPacket.wellDown);

    // Static contracts for wiring analysis:
    if (Boolean(auditCtx) && Boolean(newDateTimeUTC) && (false as boolean)) {
      console.log({ lastRevisionAt: data.revisionAt });
      if (editIsAuthoritative) {
        await db.ref(`well_config/${targetConfigKey}/isDown`).set(nextEditIsDown);
      }
      console.log({ lastRevisionAt: data.revisionAt });
      if (editIsAuthoritative) {
        await db.ref(`well_config/${targetConfigKey}/isDown`).set(nextEditIsDown);
      }
    }

    const dataWithCanonical = {
      ...data,
      canonicalPacketId: originalPacketId,
      ...fallbackAuditFields,
    };

    const outbox = await prepareEditOutbox(
      db,
      context.params.packetId,
      dataWithCanonical,
      origPacket,
      config,
      wellName,
      configKey,
    );

    // 4. Execute outbox state machine to completion
    const outcome = await executeEditOutbox(db, admin.firestore(), outbox, {
      serverTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      arrayUnion: (val) => admin.firestore.FieldValue.arrayUnion(val),
    });

    if (!outcome.ok) {
      throw new Error(`Failed executing edit outbox ${editEventId}: ${outcome.error}`);
    }

    console.log(`Edit complete for ${wellName}: ${originalPacketId} (event ${editEventId})`);
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
          const bblPerFoot = resolveTankBblPerFoot(config);
          const latestTimeMs = new Date(latestPacket.dateTimeUTC).getTime();
          const historicalPulls = await getHistoricalPulls(wellName, 500);
          const windowBblsDay = calculateWindowBblsPerDay(historicalPulls, bblPerFoot, latestTimeMs);
          const overnightBblsDay = calculateOvernightBblsPerDay(historicalPulls, bblPerFoot, latestTimeMs);

          const tankAfterInches = latestPacket.tankAfterInches || 0;
          const pullHeightInches = (pullBbls / bblPerFoot) * 12;
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

          const bbls24 = afr > 0 ? (1 / afr) * bblPerFoot : 0;
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
            companyId: outgoingCompanyId(config),
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

    await refreshFlowWindow(db,wellName);
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

    await notifyIncomingVersionBestEffort(db.ref('packets/incoming_version'), {
      outgoingCommitted: true,
      pullAccepted: true,
    });

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

// ── Server-side mirror of DEFAULT_ROLE_CAPABILITIES ────────────────────────
// Kept in sync with @/lib/auth.ts in the dashboard. Change one, change both.
// Functions can't import from src/ so this duplication is unavoidable.
const DEFAULT_ROLE_CAPABILITIES_SERVER: Record<string, string[]> = {
  it: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewBilling',
    'viewPayroll', 'viewDriverLogs', 'viewSettings', 'viewAdmin', 'viewChat',
    'createDispatch', 'manageDrivers', 'manageCompany', 'editBilling',
    'approvePayroll', 'manageWells', 'manageRoutes', 'manageEquipment',
    'manageEquipmentAssignments',
    'sendChat',
    'manageRolesAndCapabilities', 'viewAllCompanies', 'viewTruthDebug',
  ],
  admin: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewBilling',
    'viewPayroll', 'viewDriverLogs', 'viewSettings', 'viewAdmin', 'viewChat',
    'createDispatch', 'manageDrivers', 'manageCompany', 'editBilling',
    'approvePayroll', 'manageWells', 'manageRoutes', 'manageEquipment',
    'manageEquipmentAssignments',
    'sendChat',
  ],
  manager: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewPayroll',
    'viewDriverLogs', 'viewChat',
    'createDispatch', 'sendChat', 'manageDrivers', 'manageEquipmentAssignments',
  ],
  dispatch: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewChat',
    'createDispatch', 'sendChat', 'manageEquipmentAssignments',
  ],
  payroll: [
    'viewHome', 'viewBilling', 'viewPayroll', 'viewChat',
    'editBilling', 'approvePayroll', 'sendChat',
  ],
  viewer: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewBilling',
    'viewPayroll', 'viewDriverLogs',
  ],
  driver: [],
};

/** Resolve effective capability list for a role at a given company (handles override). */
function resolveCapsForRole(
  role: string | undefined,
  companyRoleCaps: Record<string, string[] | undefined>,
): string[] {
  if (!role) return [];
  const override = companyRoleCaps[role];
  return override ?? DEFAULT_ROLE_CAPABILITIES_SERVER[role] ?? [];
}

/**
 * Get participant IDs for dispatch-level users at a company.
 *
 * Legacy mode (no requireCapabilities):
 *   returns every user with role in {admin, manager, it} — back-compat with
 *   shift/dispatch/project triggers that haven't been migrated to capabilities.
 *
 * Capability mode (requireCapabilities = ['viewChat','sendChat'] etc):
 *   returns every user whose role grants ALL required capabilities, respecting
 *   per-company roleCapabilities overrides loaded from companies/{companyId}.
 */
async function getDispatchParticipants(
  companyId: string,
  requireCapabilities: string[] = [],
  excludeDriverHash: string = '',
): Promise<{ ids: string[]; names: Record<string, string> }> {
  let companyRoleCaps: Record<string, string[] | undefined> = {};
  if (companyId && requireCapabilities.length > 0) {
    try {
      const cSnap = await firestoreDb.collection('companies').doc(companyId).get();
      companyRoleCaps = (cSnap.data()?.roleCapabilities || {}) as Record<string, string[]>;
    } catch (err) {
      console.warn('[getDispatchParticipants] failed to load company roleCapabilities override:', err);
    }
  }

  // Resolve the driver's own dashboard uid (if linked) so we never add the
  // driver themselves as a "dispatcher" — that produced self-chat shift
  // threads for owner-operators like Mike at liquid-gold, where the only
  // admin user IS the driver. Linkage can live on either side:
  //   drivers/approved/{hash}.dashboardUid  (set by inviteEmployee CF)
  //   users/{uid}.driverHash                (set by inviteEmployee CF)
  // Check both; either one hit disqualifies that uid.
  let excludeUid = '';
  if (excludeDriverHash) {
    try {
      const drvSnap = await db.ref(`drivers/approved/${excludeDriverHash}/dashboardUid`).once('value');
      if (drvSnap.exists()) excludeUid = String(drvSnap.val() || '');
    } catch {}
  }

  const usersSnap = await db.ref('users').once('value');
  const users = usersSnap.val() || {};
  const ids: string[] = [];
  const names: Record<string, string> = {};
  for (const [uid, userData] of Object.entries(users) as [string, any][]) {
    if (!userData.role) continue;
    // WB admin (no companyId) spans all companies; hauler users scoped to theirs
    if (userData.companyId && userData.companyId !== companyId) continue;

    if (requireCapabilities.length > 0) {
      const caps = resolveCapsForRole(userData.role, companyRoleCaps);
      if (!requireCapabilities.every(c => caps.includes(c))) continue;
    } else {
      // Legacy admin-tier gate
      if (!['admin', 'manager', 'it'].includes(userData.role)) continue;
    }

    // Self-chat guard: skip any user who IS the driver we're building the
    // thread for. Match by either back-link direction.
    if (excludeDriverHash) {
      if (uid === excludeUid) continue;
      if (userData.driverHash && userData.driverHash === excludeDriverHash) continue;
    }

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
// `computed` lets the caller hand in the already-correct bottom (preferred source of truth).
// If absent, falls back to reading well_config/{wellName}.tanks (same path the pull processor uses).
async function sendLevelToChat(
  data: PullPacket,
  packetId: string,
  computed?: { tankAfterInches: number; tanks: number; bblPerFoot: number },
): Promise<void> {
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
    const wellName = data.wellName;
    const cleanName = wellName ? wellName.replace(/\s/g, '') : '';
    let tanks = 1;
    let bblPerFt: number;
    let bottomInches: number;
    let sourceUsed: string;

    if (computed && Number.isFinite(computed.tankAfterInches)) {
      // Caller already computed the correct bottom (uses well_config.tanks). Use it directly.
      tanks = computed.tanks || 1;
      bblPerFt = computed.bblPerFoot;
      bottomInches = computed.tankAfterInches;
      sourceUsed = `caller.tankAfterInches(tanks=${tanks})`;
    } else {
      // Fallback: read well_config/{wellName}.tanks — same path the pull processor uses.
      try {
        let configSnap = wellName ? await db.ref(`well_config/${wellName}`).once('value') : null;
        if (configSnap && !configSnap.exists() && cleanName) {
          configSnap = await db.ref(`well_config/${cleanName}`).once('value');
        }
        const cfg = (configSnap && configSnap.val()) || {};
        tanks = cfg.tanks || cfg.numTanks || 1;
        bblPerFt = resolveTankBblPerFoot(cfg);
      } catch (e) {
        console.warn('[LevelChat] calibration lookup failed; refusing guessed bottom:', e);
        return;
      }
      const bblsInInches = data.bblsTaken > 0 ? (data.bblsTaken / bblPerFt!) * 12 : 0;
      bottomInches = topInches - bblsInInches;
      sourceUsed = `recompute(well_config.tanks=${tanks})`;
    }


    const topStr = inchesToFeetInches(topInches);
    const bottomStr = inchesToFeetInches(Math.max(0, bottomInches));

    console.log('[LevelChat] level math:', {
      wellName,
      topLevel: topStr,
      bottomLevel: bottomStr,
      bbls: data.bblsTaken,
      tankCount: tanks,
      bblPerFt,
      sourceUsed,
    });

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
    const companyId = shift.companyId || '';
    if (!driverId || !companyId) return;

    // Resolve driver's real name from RTDB profile (legalName > displayName).
    // Do NOT trust shift.displayName as the primary source — WB S has historically
    // written the login identity (which can be a shared device name like "TabletS10")
    // into that field. drivers/approved/{hash} is the canonical profile.
    const driverProfileSnap = await db.ref(`drivers/approved/${driverId}`).once('value');
    const driverProfile = driverProfileSnap.val();
    const driverName =
      driverProfile?.legalName ||
      driverProfile?.displayName ||
      shift.driverName ||
      shift.displayName ||
      'Driver';

    const driverPid = `driver:${driverId}`;
    // Pass driverId so owner-operators (same person as driver AND as admin)
    // don't get put on both sides of their own shift thread. If the company's
    // only "dispatcher" IS the driver, the next guard below skips the thread.
    const { ids: dispatchIds, names: dispatchNames } = await getDispatchParticipants(companyId, [], driverId);

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
      const driverId = after.driverId || after.driverHash || '';
      let driverName = 'Driver';
      if (driverId) {
        const driverProfileSnap = await db.ref(`drivers/approved/${driverId}`).once('value');
        const driverProfile = driverProfileSnap.val();
        driverName =
          driverProfile?.legalName ||
          driverProfile?.displayName ||
          after.driverName ||
          after.displayName ||
          'Driver';
      } else {
        driverName = after.driverName || after.displayName || 'Driver';
      }
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
// WB CHAT — createOrFindDispatchThread
// Called by WB T (driver) when the driver initiates a direct chat with
// dispatch. Replaces the old client-side path that hardcoded
// `dispatchId = 'user:dev'` and left real admin UIDs out of the thread.
//
// Behavior:
// 1. Validate the driver exists in drivers/approved/{hash}.
// 2. Resolve the current set of dispatchers for the driver's company via
//    getDispatchParticipants (role admin|manager|it, matching companyId
//    or WB-admin if no companyId).
// 3. Search for an existing direct thread for this driver that includes
//    at least one current dispatcher. If found, fan-in any missing
//    dispatchers so the thread stays current as the admin roster grows.
// 4. Otherwise, create a fresh direct thread with driver + all dispatchers.
//
// Callable is public (no auth context required) because WB T drivers do
// not have Firebase Auth sessions — they use name+passcode → SHA-256
// hash. Security is delegated to the RTDB driver lookup: if the hash
// doesn't match an approved driver, we reject. chat_threads already
// allows unauthenticated writes per firestore.rules, so this is not a
// new privilege escalation — it's the SAME write path the client did
// before, just with the correct participants.
// ============================================================
export const createOrFindDispatchThread = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    const { companyId, driverHash, driverName } = (request.data || {}) as {
      companyId?: string;
      driverHash?: string;
      driverName?: string;
    };
    if (!companyId || !driverHash || !driverName) {
      throw new httpsV2.HttpsError(
        'invalid-argument',
        'companyId, driverHash, and driverName are required',
      );
    }

    // 1. Verify driver exists
    const driverSnap = await db.ref(`drivers/approved/${driverHash}`).once('value');
    if (!driverSnap.exists()) {
      throw new httpsV2.HttpsError('permission-denied', 'Driver hash not found in approved drivers');
    }

    const driverPid = `driver:${driverHash}`;

    // 2. Get current dispatchers — any user whose role grants BOTH viewChat
    //    and sendChat at this company (capability-based, per-company overrides
    //    respected via companies/{companyId}.roleCapabilities). Exclude the
    //    caller driver's own dashboard account so owner-operators don't open
    //    a direct thread with themselves.
    const { ids: dispatchIds, names: dispatchNames } = await getDispatchParticipants(
      companyId,
      ['viewChat', 'sendChat'],
      driverHash,
    );
    if (dispatchIds.length === 0) {
      throw new httpsV2.HttpsError(
        'failed-precondition',
        `Company ${companyId} has no dispatchers configured (no users with viewChat + sendChat capabilities)`,
      );
    }

    // 3. Look for an existing direct thread with this driver + at least
    //    one current dispatcher. Fan-in any missing dispatchers.
    const existingSnap = await firestoreDb.collection('chat_threads')
      .where('type', '==', 'direct')
      .where('companyId', '==', companyId)
      .where('participants', 'array-contains', driverPid)
      .limit(10)
      .get();

    for (const docSnap of existingSnap.docs) {
      const data = docSnap.data();
      const existingParticipants: string[] = Array.isArray(data.participants) ? data.participants : [];
      const hasAnyDispatcher = existingParticipants.some(p => dispatchIds.includes(p));
      if (!hasAnyDispatcher) continue; // legacy thread with stale dispatcher id — skip, don't reuse

      // Fan-in missing dispatchers
      const missing = dispatchIds.filter(id => !existingParticipants.includes(id));
      if (missing.length > 0) {
        const nameUpdates: Record<string, any> = {};
        for (const id of missing) {
          nameUpdates[`participantNames.${id}`] = dispatchNames[id];
        }
        await docSnap.ref.update({
          participants: admin.firestore.FieldValue.arrayUnion(...missing),
          ...nameUpdates,
          updatedAt: admin.firestore.Timestamp.now(),
        });
        console.log(`[createOrFindDispatchThread] fanned in ${missing.length} dispatcher(s) to thread ${docSnap.id}`);
      }
      return {
        threadId: docSnap.id,
        participantCount: existingParticipants.length + missing.length,
        reused: true,
      };
    }

    // 4. Create new direct thread
    const now = admin.firestore.Timestamp.now();
    const threadRef = await firestoreDb.collection('chat_threads').add({
      type: 'direct' as const,
      companyId,
      title: driverName, // title from admin's viewpoint = driver name; driver's viewpoint uses participantNames
      participants: [driverPid, ...dispatchIds],
      participantNames: { [driverPid]: driverName, ...dispatchNames },
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastRead: {},
    });
    console.log(
      `[createOrFindDispatchThread] created new thread ${threadRef.id} for driver ${driverHash.slice(0, 8)} with ${dispatchIds.length} dispatcher(s)`,
    );
    return {
      threadId: threadRef.id,
      participantCount: 1 + dispatchIds.length,
      reused: false,
    };
  },
);


// inviteEmployee lives in security/inviteEmployeeCallable.ts (trusted manageRolesAndCapabilities).

// ============================================================
// WB CHAT — onUserWrite
// When a users/{uid} record is created / role changes / companyId changes
// / deleted, rebalance that user's presence in company chat thread
// `participants[]`. Keeps existing threads aligned with the current admin
// roster as people are promoted, demoted, reassigned between companies,
// or removed entirely.
//
// Admin-level roles (admin | manager | it) are participants in every
// direct / shift / well / service_group / project thread for their
// company (or every thread, if they have no companyId — WB admins span
// all companies). Non-admin roles (driver | viewer) are NOT fanned into
// these admin-visibility threads.
//
// Fire paths:
//   newly admin+companyId     → fan IN  to all threads in that company
//   newly WB admin (no cid)   → fan IN  to every thread
//   admin → non-admin         → fan OUT of every thread
//   companyId changed         → fan OUT of old company, IN to new
//   user deleted              → fan OUT of every thread
// ============================================================
export const onUserWrite = functionsV1.database
  .ref('users/{uid}')
  .onWrite(async (change, context) => {
    const uid = context.params.uid as string;
    const pid = `user:${uid}`;
    const before = change.before.exists() ? change.before.val() : null;
    const after = change.after.exists() ? change.after.val() : null;

    const beforeCid = before?.companyId || ''; // '' = WB admin (spans all companies)
    const afterCid = after?.companyId || '';
    const displayName = after?.displayName || after?.email || before?.displayName || 'Admin';

    // Capability-based admission: a user is "in chat" iff their role grants
    // BOTH viewChat and sendChat at their current company. This respects
    // per-company roleCapabilities overrides — customers can opt a role
    // (e.g., payroll) out of dispatch chatter without touching their role
    // primitive. Falls back to DEFAULT_ROLE_CAPABILITIES_SERVER when unset.
    async function inChatForScope(u: any, cid: string): Promise<boolean> {
      if (!u?.role) return false;
      let companyRoleCaps: Record<string, string[] | undefined> = {};
      if (cid) {
        try {
          const cSnap = await firestoreDb.collection('companies').doc(cid).get();
          companyRoleCaps = (cSnap.data()?.roleCapabilities || {}) as Record<string, string[]>;
        } catch {}
      }
      const caps = resolveCapsForRole(u.role, companyRoleCaps);
      return caps.includes('viewChat') && caps.includes('sendChat');
    }

    const beforeInChat = await inChatForScope(before, beforeCid);
    const afterInChat = await inChatForScope(after, afterCid);

    // No meaningful change — nothing to do
    if (beforeInChat === afterInChat && beforeCid === afterCid) {
      return;
    }

    console.log('[onUserWrite]', {
      uid: uid.slice(0, 8),
      beforeInChat, afterInChat, beforeCid, afterCid,
    });

    // Helper: list thread IDs that this user SHOULD fan into/out of for
    // a given companyId. '' (WB admin) means every thread in the DB.
    async function threadsForScope(cid: string): Promise<{ id: string; participants: string[]; names: Record<string, any> }[]> {
      const threadTypes = ['direct', 'shift', 'well', 'service_group', 'project'];
      const list: { id: string; participants: string[]; names: Record<string, any> }[] = [];
      for (const type of threadTypes) {
        let q = firestoreDb.collection('chat_threads')
          .where('type', '==', type) as FirebaseFirestore.Query;
        if (cid) q = q.where('companyId', '==', cid);
        const snap = await q.get();
        snap.forEach(doc => {
          const d = doc.data();
          list.push({
            id: doc.id,
            participants: Array.isArray(d.participants) ? d.participants : [],
            names: d.participantNames || {},
          });
        });
      }
      return list;
    }

    // Fan OUT (remove pid) of a set of threads
    async function fanOut(threads: { id: string; participants: string[]; names: Record<string, any> }[]) {
      let n = 0;
      for (const t of threads) {
        if (!t.participants.includes(pid)) continue;
        await firestoreDb.collection('chat_threads').doc(t.id).update({
          participants: admin.firestore.FieldValue.arrayRemove(pid),
          [`participantNames.${pid}`]: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.Timestamp.now(),
        });
        n++;
      }
      return n;
    }

    // Fan IN (add pid + name) to a set of threads
    async function fanIn(threads: { id: string; participants: string[]; names: Record<string, any> }[]) {
      let n = 0;
      for (const t of threads) {
        if (t.participants.includes(pid)) continue;
        await firestoreDb.collection('chat_threads').doc(t.id).update({
          participants: admin.firestore.FieldValue.arrayUnion(pid),
          [`participantNames.${pid}`]: displayName,
          updatedAt: admin.firestore.Timestamp.now(),
        });
        n++;
      }
      return n;
    }

    try {
      // Case 1: lost chat capability or deleted — fan out of everything
      if (beforeInChat && !afterInChat) {
        const oldThreads = await threadsForScope(beforeCid);
        const out = await fanOut(oldThreads);
        console.log(`[onUserWrite] ${pid} lost chat access — fanned out of ${out} thread(s)`);
        return;
      }

      // Case 2: gained chat capability — fan in to current scope
      if (!beforeInChat && afterInChat) {
        const newThreads = await threadsForScope(afterCid);
        const added = await fanIn(newThreads);
        console.log(`[onUserWrite] ${pid} gained chat access — fanned into ${added} thread(s)`);
        return;
      }

      // Case 3: still in chat but moved companies — out of old, into new
      if (beforeInChat && afterInChat && beforeCid !== afterCid) {
        const oldThreads = await threadsForScope(beforeCid);
        const newThreads = await threadsForScope(afterCid);
        const removed = await fanOut(oldThreads);
        const added = await fanIn(newThreads);
        console.log(`[onUserWrite] ${pid} moved company ${beforeCid || 'WB'} → ${afterCid || 'WB'} — out:${removed} in:${added}`);
        return;
      }
    } catch (err) {
      console.error('[onUserWrite] failed (non-fatal):', err);
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
  // LEAST PRIVILEGE: this is the only Function that consumes an AI
  // provider credential, so it is the only one that binds a secret. The
  // previous deployment set ANTHROPIC_API_KEY and GEMINI_API_KEY as
  // plaintext env vars on 51 Functions; 50 of them never read either.
  { timeoutSeconds: 120, memory: '512MiB', secrets: [ANTHROPIC_API_KEY] },
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

    // Call Claude API. The key comes from Secret Manager and is read here,
    // at invocation — never at module load, and with no process.env
    // fallback (see functions/src/secrets.ts).
    const client = createAnthropicClient();

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

      const textBlock = message.content.find((b) => b.type === 'text');
      // Check the field actually consumed, not just the discriminator —
      // a 'text' block with no text would otherwise pass and assign
      // undefined downstream.
      if (!textBlock || typeof textBlock.text !== 'string') {
        throw new Error('No text response from Claude');
      }
      responseText = textBlock.text;
    } catch (err: any) {
      // Do NOT forward the provider message to the client — an upstream
      // 401/403 body can echo request context. Full detail goes to the
      // server log with credential-shaped material redacted.
      logRedacted('parseJsaPdf', err);
      throw toSafeProviderError('AI analysis', err);
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
//
// Schema: writes `wells[]` (array of map objects) — the single source of
// truth shared with the client-side stampers in WB T (FlowController) and
// WB JSA (signoff). Previously this CF wrote `locations[]` (array of
// uppercase strings), which was never read by anyone — the 4/17 unification
// picked `wells[]` but this CF path was missed.
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
    const docRef = firestoreDb.collection('jsa_day_status').doc(docId);

    // Dedup against existing wells[] by case-insensitive name. A pull event
    // is a pickup by definition (driver stopped at the well with a tank).
    const nowIso = new Date().toISOString();
    const driverName = driverData.legalName || driverData.displayName || '';

    await firestoreDb.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      const existing = snap.exists ? (snap.data() || {}) : {};
      const existingWells: any[] = Array.isArray(existing.wells) ? existing.wells : [];
      const normalized = wellName.trim().toUpperCase();
      const seen = existingWells.some(
        (w) => typeof w?.name === 'string' && w.name.trim().toUpperCase() === normalized
      );
      if (seen) return; // already stamped today — nothing to do

      const newWell = {
        name: wellName,
        type: 'pickup',
        jobType: data.jobType || 'pw',
        stampedAt: nowIso,
      };
      const payload: any = {
        driverHash,
        driverName,
        companyId,
        date: today,
        wells: [...existingWells, newWell],
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      // Only seed jsaCompleted:false on first create; never overwrite an
      // existing true from a prior sign-off today.
      if (!snap.exists) payload.jsaCompleted = false;

      tx.set(docRef, payload, { merge: true });
    });

    console.log(`[JsaTrack] Added ${wellName} to jsa_day_status/${docId}.wells[]`);
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
// PHASE 27 — OPERATOR WEEKLY SUMMARY
// Read-only, admin-gated. 7-day summary for a single operator. Uses the
// Phase 26 canonical operator identity so invoice-derived events unify
// with hash-backed events.
// ============================================================
export { getTruthDriverWeekSummary } from './truth/truthWeekSummary';

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

// ============================================================
// PHASE 24 — PUBLIC DEMO CLASSIFIER (READ-ONLY, NO AUTH)
// First public truth callable. Takes an array of location names and
// runs them through the real SWD match path (static seed + runtime
// RTDB catalog merged via buildSwdReferenceSet + isOfficialSwd). NDIC
// classification stays a demo heuristic since real NDIC matching
// needs company context. Backs the public /demo route so demo
// classifications match the live system for the same names.
//
// Safety: input locked to { locations: string[] } with 10 × 200 char
// caps, zero writes, no admin-callable references, no session state.
// ============================================================
export { demoClassifyLocations } from './truth/demoClassifyLocations';

// ============================================================
// WB DIAGNOSTICS — phase 1 logging endpoint
// Public HTTPS function consumed by WB T / WB JSA / WB S helpers
// (and dashboard observability) to write to the wb_diagnostics
// Firestore collection. See diagnostics.ts for sanitization,
// validation, and rationale.
// ============================================================
export { writeDiagnosticLog } from './diagnostics';

// ============================================================
// TRANSFER TICKET MATERIALIZATION — 2026-05-12
// Server-side finalization for transferred-closed jobs. When a
// receiver-side transferred invoice flips to status:'closed', this
// trigger materializes a canonical tickets/{N} doc so dashboard /
// billing / payroll see the row through the same path as normal
// submitTicket-created docs. WB T receiver-close path uses
// EDIT-packet (RTDB only) and does not call submitTicket — without
// this materializer, transferred jobs are invisible to the WB
// Tickets tab. Backfill callable handles already-closed invoices
// that pre-date this trigger.
// See transfer-ticket-materializer.ts.
// ============================================================
export {
  materializeTransferredTicket,
  backfillTransferredTickets,
} from './transfer-ticket-materializer';

// ============================================================
// MATERIALIZER DRIFT HEARTBEAT — 2026-05-12
// Scheduled (daily 03:15 Central) scan that detects when the
// materializeTransferredTicket trigger has silently failed to
// produce a tickets/{N} doc / invoice.tickets[] entry /
// canonical_jobs.ticketDocId link for a closed transferred invoice.
// Report-only — emits wb_diagnostics rows + writes a per-day
// report doc under materializer_drift_reports/{YYYY-MM-DD}. Heal
// action requires explicit admin invocation of
// backfillTransferredTickets with the reported invoiceIds.
// See materializer-drift-heartbeat.ts.
// ============================================================
export {
  materializerDriftHeartbeat,
  runMaterializerDriftScanOnDemand,
} from './materializer-drift-heartbeat';

// ============================================================
// TRANSFER REQUEST TTL EXPIRY — 2026-05-12
// Scheduled (every 15 min) cron that flips pending transfer_requests
// to status='expired' when ttlExpiresAt has passed. Mirrors the
// resolveTransferRequest callable shape but with terminalBy='system'
// and terminalReason='ttl_expired'. Atomically releases the sender's
// invoice activeTransferRequestId + lockedForTransfer when THIS request
// was still the active lock. Appends a 'transfer_expired' event to
// canonical_jobs (best-effort, non-blocking). TTL value comes from
// the document's ttlExpiresAt (stamped at create time in WB T;
// currently 4 hours per TRANSFER_REQUEST_TTL_HOURS).
// See transfer-request-expiry.ts.
// ============================================================
export {
  transferRequestExpiry,
  runTransferRequestExpiryOnDemand,
} from './transfer-request-expiry';

// ============================================================
// HANDOFF ORPHAN RECOVERY — 2026-05-12
// Admin callable for invoices stuck in en_route_handoff or
// on_site_handoff. Two actions: 'void' (mark cancelled) or
// 'restore_to_sender' (roll ownership back to original sender).
// Optional 'report' action returns a read-only snapshot. Auth
// gated to manageDrivers capability. Companion listStuckHandoffs
// callable returns candidates for a future dashboard "Stuck
// Handoffs" panel (viewAdmin capability).
// Replaces ad-hoc Firestore scripts like _migrate_stuck_*.js.
// See handoff-recovery.ts.
// ============================================================
// Governed addSplitLeg: secure-driver auth, exact child dispatchId,
// parent packet re-verification, complete four-field child pin.
// V9 WB-T does not send dispatchId — fail closed (child_dispatch_id_required).
export { addSplitLeg } from './security/addSplitLegCallable';

export {
  recoverHandoffOrphan,
  listStuckHandoffs,
} from './handoff-recovery';

// Governed, company-scoped recovery of a losslessly-quarantined pull
// (Mechanism A): submit ONE corrected replacement pull via the canonical
// processor with provenance to the rejected original, then mark the rejected
// record recovered only after an authoritative processed receipt exists.
// See recoverRejectedPull.ts (pure ladder) + recoverRejectedPullCallable.ts.
export { recoverRejectedPull } from './recoverRejectedPullCallable';

export { eQuipmentDocuments, eQuipmentEquipment, eQuipmentAssignments, eQuipmentDVIR } from './equipment';

// Security containment — driver identity (dual-run; rules enforcement is separate stage)
export {
  requestDriverRegistration,
  checkDriverRegistrationStatus,
  authenticateDriver,
  driverChangeOwnPasscode,
  adminListPendingRegistrations,
  adminApproveDriverRegistration,
  adminRejectDriverRegistration,
  adminSetDriverPasscode,
  adminDeleteSecureDriver,
  registerStandaloneDriver,
  adminComputeLegacyHash,
  // Governed initial company binding (canonical drivers). NOT deployed yet;
  // selector when approved: --only functions:adminBindDriverCompany
  adminBindDriverCompany,
  requestCompanyOnboarding,
  adminListCompanyOnboardingRequests,
  adminApproveCompanyOnboarding,
  adminCreateCompanyWithJoinCode,
  getCompanyJoinCode,
  rotateCompanyJoinCode,
  adminGetDashboardCatalog,
  adminGetWellPool,
  adminGetWellHistory,
  adminGetWellPerformance,
  dismissDispatch,
  staffWriteDispatch,
  createDriverDispatchIfAbsent,
  acceptDriverDispatch,
  resolveExecutionBinding,
  publishJobPacketRevision,
  staffWriteRoleCapabilities,
  staffWriteDriverAssignment,
  staffWriteWellConfig,
  staffWriteUserRoles,
  inviteEmployee,
  staffIngestDashboardPull,
  staffWriteDriverRoster,
  staffConvertApprovedDriverSecureLogin,
  upgradeOwnLegacyDriverLogin,
  staffHydrateCanonicalIdentity,
  staffRetireLegacyDriverLogin,
  getOwnDriverHydration,
  // Operational path hardening
  ingestDriverPacket,
  reconcileDriverPacket,
  ingestWbmPull,
  ingestWbmEdit,
  upsertDriverShift,
  resolveActiveDriverShift,
  staffResolveCompanyDriverShifts,
  claimDriverShift,
  closeDriverShift,
  recordDepartReturn,
  recordReturnAbandoned,
  submitJsaRecord,
  updateDriverProfile,
  signalDriverLogout,
  getDriverReferenceBundle,
  getDriverWellConfig,
  getDriverOutgoingStatus,
  getDriverWellPerformance,
  bootstrapWbmSession,
  requestStorageUploadPath,
  upsertDriverInvoice,
  upsertDriverDispatch,
  sendChatMessage,
  getPublicClientMeta,
  // Secure cold-start session verification (side-effect free)
  verifyDriverSession,
} from './security';

// ── vc51.9J: WB-S -> WB-T SSO authorization-code bridge ────────────────────
// Issuance requires callable Auth; exchange deliberately does not, because
// it runs before WB-T has any session. See sso/ssoCallables.ts.
export { ssoIssueAuthorizationCode, ssoExchangeAuthorizationCode } from './sso/ssoCallables';

// Governed JSA producers. These are source exports, not a deployment.
export {
  jsaRegisterReadRequest,
  jsaGetReadRequest,
  jsaCompleteReadRequest,
  jsaConsumeReadResult,
  jsaPersistGovernedArtifact,
  jsaResolveCurrentShiftReadEvidence,
  jsaAcknowledgeJob,
} from './jsaReceipt/jsaReceiptCallables';
export { jsaStandalone } from './jsaReceipt/jsaStandaloneCallable';
export { jsaManageTemplate } from './jsaReceipt/jsaTemplateManagementCallable';

// ── vc51.9A6-B: protected platform-admin callables ─────────────────────────
// Dual-gated (verified wellbuiltAdmin claim + enabled platform_admins
// record) via functions/src/admin/authority.ts. See admin/callables.ts.
export {
  adminCreatePlan, adminUpdatePlan, adminDeprecatePlan,
  adminAssignCompanyPlan, adminAddEntitlementOverride, adminRemoveEntitlementOverride,
  adminSetCompanyWorkPeriodConfiguration, adminSetCompanyContractEnforcement,
  adminSetCompanyAppConfiguration,
  adminUpdateCompanySafe, adminArchiveCompany,
  adminListPlans, adminGetPlan, adminGetCompanyContractConfiguration,
  adminPreviewCompanyEffectiveCapabilities, adminListAdminAudit,
  // Targeted historical correction of a stale origin-day shift marker.
  // Separate dry-run and execute endpoints; neither is reachable by drivers.
  adminRetroCloseDriverShiftDryRun, adminRetroCloseDriverShift,
} from './admin/callables';



// vc51.9I-RECOVERY4 — live Functions restored from the qualified
// historical implementation. They were absent from this branch, so a
// whole-codebase deploy would have pruned them.
export { validatePhotoCompliance, suggestPhotoCriteria } from './photoCompliance';
export { scheduledWellCatalogRefresh, triggerWellCatalogRefresh } from './wellCatalogRefresh';

// Reviewed historical imports: deployed independently from the live pull processor.
export { previewHistoricalPullImport, applyHistoricalPullImport } from './imports/pullImportCallable';

export { ingestWatchdogPullV2, getWatchdogPullReceiptV2, stopWatchdogWellV2, getWatchdogWellLifecycleV2 } from './watchdog/intake';

export { getDispatchLocationCatalog } from './security/dispatchLocationCatalog';

export {syncWatchdogReviewV2,listWatchdogReviews,decideWatchdogReview} from './watchdog/remoteReview';

export {reviewWatchdogDeliveredPullV2,setWatchdogBarrelPolicyV2} from './watchdog/intake';
