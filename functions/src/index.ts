import * as functionsV1 from 'firebase-functions/v1';
import * as functionsV2 from 'firebase-functions/v2/scheduler';
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { upsertCanonicalJob } from './canonical-jobs/upsertCanonicalJob';
import { logCanonicalDiag } from './canonical-jobs/diag';
import { ANTHROPIC_API_KEY, logRedacted, toSafeProviderError } from './secrets';
import { createAnthropicClient } from './ai/anthropicClient';
import {
  ambiguousEditVerdict,
  comparePullEquivalence,
  editAlreadyApplied,
  editMaterialChange,
  evaluateIncomingPull,
  isStaleRevision,
  malformedDeleteVerdict,
  orphanEditVerdict,
  packetIdCollisionVerdict,
  quarantineIncomingPacket,
  removeIncomingPacket,
  resolveEditTarget,
  strandedPacketVerdict,
} from './packetGuards';
import { isLateEntryByCanonicalOrder, type ChronoPullInput, type WellChronoConfig } from './chronoRecompute';
import { CANONICAL_COMMIT_TIMEOUT_SECONDS, runCanonicalMutation, type CommitReceipt } from './chronoCommitCoordinator';
import { makeCoordinatorIO } from './coordinatorIO';
import { assembleCanonicalPatch, receiptPathFor } from './canonicalPatch';
import { buildCreateMutation, buildDeleteMutation, type CanonicalSidecar } from './mutationBuilders';
import { computeAFRFromRates } from './pullFormulas';
import { getProductionDate, calculateWindowBblsPerDay, calculateOvernightBblsPerDay, computeBbls24hrs, type HistoricalPull } from './productionFormulas';
import { formatLocalDateTime, outgoingCompanyId, inchesToFeetInches, feetInchesToInches, daysToHMM, daysToHMMSS } from './wbmFormat';
import { buildOutgoingResponse, buildWellStatus } from './outgoingBuilders';
import { buildPerformanceRow } from './performanceBuilders';
import { computeTankTopInches, computeTankAfterInches, computeRecoveryInches, computeFlowRateDays } from './tankFormulas';
import {
  assertedFromEditedFields,
  buildAppliedEditEvent,
  buildAppliedEditReceipt,
  buildEditBaseline,
  buildFieldDiff,
  classifyEditOutcome,
  compareEditEvents,
  editHistoryWritePaths,
  editReceiptWritePaths,
  editSummaryFields,
  materializeEditableFields,
  nextEditCount,
  normalizeEditSource,
  normalizeOriginAppContext,
  resolveEditAuditContext,
  resolveEditEventId,
  resolveOriginalSubmissionAt,
  type EditableSnapshot,
} from './editHistory';
import { notifyIncomingVersionBestEffort } from './incomingVersionPublish';


admin.initializeApp();
admin.firestore().settings({ ignoreUndefinedProperties: true });
const db = admin.database();

// Format a Date to "MM/DD/YYYY H:MM AM/PM" (no comma — matches WB M/WB T format)
// Node's toLocaleString() produces "M/D/YYYY, H:MM:SS AM/PM" which Hermes can't parse

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
  const arrivedAtByKey: Record<string, number> = {};

  for (const key of keys) {
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
  const allKeys = new Set(keys);
  const keepKeys = new Set(Object.values(uniquePackets).map(p => p.key));
  const duplicateKeys = [...allKeys].filter(k => !keepKeys.has(k));

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
    // and should never be retriggered by the watchdog (causes ghost duplicate entries).
    // GS3 7/22/2026: this exact remove() destroyed a stranded driver edit —
    // quarantine instead so the evidence survives for review.
    if (data.requestType === 'edit' || data.requestType === 'delete') {
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
  // Stored Late-Entry provenance (accepted behind an already-existing later pull).
  // Stable review signal, set once at mutation time; never re-derived from position.
  lateEntry?: boolean;
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
  companyId?: string;
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




// ========== BBLs/Day Calculation Functions ==========
// Ported from WB Mobile functions/index.js — must stay in sync


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

// ── Backdated-CREATE chronological lane ────────────────────────────────────
// Load the well's CURRENT processed chain as engine inputs. Unlike
// getHistoricalPulls this keeps edited rows (their present values) and carries
// dateTimeUTC (ordering authority) + the STORED tankAfterInches as a preserved
// historical bottom (knownBottomInches) — so the engine recomputes only the
// derived relationships affected by a changed predecessor, never a row's tank
// conversion with today's config.
async function loadChronoPulls(wellName: string): Promise<ChronoPullInput[]> {
  const snap = await db.ref('packets/processed').orderByChild('wellName').equalTo(wellName).once('value');
  const out: ChronoPullInput[] = [];
  snap.forEach((child) => {
    const p = child.val() as Record<string, unknown> | null;
    const key = String(child.key);
    if (!p || p.requestType === 'wellHistory' || key.startsWith('history_')) return;
    const dt = typeof p.dateTimeUTC === 'string' ? p.dateTimeUTC : null;
    if (!dt || !Number.isFinite(Date.parse(dt))) return;
    const storedBottom = Number(p.tankAfterInches);
    out.push({
      packetId: key,
      dateTimeUTC: dt,
      tankTopInches: (parseFloat(String(p.tankLevelFeet)) || 0) * 12,
      bblsTaken: parseFloat(String(p.bblsTaken)) || 0,
      wellDown: p.wellDown === true || p.wellDown === 'true',
      ...(Number.isFinite(storedBottom) ? { knownBottomInches: storedBottom } : {}),
      ...(typeof p.operationId === 'string' ? { operationId: p.operationId } : {}),
      ...(typeof p.recoveredFromPacketId === 'string' ? { recoveredFromPacketId: p.recoveredFromPacketId } : {}),
      // Preserve the STORED Late-Entry provenance so a recompute never relabels it.
      ...(typeof p.lateEntry === 'boolean' ? { lateEntry: p.lateEntry } : {}),
    });
    return undefined;
  });
  return out;
}

// EXCLUSIVE per-well serialization is provided by the canonical coordinator's
// leased lock (chronoCommitCoordinator): the entire read→compute→commit runs
// while the lock is held, so no other writer interleaves between plan and
// commit, and a crashed holder's lease expires past the recovery horizon.
// (Legacy backdated-only writer removed 2026-08-28: makeBackdatedIO/
// runBackdatedInsertion is superseded by the unified canonical coordinator.
// The older-CREATE path now routes through runCanonicalMutation +
// buildCreateMutation, exactly like the newest path — ONE writer.)

/**
 * CST/CDT offset in milliseconds.
 * CST = UTC-6, CDT = UTC-5. DST: 2nd Sunday March → 1st Sunday November.
 */
// production/date formulas extracted to ./productionFormulas (imported above).

// (Daily production log is now written as part of the ONE canonical commit in
// processIncomingPull — production/<key>/<date> {a,w,o,u,n} + wellName — never
// as a standalone writeProductionLog set.)

// Anomaly detection constants (tighter than VBA for better accuracy)
// VBA uses 5x/2.5x but that's too loose for wells with consistent flow rates
// AFR flow-rate formulas extracted to ./pullFormulas (imported above).

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

  return computeAFRFromRates(allRates);
}

// Main function: Process incoming pull packets
export const processIncomingPull = functionsV1.runWith({ timeoutSeconds: CANONICAL_COMMIT_TIMEOUT_SECONDS, memory: '512MB' }).database
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
    // Resolved TOTAL bbl/ft for THIS well (edit-path contract: config value, else
    // 20 * tanks). Never a universal 20. Used for tank-after + window/overnight.
    const bblPerFoot = Number(config.bblPerFoot) > 0 ? Number(config.bblPerFoot) : 20 * tanks;

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
      // Complete canonical-order tie-break for equal-timestamp packets.
      incomingPacketId: packetId,
      watermarkPacketId: prevResponse ? prevResponse.lastPullPacketId : undefined,
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

    // Valid OLDER CREATE (Late Entry): accept into chronological history,
    // recompute every affected successor, and commit atomically under the
    // per-well revision fence. The current/outgoing watermark is NEVER regressed.
    if (guardVerdict.action === 'process_backdated') {
      const backdatedTop = (parseFloat(String(data.tankLevelFeet)) || 0) * 12;
      if (backdatedTop <= 0) {
        // No-level (non-production) older pull — a standalone row; no cascade. Still
        // through the ONE coordinator so the row + request removal + receipt are atomic.
        const nowIso = new Date().toISOString();
        const noLevelBackdatedOutcome = await runCanonicalMutation(makeCoordinatorIO(db, wellName), {
          wellName, operationId: packetId,
          buildPatch: async () => {
            const curRev = Number((await db.ref(`wells/${wellName}/status/chronoRevision`).once('value')).val()) || 0;
            const revision = curRev + 1;
            const receipt: CommitReceipt = {
              operationId: packetId, mutationType: 'backdated_create', wellName, fence: revision, revision,
              affectedPacketIds: [packetId], committedAtMs: Date.now(), patchHash: `${packetId}:${revision}:nolevel`,
            };
            const patch = assembleCanonicalPatch({
              processedUpdates: { [`packets/processed/${packetId}`]: { ...data, packetId, noLevel: true, lateEntry: true, processedAt: nowIso } },
              fence: { wellName, revision },
              receipt, receiptPath: receiptPathFor(wellName, packetId),
            });
            patch[`packets/incoming/${packetId}`] = null;
            return { patch, receipt };
          },
        });
        console.log(`[BACKDATED] ${wellName}: ${packetId} → ${noLevelBackdatedOutcome.status} (no-level standalone, 1 atomic update)`);
        return null;
      }
      const cfg: WellChronoConfig = {
        bblPerFoot: Number((config as { bblPerFoot?: unknown }).bblPerFoot) > 0 ? Number((config as { bblPerFoot?: unknown }).bblPerFoot) : 20 * tanks,
        tanks,
        allowedBottomInches: (Number((config as { allowedBottom?: unknown; bottomLevel?: unknown }).allowedBottom ?? (config as { bottomLevel?: unknown }).bottomLevel) || 0) * 12 || undefined,
        avgFlowRateDays: Number((config as { avgFlowRateMinutes?: unknown }).avgFlowRateMinutes) > 0 ? Number((config as { avgFlowRateMinutes?: unknown }).avgFlowRateMinutes) / 1440 : undefined,
      };
      // Route the older CREATE through the SAME canonical coordinator as the
      // newest path — one writer, one atomic patch, one receipt. buildCreateMutation
      // inserts by event time, recomputes every affected successor via the engine
      // (historical bottoms preserved), and leaves current/outgoing unchanged (a
      // backdated insert never becomes newest). Empty sidecar: the current pull's
      // outgoing/status/AFR do not change.
      const chain = await loadChronoPulls(wellName);
      const backdatedNowIso = new Date().toISOString();
      const newPull: ChronoPullInput = {
        packetId, dateTimeUTC: data.dateTimeUTC, tankTopInches: backdatedTop,
        bblsTaken: parseFloat(String(data.bblsTaken)) || 0,
        wellDown: data.wellDown === true || (data.wellDown as unknown) === 'true',
        submittedAtMs: Date.now(),
        // Accepted behind an already-existing later pull → stable Late-Entry provenance.
        lateEntry: true,
        operationId: typeof (data as { operationId?: unknown }).operationId === 'string' ? (data as { operationId?: string }).operationId : undefined,
        recoveredFromPacketId: typeof (data as { recoveredFromPacketId?: unknown }).recoveredFromPacketId === 'string' ? (data as { recoveredFromPacketId?: string }).recoveredFromPacketId : undefined,
      };
      const { pendingEditEvents: _bpe, originalSubmittedValues: _bov, hasQueuedCorrection: _bhq, ...backdatedClean } = data as unknown as Record<string, unknown>;
      const newProcessedRecord: Record<string, unknown> = {
        ...backdatedClean, packetId, tankTopInches: backdatedTop, tankAfterFeet: '',
        processedAt: backdatedNowIso, lateEntry: true,
      };

      // A backdated insert never becomes CURRENT, so outgoing/wells-status/AFR
      // (which derive exclusively from the NEWEST pull) are intentionally left
      // unchanged. But it DOES participate in history aggregates: it gets its own
      // performance row, and its production-date total's pull-count is recomputed
      // from authoritative rows (never blind-incremented → replay-safe). The date's
      // a/w/o rates are preserved when a newer pull on that date already set them
      // (they belong to that later pull), so an old insert cannot regress them.
      const backdatedPullMs = new Date(data.dateTimeUTC).getTime();
      const backdatedProdDate = getProductionDate(backdatedPullMs);
      const backdatedWellKey = wellName.replace(/\s+/g, '_');
      const datePullCount = [...chain, newPull].filter(
        (p) => Number.isFinite(Date.parse(p.dateTimeUTC)) && getProductionDate(Date.parse(p.dateTimeUTC)) === backdatedProdDate,
      ).length;
      const isNewestOnItsDate = ![...chain].some(
        (p) => getProductionDate(Date.parse(p.dateTimeUTC)) === backdatedProdDate && Date.parse(p.dateTimeUTC) > backdatedPullMs,
      );
      let backdatedPerf: { wellKey: string; perfTimestamp: string; row: Record<string, unknown>; wellName: string; updatedIso: string } | null = null;
      try {
        const perf = buildPerformanceRow({
          wellName, dateTimeUTC: data.dateTimeUTC, tankLevelFeet: data.tankLevelFeet,
          predictedLevelInches: data.predictedLevelInches, prevResponse: null,
        });
        backdatedPerf = { wellKey: perf.wellKey, perfTimestamp: perf.perfTimestamp, row: perf.row as unknown as Record<string, unknown>, wellName, updatedIso: backdatedNowIso };
      } catch (e) { console.error(`[BACKDATED] perf build failed:`, e); }

      const outcome = await runCanonicalMutation(makeCoordinatorIO(db, wellName), {
        wellName, operationId: packetId,
        buildPatch: async () => {
          const curRev = Number((await db.ref(`wells/${wellName}/status/chronoRevision`).once('value')).val()) || 0;
          const revision = curRev + 1;
          // Recompute the production date's total from authoritative state: preserve
          // the existing a/w/o (a newer pull owns them) and just set the recomputed
          // count; if this backdated pull IS the newest on its date (empty date), seed
          // from the pull itself.
          const curProd = (await db.ref(`production/${backdatedWellKey}/${backdatedProdDate}`).once('value')).val() as { a?: number; w?: number; o?: number } | null;
          const historicalPulls = await getHistoricalPulls(wellName, 500);
          const winBbls = calculateWindowBblsPerDay(historicalPulls, cfg.bblPerFoot, backdatedPullMs);
          const overBbls = calculateOvernightBblsPerDay(historicalPulls, cfg.bblPerFoot, backdatedPullMs);
          const prodValue = {
            a: (isNewestOnItsDate ? undefined : curProd?.a) ?? 0,
            w: (isNewestOnItsDate ? winBbls : (curProd?.w ?? winBbls)) || 0,
            o: (isNewestOnItsDate ? overBbls : (curProd?.o ?? overBbls)) || 0,
            u: backdatedNowIso,
            n: datePullCount, // authoritative count — never a blind increment
          };
          const backdatedSidecar: CanonicalSidecar = {
            performance: backdatedPerf,
            production: [{ wellKey: backdatedWellKey, date: backdatedProdDate, value: prodValue }],
          };
          const built = buildCreateMutation({
            wellName, operationId: packetId, fence: revision, revision,
            committedAtMs: Date.now(), patchHash: `${packetId}:${revision}`, sidecar: backdatedSidecar,
            existingChain: chain, newPull, newProcessedRecord, cfg,
          });
          // Production label (sibling of the date node) + source-request removal are
          // part of the SAME atomic patch.
          built.patch[`production/${backdatedWellKey}/wellName`] = wellName;
          built.patch[`packets/incoming/${packetId}`] = null;
          return { patch: built.patch, receipt: built.receipt };
        },
      });
      console.log(`[BACKDATED] ${wellName}: ${packetId} → ${outcome.status}`);
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

    // Calculate all fields
    const tankTopInches = computeTankTopInches(data.tankLevelFeet);

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
        lateEntry: false,
      };

      // Even a no-level pull writes business state (the processed row), so it goes
      // through the ONE coordinator: processed row + source-request removal + receipt
      // commit together. No canonical current/outgoing/status change (non-production).
      const noLevelOutcome = await runCanonicalMutation(makeCoordinatorIO(db, wellName), {
        wellName, operationId: packetId,
        buildPatch: async () => {
          const curRev = Number((await db.ref(`wells/${wellName}/status/chronoRevision`).once('value')).val()) || 0;
          const revision = curRev + 1;
          const receipt: CommitReceipt = {
            operationId: packetId, mutationType: 'create', wellName, fence: revision, revision,
            affectedPacketIds: [packetId], committedAtMs: Date.now(), patchHash: `${packetId}:${revision}:nolevel`,
          };
          const patch = assembleCanonicalPatch({
            processedUpdates: { [`packets/processed/${packetId}`]: processedPacket },
            fence: { wellName, revision },
            receipt, receiptPath: receiptPathFor(wellName, packetId),
          });
          patch[`packets/incoming/${packetId}`] = null;
          return { patch, receipt };
        },
      });
      console.log(`[NO-LEVEL] ${wellName}: ${packetId} → ${noLevelOutcome.status} (processed + request consumed, 1 atomic update)`);
      return null;
    }

    const tankAfterInches = computeTankAfterInches(tankTopInches, data.bblsTaken, bblPerFoot);

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
    const recoveryInches = computeRecoveryInches(tankTopInches, prevTankAfterInches);

    const flowRateDays = computeFlowRateDays(timeDifDays, recoveryInches);
    const flowRate = flowRateDays > 0 ? daysToHMMSS(flowRateDays) : '';

    // Calculate AFR
    const afr = await calculateAFR(wellName, flowRateDays);

    // Calculate window-averaged and overnight bbls/day
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
      // Stored Late-Entry provenance: the guard routed this pull to the newest
      // path (strictly newer than the watermark), so it was NOT accepted behind a
      // later pull. This is stable — a future later pull never relabels it.
      lateEntry: false,
    };

    // Write to processed/ — strip client trail-only helpers from the stored pull
    const {
      pendingEditEvents: _pendingEditEvents,
      originalSubmittedValues: _originalSubmittedValues,
      hasQueuedCorrection: _hasQueuedCorrection,
      ...processedClean
    } = processedPacket as any;
    // Keep originalSubmittedAt when a queued correction froze it.
    if ((data as any).originalSubmittedAt) {
      (processedClean as any).originalSubmittedAt = (data as any).originalSubmittedAt;
    }
    // (processed row is written by the ONE canonical commit below — never here.)

    // Materialize queued post-Send correction trail (product: Send is the edit boundary).
    await materializeQueuedEditTrail(packetId, data as any);

    // Calculate current level (for outgoing response)
    // At time of pull, current level = tank after
    // This will be updated by a scheduled function to reflect growth over time
    const currentLevelInches = tankAfterInches;

    // BBLs per 24 hours
    const bbls24hrs = computeBbls24hrs(afr, tanks);

    // Build outgoing response
    const timestamp = new Date();
    const outgoingResponse: OutgoingResponse = buildOutgoingResponse({
      wellName, currentLevelInches, afr, bbls24hrs, nextIsDown, estTimeToPull, estDateTimePull,
      dateTime: data.dateTime, dateTimeUTC: data.dateTimeUTC, bblsTaken: data.bblsTaken,
      driverId: data.driverId, driverName: data.driverName, tankTopInches, tankAfterInches,
      packetId, config, timestampIso: timestamp.toISOString(), windowBblsDay, overnightBblsDay,
    }) as unknown as OutgoingResponse;

    // Collect the prior response ids for this well — the canonical commit deletes
    // them and writes the new one in ONE atomic update (never a read-then-remove
    // race, never a partial outgoing/current state).
    const oldResponses = await db.ref('packets/outgoing')
      .orderByChild('wellName')
      .equalTo(wellName)
      .once('value');
    const oldResponseIds: string[] = [];
    oldResponses.forEach((child) => { if (child.key) oldResponseIds.push(child.key); });

    const responseId = `response_${timestamp.toISOString().replace(/[-:]/g, '').replace('T', '_').split('.')[0]}_${cleanName}`;

    // Performance row — computed here, committed atomically below.
    let perfPiece: { wellKey: string; perfTimestamp: string; row: Record<string, unknown>; wellName: string; updatedIso: string } | null = null;
    try {
      const perf = buildPerformanceRow({
        wellName, dateTimeUTC: data.dateTimeUTC, tankLevelFeet: data.tankLevelFeet,
        predictedLevelInches: data.predictedLevelInches, prevResponse,
      });
      perfPiece = { wellKey: perf.wellKey, perfTimestamp: perf.perfTimestamp, row: perf.row as unknown as Record<string, unknown>, wellName, updatedIso: new Date().toISOString() };
      console.log(`[Performance] ${wellName}: a=${perf.row.a} p=${perf.row.p}`);
    } catch (perfError) {
      console.error(`[Performance] Error building perf row for ${wellName}:`, perfError);
    }

    // AFR rolling values (well_config) — committed atomically below.
    let afrPiece: { wellName: string; avgFlowRate: string; avgFlowRateMinutes: number } | null = null;
    if (afr > 0) {
      const afrMin = afr * 24 * 60;
      afrPiece = { wellName, avgFlowRate: daysToHMMSS(afr), avgFlowRateMinutes: Math.round(afrMin * 100) / 100 };
    }

    // ============================================================
    // NEW UNIFIED STRUCTURE - Write to wells/{name}/status + history
    // This is THE single source of truth going forward
    // ============================================================
    const afrMinutes = afr > 0 ? afr * 24 * 60 : 0;

    const wellStatus: WellStatus = buildWellStatus({
      wellName, tanks, bottomInches, route: config.route, pullBbls,
      currentLevelInches, dateTime: data.dateTime, dateTimeUTC: data.dateTimeUTC,
      tankTopInches, tankAfterInches, bblsTaken: data.bblsTaken, driverName: data.driverName,
      packetId, afr, afrMinutes, bbls24hrs, estDateTimePull, estTimeToPull, nextIsDown,
      nowIso: new Date().toISOString(),
    }) as unknown as WellStatus;

    // Production value (AFR + window + overnight bbls/day) for THIS pull's date.
    const afrBblsDay = afr > 0 ? Math.round((1 / afr) * bblPerFoot) : 0;
    const prodWellKey = wellName.replace(/\s+/g, '_');
    const prodDate = getProductionDate(pullTimeMs);

    // ── ONE canonical commit ───────────────────────────────────────────────
    // processed + outgoing(delete olds + new) + wells/status + performance +
    // production + well_config AFR + chronoRevision + completion receipt land as
    // a single atomic multipath update, serialized by the per-well lock. Nothing
    // above wrote any of these paths directly. The receipt is part of the SAME
    // update, so it can never exist without the canonical state (and vice versa).
    const commitOutcome = await runCanonicalMutation(makeCoordinatorIO(db, wellName), {
      wellName, operationId: packetId,
      buildPatch: async () => {
        // Monotonic well revision — decoupled from the coordinator's lock fence
        // (which resets each lock lifecycle). Read+increment under the held lock.
        const curRev = Number((await db.ref(`wells/${wellName}/status/chronoRevision`).once('value')).val()) || 0;
        const revision = curRev + 1;
        // Production pull-count for the date (read under the lock).
        const curProd = (await db.ref(`production/${prodWellKey}/${prodDate}`).once('value')).val() as { n?: number } | null;
        const nowIso = new Date().toISOString();
        const receipt: CommitReceipt = {
          operationId: packetId, mutationType: 'create', wellName, fence: revision, revision,
          affectedPacketIds: [packetId], committedAtMs: Date.now(), patchHash: `${packetId}:${revision}`,
        };
        const patch = assembleCanonicalPatch({
          processedUpdates: { [`packets/processed/${packetId}`]: processedClean },
          outgoing: { deleteResponseIds: oldResponseIds, responseId, response: outgoingResponse as unknown as Record<string, unknown> },
          wellStatus: { wellName, status: wellStatus as unknown as Record<string, unknown> },
          performance: perfPiece,
          production: [{ wellKey: prodWellKey, date: prodDate, value: { a: afrBblsDay || 0, w: windowBblsDay || 0, o: overnightBblsDay || 0, u: nowIso, n: (curProd?.n || 0) + 1 } }],
          afr: afrPiece,
          // Also stamp production wellName label (sibling of the date node).
          fence: { wellName, revision },
          receipt, receiptPath: receiptPathFor(wellName, packetId),
        });
        patch[`production/${prodWellKey}/wellName`] = wellName;
        // Source-request consumption is PART of the same atomic update — canonical
        // state + receipt + incoming removal commit together, closing the crash
        // window where state is written but the request lingers for reprocessing.
        patch[`packets/incoming/${packetId}`] = null;
        return { patch, receipt };
      },
    });
    if (commitOutcome.status !== 'committed' && commitOutcome.status !== 'already_done') {
      // contended / lost_ownership / commit_failed → leave the incoming packet in
      // place for the trigger to retry; do NOT partially write anything.
      console.error(`[CANONICAL] ${wellName}: ${packetId} → ${commitOutcome.status} (incoming left for retry)`);
      return null;
    }
    console.log(`[CANONICAL] ${wellName}: ${packetId} → ${commitOutcome.status} (processed+outgoing+status+perf+production+afr+receipt, 1 atomic update)`);

    await notifyIncomingVersionBestEffort(db.ref('packets/incoming_version'), {
      outgoingCommitted: true,
      pullAccepted: true,
    });

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
          await fs.collection('dispatches').doc(ctxDispatchId).update({
            lastPullPacketId: packetId,
            lastPullPacketAt: admin.firestore.FieldValue.serverTimestamp(),
            canonicalJobId: result.canonicalJobId,
            // Multi-load history — arrayUnion is idempotent on reprocess.
            pullPacketIds: admin.firestore.FieldValue.arrayUnion(packetId),
          });
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

    // (incoming/ was consumed as part of the ONE canonical atomic update above —
    // never a separate write.)

    console.log(`Processed ${wellName}: ${packetId} -> ${responseId}`);

    // Await chat + JSA tracking — 1st gen CFs can kill fire-and-forget promises after return.
    // These are fast Firestore writes, adds ~1-2s to packet processing but guarantees delivery.
    try {
      await Promise.all([
        sendLevelToChat(data, packetId, { tankAfterInches, tanks }).catch(err => console.warn('[LevelChat] Send failed:', err)),
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

// ── v2 chronological correction support ──────────────────────────────────

type V2CorrectionEntry = { t: string; v: EditableSnapshot; e?: string; src?: string };

/**
 * Test-only barriers. applyV2ChronologicalEdit awaits each once (then clears it)
 * at a specific point, letting a test deterministically interleave a newer
 * correction: `beforeClassification` fires just before the receipt/effect
 * classification writes; `beforeProjection` fires just before the first derived
 * projection write. Both null (no-op) in production.
 */
export const __v2FollowupBarrier: {
  beforeClassification: null | (() => Promise<void>);
  beforeProjection: null | (() => Promise<void>);
} = { beforeClassification: null, beforeProjection: null };

/**
 * Fence a P-scoped mutable node (a receipt or a trail effect) by a revision
 * field. A write carrying `myRev` is a no-op when the node already stores a
 * GREATER revision — the newer classification wins. Immutable `core` fields are
 * backfilled even when fenced, so durable receipt proof always exists.
 */
async function fencedRevWrite(
  ref: admin.database.Reference,
  revField: string,
  myRev: number,
  values: Record<string, unknown>,
  core?: Record<string, unknown>,
): Promise<void> {
  await ref.transaction((cur: any) => {
    const node = cur && typeof cur === 'object' && cur !== null ? cur : {};
    if ((Number(node[revField]) || 0) > myRev) {
      if (core) return { ...core, ...node }; // fenced: keep newer node, ensure core
      return node; // fenced: no-op
    }
    return { ...node, ...(core || {}), ...values, [revField]: myRev };
  });
}

/**
 * Fence a shared derived projection (outgoing / AFR / performance / next-pull
 * cascade / live status) by the SOURCE packet's revision. A write from packet P
 * at `myRev` is a no-op when that target was last written by P at a greater
 * revision. A different source packet (a newer pull taking over) passes — pull
 * ordering, not this fence, arbitrates across distinct pulls.
 */
async function fencedSourceWrite(
  ref: admin.database.Reference,
  sourceId: string,
  myRev: number,
  values: Record<string, unknown>,
): Promise<void> {
  await ref.transaction((cur: any) => {
    const node = cur && typeof cur === 'object' && cur !== null ? cur : {};
    const sameSource = node.editSourceId === undefined || node.editSourceId === sourceId;
    if (sameSource && (Number(node.editSourceRev) || 0) > myRev) return; // fenced no-op
    return { ...node, ...values, editSourceId: sourceId, editSourceRev: myRev };
  });
}

interface EditNeighbor {
  key: string;
  dateTimeUTC: string;
  tankAfterInches: number;
  tankTopInches: number;
}

/**
 * Pure derived tank math for an edited pull, from MATERIALIZED editable values.
 * Identical arithmetic to processIncomingPull / the legacy edit path; kept pure
 * so it can run both inside the convergent transaction and in the follow-ups.
 */
function computeEditDerived(
  newTankTopInches: number,
  newBblsTaken: number,
  newDateTimeUTC: string,
  bblPerFoot: number,
  loadLineInches: number,
  neighbors: EditNeighbor[],
  selfKey: string,
  fallbackTimeDifDays: number,
  fallbackTimeDif: string,
): {
  newTankAfterInches: number;
  rawNewTankAfterInches: number;
  editHitLoadLine: boolean;
  recoveryInches: number;
  flowRateDays: number;
  flowRate: string;
  timeDif: string;
  timeDifDays: number;
} {
  const bblsInInches = newBblsTaken > 0 ? (newBblsTaken / bblPerFoot) * 12 : 0;
  const rawNewTankAfterInches = newTankTopInches - bblsInInches;
  const newTankAfterInches = Math.max(rawNewTankAfterInches, loadLineInches);
  const editHitLoadLine = rawNewTankAfterInches < loadLineInches;

  const editedTime = new Date(newDateTimeUTC).getTime();
  let prevTankAfterInches = 0;
  let prevTimestamp = '';
  for (const n of neighbors) {
    if (n.key === selfKey) continue;
    const pktTime = new Date(n.dateTimeUTC).getTime();
    if (!isNaN(pktTime) && pktTime < editedTime) {
      if (!prevTimestamp || pktTime > new Date(prevTimestamp).getTime()) {
        prevTankAfterInches = n.tankAfterInches || 0;
        prevTimestamp = n.dateTimeUTC;
      }
    }
  }

  let timeDifDays = fallbackTimeDifDays || 0;
  let timeDif = fallbackTimeDif || '';
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
      flowRateDays = 0;
    } else {
      flowRate = daysToHMMSS(flowRateDays);
    }
  }
  return {
    newTankAfterInches,
    rawNewTankAfterInches,
    editHitLoadLine,
    recoveryInches,
    flowRateDays,
    flowRate,
    timeDif,
    timeDifDays,
  };
}

/**
 * Apply one v2 event-time correction with chronological, per-field precedence.
 *
 * Convergence: all accepted corrections for a packet live in
 * packets/processed/{id}/editCorrections keyed by editEventId. A single RTDB
 * transaction merges this correction into that map and re-materializes the
 * editable fields from {frozen baseline, full correction set}. Because RTDB
 * re-runs the update until commit, concurrent triggers / retries never drop a
 * correction, and the committed editable + derived state is a pure function of
 * the correction SET — independent of arrival, trigger, or retry order. The
 * immutable durable trail (editHistory) and receipt are written afterward.
 */
export async function applyV2ChronologicalEdit(args: {
  data: Record<string, any>;
  origPacket: Record<string, any>;
  originalPacketId: string;
  wellName: string;
  editEventId: string;
  incomingPacketId: string;
  editResolvedViaFallback: boolean;
  fallbackAuditFields: Record<string, unknown>;
}): Promise<void> {
  const {
    data,
    origPacket,
    originalPacketId,
    wellName,
    editEventId,
    incomingPacketId,
    editResolvedViaFallback,
    fallbackAuditFields,
  } = args;

  const correctionCreatedAtUTC = String(data.correctionCreatedAtUTC);
  const serverReceivedAtUTC = new Date().toISOString();
  const editSource = normalizeEditSource(data.source);
  const originAppContext =
    normalizeOriginAppContext(origPacket.originAppContext) !== 'unknown'
      ? normalizeOriginAppContext(origPacket.originAppContext)
      : normalizeOriginAppContext(data.originAppContext);
  // Frozen original baseline (stored once, or the current original on the
  // first edit) — the START of chronological replay, NOT an assertion filter.
  const frozenBaseline: EditableSnapshot =
    origPacket.editBaseline && typeof origPacket.editBaseline === 'object'
      ? (origPacket.editBaseline as EditableSnapshot)
      : buildEditBaseline(origPacket as Record<string, unknown>);
  // Which fields this correction touched comes from its EXPLICIT editedFields
  // mask. A governed v2 request that reached here without a valid mask must
  // fail closed (quarantine) — it must never silently downgrade to legacy.
  const editedFieldsRaw = (data as { editedFields?: unknown }).editedFields;
  if (!Array.isArray(editedFieldsRaw) || editedFieldsRaw.length === 0
    || !editedFieldsRaw.every((f) => typeof f === 'string')) {
    console.error(`[V2_EDIT_INVALID_MASK] ${wellName}: ${editEventId} on ${originalPacketId} — missing/invalid editedFields`);
    await quarantineIncomingPacket(db.ref(), {
      packetId: incomingPacketId,
      packet: data,
      verdict: orphanEditVerdict(originalPacketId),
      nowMs: Date.now(),
    });
    return;
  }
  const correctionValues = assertedFromEditedFields(
    data as Record<string, unknown>,
    editedFieldsRaw as string[],
  );
  const originalSubmissionAt =
    resolveEditAuditContext(origPacket as Record<string, unknown>).originalSubmissionAt ||
    resolveOriginalSubmissionAt(origPacket as Record<string, unknown>);

  // Well config (static during this edit) — read once, used inside the txn.
  const cleanName = wellName.replace(/\s/g, '');
  let configSnap = await db.ref(`well_config/${wellName}`).once('value');
  if (!configSnap.exists()) configSnap = await db.ref(`well_config/${cleanName}`).once('value');
  const config = configSnap.val() || {};
  const tanks = config.tanks || config.numTanks || DEFAULTS.tanks;
  const bblPerFoot = Number(config.bblPerFoot) > 0 ? Number(config.bblPerFoot) : 20 * tanks;
  const pullBbls = config.pullBbls || DEFAULTS.pullBbls;
  const bottomInches = (config.bottomLevel || config.allowedBottom || DEFAULTS.bottomLevel) * 12;
  const loadLineInches = (config.loadLine ?? DEFAULTS.loadLine) * 12;

  // Neighbor pulls for this well (static set) — used to pick the previous pull
  // for recovery/flow, and later the next pull for the cascade.
  const neighborSnap = await db
    .ref('packets/processed')
    .orderByChild('wellName')
    .equalTo(wellName)
    .once('value');
  const neighbors: EditNeighbor[] = [];
  neighborSnap.forEach((child) => {
    const p = child.val() || {};
    neighbors.push({
      key: String(child.key),
      dateTimeUTC: typeof p.dateTimeUTC === 'string' ? p.dateTimeUTC : '',
      tankAfterInches: Number(p.tankAfterInches) || 0,
      tankTopInches: Number(p.tankTopInches) || 0,
    });
  });

  // ── Transactional convergence: editable + derived from the full set ──────
  const txn = await db.ref(`packets/processed/${originalPacketId}`).transaction((cur: any) => {
    const src = cur && typeof cur === 'object' ? cur : origPacket;
    const baseline: EditableSnapshot =
      src.editBaseline && typeof src.editBaseline === 'object' ? src.editBaseline : frozenBaseline;
    const corrections: Record<string, V2CorrectionEntry> = { ...(src.editCorrections || {}) };
    corrections[editEventId] = {
      t: correctionCreatedAtUTC,
      v: correctionValues,
      e: serverReceivedAtUTC,
      src: editSource,
    };
    const evs = Object.entries(corrections).map(([id, c]) => ({
      eventId: id,
      correctionCreatedAtUTC: c.t,
      correctionValues: (c.v || {}) as EditableSnapshot,
    }));
    const mat = materializeEditableFields(baseline, evs);
    const f = mat.fields;
    const newTop = typeof f.tankTopInches === 'number' ? f.tankTopInches : Number(src.tankTopInches) || 0;
    const newBbls = typeof f.bblsTaken === 'number' ? f.bblsTaken : Number(src.bblsTaken) || 0;
    const newUTC = typeof f.dateTimeUTC === 'string' && f.dateTimeUTC
      ? f.dateTimeUTC
      : (typeof src.dateTimeUTC === 'string' ? src.dateTimeUTC : '');
    const newDisplay = typeof f.dateTime === 'string' ? f.dateTime : (src.dateTime || '');
    const newDown = f.wellDown === true;

    const next: any = {
      ...src,
      editBaseline: baseline,
      editCorrections: corrections,
      // Monotonic materialization revision — bumped on every committed apply.
      // Follow-up writes (receipts, projections) guard on this so a stale
      // invocation can never overwrite a newer correction set's output.
      materializationRev: (Number(src.materializationRev) || 0) + 1,
      bblsTaken: newBbls,
      wellDown: newDown,
      dateTimeUTC: newUTC,
      dateTime: newDisplay,
      editedAt: serverReceivedAtUTC,
      editedBy: editSource,
      editCount: Object.keys(corrections).length,
      ...fallbackAuditFields,
    };
    if (!src.originalSubmittedAt && originalSubmissionAt) next.originalSubmittedAt = originalSubmissionAt;
    if (typeof data.revisionAt === 'string' && data.revisionAt) next.lastRevisionAt = data.revisionAt;

    if (newTop <= 0) {
      next.tankTopInches = 0;
      next.tankLevelFeet = 0;
      next.tankAfterInches = 0;
      next.tankAfterFeet = '';
      next.noLevel = true;
    } else {
      const d = computeEditDerived(
        newTop, newBbls, newUTC, bblPerFoot, loadLineInches, neighbors, originalPacketId,
        Number(src.timeDifDays) || 0, typeof src.timeDif === 'string' ? src.timeDif : '',
      );
      next.tankTopInches = newTop;
      next.tankLevelFeet = newTop / 12;
      next.tankAfterInches = d.newTankAfterInches;
      next.tankAfterFeet = inchesToFeetInches(d.newTankAfterInches);
      next.rawCalculatedBottomInches = d.rawNewTankAfterInches;
      next.hitLoadLine = d.editHitLoadLine;
      next.recoveryInches = d.recoveryInches;
      next.flowRateDays = d.flowRateDays;
      next.flowRate = d.flowRate;
      next.timeDif = d.timeDif;
      next.timeDifDays = d.timeDifDays;
      next.noLevel = false;
    }
    return next;
  });

  if (!txn.committed || !txn.snapshot || !txn.snapshot.exists()) {
    // Original vanished mid-flight — do not fabricate. Leave the incoming for
    // the watchdog; the correction is not lost.
    console.error(`[V2_EDIT_ABORT] ${wellName}: could not converge ${editEventId} on ${originalPacketId}`);
    return;
  }

  // Correctness comes from the per-write REVISION FENCE below, never from a
  // pre-write re-read. We classify + project from our own committed snapshot;
  // any of these writes that carries a revision older than what a target
  // already holds is a no-op at the write itself (compare-and-set). Because the
  // transaction bumps the revision monotonically AND includes every previously
  // committed correction, the highest-revision apply necessarily has the
  // fullest set and its fenced writes win every target.
  const committed = txn.snapshot.val() as Record<string, any>;
  const myRev = Number(committed.materializationRev) || 0;
  const baseline: EditableSnapshot =
    committed.editBaseline && typeof committed.editBaseline === 'object'
      ? committed.editBaseline
      : frozenBaseline;
  const correctionsMap: Record<string, V2CorrectionEntry> = committed.editCorrections || {};
  const allEvents = Object.entries(correctionsMap).map(([id, c]) => ({
    eventId: id,
    correctionCreatedAtUTC: c.t,
    correctionValues: (c.v || {}) as EditableSnapshot,
  }));
  const matFinal = materializeEditableFields(baseline, allEvents);
  const newTankTopInches = typeof matFinal.fields.tankTopInches === 'number' ? matFinal.fields.tankTopInches : 0;
  const newBblsTaken = typeof matFinal.fields.bblsTaken === 'number' ? matFinal.fields.bblsTaken : 0;
  const newDateTimeUTC = typeof matFinal.fields.dateTimeUTC === 'string' && matFinal.fields.dateTimeUTC
    ? matFinal.fields.dateTimeUTC
    : (origPacket.dateTimeUTC || '');
  const newDateTime = typeof matFinal.fields.dateTime === 'string' ? matFinal.fields.dateTime : '';
  const newWellDown = matFinal.fields.wellDown === true;
  const derived = computeEditDerived(
    newTankTopInches, newBblsTaken, newDateTimeUTC, bblPerFoot, loadLineInches, neighbors, originalPacketId,
    Number(committed.timeDifDays) || 0, typeof committed.timeDif === 'string' ? committed.timeDif : '',
  );
  const newTankAfterInches = newTankTopInches <= 0 ? 0 : derived.newTankAfterInches;

  // ── Durable trail event (immutable) with chronological before/after ──────
  const priorEvents = allEvents.filter((e) =>
    e.eventId !== editEventId
    && compareEditEvents(e, { eventId: editEventId, correctionCreatedAtUTC, correctionValues }) < 0);
  const matBefore = materializeEditableFields(baseline, priorEvents);
  const fieldDiff = buildFieldDiff(
    {
      tankTopInches: matBefore.fields.tankTopInches ?? undefined,
      tankLevelFeet: typeof matBefore.fields.tankTopInches === 'number' ? matBefore.fields.tankTopInches / 12 : undefined,
      bblsTaken: matBefore.fields.bblsTaken ?? undefined,
      dateTimeUTC: matBefore.fields.dateTimeUTC ?? undefined,
      dateTime: matBefore.fields.dateTime ?? undefined,
      wellDown: matBefore.fields.wellDown ?? undefined,
    } as Record<string, unknown>,
    {
      tankTopInches: correctionValues.tankTopInches ?? undefined,
      bblsTaken: correctionValues.bblsTaken ?? undefined,
      dateTimeUTC: correctionValues.dateTimeUTC ?? undefined,
      dateTime: correctionValues.dateTime ?? undefined,
      wellDown: correctionValues.wellDown ?? undefined,
    },
  );
  const outcome = classifyEditOutcome(editEventId, correctionValues, matFinal.authority);
  const editEvent = buildAppliedEditEvent({
    eventId: editEventId,
    packetId: originalPacketId,
    sequence: Object.keys(correctionsMap).length,
    editedAt: serverReceivedAtUTC,
    source: editSource,
    originAppContext,
    actorDriverId: data.driverId ?? origPacket.driverId ?? null,
    actorDriverName: data.driverName ?? null,
    clientAppVersion: data.clientAppVersion ?? null,
    fields: fieldDiff,
    originalSubmissionAt,
    resolutionPath: editResolvedViaFallback ? 'invoiceDocId_fallback' : 'direct',
    editRequestId: incomingPacketId,
    correctionCreatedAtUTC,
    serverReceivedAtUTC,
    correctionValues,
  });

  // Immutable event insertion — write-once, keyed by editEventId. Carries only
  // the change it made (never mutable effect), so it is idempotent and needs no
  // fence. `.update` merges, so it never clobbers the fenced currentEffect child.
  await db.ref(`packets/editHistory/${originalPacketId}/${editEventId}`)
    .update(editEvent as unknown as Record<string, unknown>);

  // Test seam: pause immediately before the classification writes.
  if (__v2FollowupBarrier.beforeClassification) {
    const hook = __v2FollowupBarrier.beforeClassification;
    __v2FollowupBarrier.beforeClassification = null;
    await hook();
  }

  // Fence-classify EVERY correction's receipt + trail effect against our
  // materialized set. Each write is a compare-and-set on the classification
  // revision: a write older than the target's stored revision is a no-op, so a
  // stale apply can never overwrite a newer classification. Superseded events
  // stay in the trail — only their effect annotation moves. The receipt's
  // immutable core (durable proof) is backfilled even when the fence blocks a
  // stale classification, so a receipt is never left without proof.
  for (const [id, c] of Object.entries(correctionsMap)) {
    const oc = classifyEditOutcome(id, (c.v || {}) as EditableSnapshot, matFinal.authority);
    const effect = {
      outcome: oc.outcome,
      fieldsAffectingCurrent: oc.fieldsAffectingCurrent,
      fieldsSuperseded: oc.fieldsSuperseded,
    };
    const core = id === editEventId
      ? {
        editEventId,
        originalPacketId,
        payloadDigest: typeof data.payloadDigest === 'string' ? data.payloadDigest : null,
        status: 'accepted',
        appliedAt: serverReceivedAtUTC,
        correctionCreatedAtUTC: typeof c.t === 'string' ? c.t : correctionCreatedAtUTC,
        serverReceivedAtUTC: typeof c.e === 'string' ? c.e : serverReceivedAtUTC,
        serverAppliedAtUTC: serverReceivedAtUTC,
      }
      : undefined;
    await fencedRevWrite(db.ref(`packets/editReceipts/${id}`), 'classificationRev', myRev, effect, core);
    await fencedRevWrite(
      db.ref(`packets/editHistory/${originalPacketId}/${id}/currentEffect`), 'rev', myRev, effect,
    );
  }

  // Test seam: pause immediately before the first derived projection write.
  if (__v2FollowupBarrier.beforeProjection) {
    const hook = __v2FollowupBarrier.beforeProjection;
    __v2FollowupBarrier.beforeProjection = null;
    await hook();
  }

  // Live wellDown status: only authoritative edits flip it (mirror legacy).
  // Fenced by source revision so a stale apply cannot revert it.
  const editIsAuthoritative = data.wellDownIsAuthoritative === true && data.wellDown !== undefined;
  const editExistingIsDownSnap = await db.ref(`wells/${wellName}/status/isDown`).once('value');
  const nextEditIsDown = editIsAuthoritative ? newWellDown : editExistingIsDownSnap.val() === true;
  await fencedSourceWrite(db.ref(`wells/${wellName}/status`), originalPacketId, myRev, { isDown: nextEditIsDown });

  // Cascade: recompute the NEXT pull's recovery/flow off our new tankAfter.
  if (newTankTopInches > 0) {
    const editedTime = new Date(newDateTimeUTC).getTime();
    let nextKey: string | null = null;
    let nextPkt: EditNeighbor | null = null;
    let closest = Infinity;
    for (const n of neighbors) {
      if (n.key === originalPacketId) continue;
      const t = new Date(n.dateTimeUTC).getTime();
      if (!isNaN(t) && t > editedTime && t < closest) {
        closest = t;
        nextKey = n.key;
        nextPkt = n;
      }
    }
    if (nextKey && nextPkt && nextPkt.tankTopInches > 0) {
      const nextRecovery = Math.max(0, nextPkt.tankTopInches - newTankAfterInches);
      const nextTimeDifDays = (closest - editedTime) / (1000 * 60 * 60 * 24);
      let nextFlowRateDays = 0;
      let nextFlowRate = '';
      if (nextRecovery > 0 && nextTimeDifDays > 0) {
        nextFlowRateDays = (nextTimeDifDays / nextRecovery) * 12;
        nextFlowRate = daysToHMMSS(nextFlowRateDays);
      }
      await fencedSourceWrite(db.ref(`packets/processed/${nextKey}`), originalPacketId, myRev, {
        recoveryInches: nextRecovery,
        flowRateDays: nextFlowRateDays,
        flowRate: nextFlowRate,
      });
    }
  }

  // Outgoing response + AFR + windows (only if this is the latest pull).
  const afr = await calculateAFR(wellName, derived.flowRateDays);
  const editHistoricalPulls = await getHistoricalPulls(wellName, 500);
  const editPullTimeMs = new Date(newDateTimeUTC).getTime();
  const editWindowBblsDay = calculateWindowBblsPerDay(editHistoricalPulls, bblPerFoot, editPullTimeMs);
  const editOvernightBblsDay = calculateOvernightBblsPerDay(editHistoricalPulls, bblPerFoot, editPullTimeMs);

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
    if (resp.lastPullDateTimeUTC === origPacket.dateTimeUTC || resp.lastPullDateTimeUTC === newDateTimeUTC) {
      isLatestPull = true;
    }
  });
  if (!hasOutgoing) isLatestPull = true;

  if (isLatestPull && afr > 0) {
    const pullHeightInches = (pullBbls / bblPerFoot) * 12;
    const targetLevel = bottomInches + pullHeightInches;
    const recoveryNeeded = Math.max(0, targetLevel - newTankAfterInches);
    let estTimeToPull = '';
    let estDateTimePull = '';
    if (recoveryNeeded > 0) {
      const estDays = (recoveryNeeded / 12) * afr;
      estTimeToPull = daysToHMM(estDays);
      const estDate = new Date(new Date(newDateTimeUTC).getTime() + estDays * 24 * 60 * 60 * 1000);
      estDateTimePull = estDate.toISOString();
    } else {
      estTimeToPull = '0:00';
      estDateTimePull = newDateTimeUTC;
    }
    const bbls24 = (1 / afr) * bblPerFoot;
    const bbls24hrs = Math.round(bbls24).toString();
    const outFields = {
      currentLevel: inchesToFeetInches(newTankAfterInches),
      flowRate: daysToHMMSS(afr),
      bbls24hrs,
      lastPullTopLevel: inchesToFeetInches(newTankTopInches),
      lastPullBottomLevel: inchesToFeetInches(newTankAfterInches),
      lastPullBbls: newBblsTaken.toString(),
      lastPullDateTime: newDateTime || formatLocalDateTime(new Date(newDateTimeUTC)),
      lastPullDateTimeUTC: newDateTimeUTC,
      timeTillPull: nextEditIsDown ? 'Down' : (estTimeToPull || 'Calculating...'),
      nextPullTime: estDateTimePull ? formatLocalDateTime(new Date(estDateTimePull)) : 'Unknown',
      nextPullTimeUTC: estDateTimePull,
      isEdit: true,
      originalPacketId,
      wellDown: nextEditIsDown,
      lastPullDriverId: origPacket.driverId || null,
      lastPullDriverName: origPacket.driverName || null,
      lastPullPacketId: originalPacketId,
      windowBblsDay: editWindowBblsDay > 0 ? editWindowBblsDay.toString() : null,
      overnightBblsDay: editOvernightBblsDay > 0 ? editOvernightBblsDay.toString() : null,
      companyId: outgoingCompanyId(config),
    };
    if (hasOutgoing) {
      const updates: Array<Promise<unknown>> = [];
      outgoingSnap.forEach((child) => {
        updates.push(fencedSourceWrite(child.ref, originalPacketId, myRev, outFields));
      });
      await Promise.all(updates);
    } else {
      const responseTimestamp = new Date();
      const responseId = `response_${responseTimestamp.toISOString().replace(/[-:]/g, '').replace('T', '_').split('.')[0]}_${cleanName}`;
      await fencedSourceWrite(db.ref(`packets/outgoing/${responseId}`), originalPacketId, myRev, {
        wellName,
        ...outFields,
        status: 'success',
        timestamp: responseTimestamp.toISOString(),
        timestampUTC: responseTimestamp.toISOString(),
      });
    }
    const afrMinutes = afr * 24 * 60;
    await fencedSourceWrite(db.ref(`well_config/${wellName}`), originalPacketId, myRev, {
      avgFlowRate: daysToHMMSS(afr),
      avgFlowRateMinutes: Math.round(afrMinutes * 100) / 100,
    });
  }

  // Performance row (WB-M reads here). Clean up an old row if the date moved.
  try {
    const perfPullTime = new Date(newDateTimeUTC);
    const perfTimestamp = `${perfPullTime.getFullYear()}${String(perfPullTime.getMonth() + 1).padStart(2, '0')}${String(perfPullTime.getDate()).padStart(2, '0')}_${String(perfPullTime.getHours()).padStart(2, '0')}${String(perfPullTime.getMinutes()).padStart(2, '0')}${String(perfPullTime.getSeconds()).padStart(2, '0')}`;
    const perfWellKey = wellName.replace(/\s+/g, '_');
    const actualInches = Math.floor(newTankTopInches);
    if (typeof origPacket.dateTimeUTC === 'string' && origPacket.dateTimeUTC && origPacket.dateTimeUTC !== newDateTimeUTC) {
      const oldPullTime = new Date(origPacket.dateTimeUTC);
      const oldPerfTimestamp = `${oldPullTime.getFullYear()}${String(oldPullTime.getMonth() + 1).padStart(2, '0')}${String(oldPullTime.getDate()).padStart(2, '0')}_${String(oldPullTime.getHours()).padStart(2, '0')}${String(oldPullTime.getMinutes()).padStart(2, '0')}${String(oldPullTime.getSeconds()).padStart(2, '0')}`;
      if (oldPerfTimestamp !== perfTimestamp) {
        await db.ref(`performance/${perfWellKey}/rows/${oldPerfTimestamp}`).remove();
      }
    }
    const predicted = Number(origPacket.predictedInches) > 0 ? Number(origPacket.predictedInches) : actualInches;
    await fencedSourceWrite(db.ref(`performance/${perfWellKey}/rows/${perfTimestamp}`), originalPacketId, myRev, {
      d: `${perfPullTime.getFullYear()}-${String(perfPullTime.getMonth() + 1).padStart(2, '0')}-${String(perfPullTime.getDate()).padStart(2, '0')}`,
      a: actualInches,
      p: predicted,
    });
  } catch (perfErr) {
    console.error(`[V2_EDIT_PERF] ${wellName}: performance row update failed`, perfErr);
  }

  // Consume the incoming packet last — after durable history + receipt exist.
  await removeIncomingPacket(db.ref(), incomingPacketId);
  console.log(
    `[V2_EDIT_APPLIED] ${wellName}: ${editEventId} (${outcome.outcome}) on ${originalPacketId} — ` +
      `affects=[${outcome.fieldsAffectingCurrent.join(',')}] superseded=[${outcome.fieldsSuperseded.join(',')}]`,
  );
}

// Handle edit requests — updates processed packet and recalculates dependent fields.
// processIncomingEdit IS the production handler. Tests must invoke it with the
// exact incoming payload; do not mirror apply in a parallel lifecycle.
export const processEditRequest = functionsV1.runWith({ timeoutSeconds: CANONICAL_COMMIT_TIMEOUT_SECONDS, memory: '512MB' }).database
  .ref('packets/incoming/{packetId}')
  .onCreate(processIncomingEdit);

export async function processIncomingEdit(
  snapshot: functionsV1.database.DataSnapshot,
  context: { params: { packetId: string } },
): Promise<null> {
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
    // The requested id may be a client-persisted stale-rejected twin while
    // the REAL processed pull carries the same immutable invoiceDocId.
    // Resolution: exact id → use it (unchanged); missing + exactly one
    // invoiceDocId candidate → use the processed pull (ITS id stays
    // canonical everywhere below — the phantom is never stamped); zero →
    // the existing orphan quarantine; multiple → explicit ambiguity
    // quarantine. Never resolved by timestamp/well/driver/quantity.
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
      // GS3 7/22/2026: five driver edits targeting stale-deleted originals
      // were silently removed here. Quarantine instead — the edit's values
      // are the driver's ground truth and may be the only surviving copy.
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

    // From here on, `originalPacketId` is the CANONICAL processed pull id —
    // every downstream write, back-patch, and linkage stamp uses it. On a
    // fallback the requested phantom id appears only in audit fields.
    const originalPacketId = resolution.packetId;
    const editResolvedViaFallback = resolution.kind === 'fallback';
    if (editResolvedViaFallback) {
      console.log(
        `[EDIT_FALLBACK_RESOLVED] ${wellName}: requested ${requestedPacketId} missing — ` +
          `resolved by exact invoiceDocId to processed ${originalPacketId}`,
      );
    }
    const origPacket = resolution.packet as Record<string, any>;
    // Audit indication persisted with the edit application (both update paths).
    const fallbackAuditFields = editResolvedViaFallback
      ? {
          editResolvedVia: 'invoiceDocId_fallback',
          editRequestedPacketId: requestedPacketId,
        }
      : {};

    // ── v2 chronological correction (event-time + explicit field mask) ────
    // v2 is selected EXPLICITLY by schemaVersion === 2 (never inferred from a
    // timestamp). Such a correction is materialized deterministically by
    // creation order, per field declared in its editedFields mask — never by
    // network/trigger/retry arrival, and never by diffing against the baseline.
    // Genuinely legacy edits (no schemaVersion) keep the historical incremental
    // path below, unchanged. A governed request never downgrades into it.
    const isV2Correction = (data as { schemaVersion?: unknown }).schemaVersion === 2;

    // Exact duplicate edit replay: PROVABLY already applied only when the
    // original carries an edit marker AND its values already equal this
    // edit's requested values — then re-applying would only re-run
    // enrichment for nothing. Provable → remove the duplicate incoming
    // copy atomically and stop. Unprovable (null) → proceed normally;
    // the schema keeps no per-edit operation log to check against.
    const editDup = editAlreadyApplied(data, origPacket);
    if (!isV2Correction && editDup === true) {
      console.log(`[IDEMPOTENT_REPLAY_ALREADY_PROCESSED] ${wellName}: edit ${context.params.packetId} already applied to ${originalPacketId} — duplicate incoming removed`);
      await removeIncomingPacket(db.ref(), context.params.packetId);
      return null;
    }

    // ── 7/25 revision ordering (optional metadata, backward compatible) ──
    // An edit carrying revisionAt older than the pull's lastRevisionAt is a
    // late straggler: acknowledge (consume) and drop — never revert newer
    // business state. Clients without revisionAt keep last-write-wins.
    if (!isV2Correction && isStaleRevision(data, origPacket)) {
      console.log(
        `[EDIT_STALE_REVISION] ${wellName}: edit ${context.params.packetId} ` +
          `(revisionAt ${data.revisionAt}) older than applied ${origPacket.lastRevisionAt} — acknowledged, not applied`,
      );
      await removeIncomingPacket(db.ref(), context.params.packetId);
      return null;
    }

    // ── 7/25 normalized no-op: identical milestone revisions ─────────────
    // WB-T sends the complete canonical state on every Depart / Close /
    // Split / History save. When no MATERIAL field differs (top, BBLs,
    // well identity, operational instant, asserted wellDown), the revision
    // acknowledges successfully by consuming the incoming packet — the
    // pull is not rewritten, tank-after / flow / AFR are not recomputed,
    // and the original operational timestamps are untouched. Transport and
    // audit fields can never create a false material change
    // (editMaterialChange inspects material fields only).
    const material = editMaterialChange(data, origPacket);
    if (!isV2Correction && !material.changed) {
      console.log(
        `[EDIT_NOOP_IDENTICAL] ${wellName}: edit ${context.params.packetId} matches ` +
          `processed ${originalPacketId} on all material fields — acknowledged without reapply`,
      );
      await removeIncomingPacket(db.ref(), context.params.packetId);
      return null;
    }
    console.log(
      `[EDIT_MATERIAL_CHANGE] ${wellName}: ${originalPacketId} fields changed: ${material.fields.join(', ')}`,
    );

    // ── Canonical edit event id + idempotency (retry / watchdog) ──────────
    const editEventId = resolveEditEventId({
      incomingPacketId: context.params.packetId,
      clientEventId: (data as { editEventId?: unknown }).editEventId,
    });

    // v2 event-time corrections are materialized chronologically (per field)
    // and converge transactionally regardless of arrival order. Fully handles
    // idempotency, history, and receipt, then consumes the incoming packet.
    if (isV2Correction) {
      await applyV2ChronologicalEdit({
        data,
        origPacket,
        originalPacketId,
        wellName,
        editEventId,
        incomingPacketId: context.params.packetId,
        editResolvedViaFallback,
        fallbackAuditFields,
      });
      return null;
    }

    const existingEventSnap = await db
      .ref(`packets/editHistory/${originalPacketId}/${editEventId}`)
      .once('value');
    if (existingEventSnap.exists()) {
      console.log(
        `[EDIT_EVENT_IDEMPOTENT] ${wellName}: event ${editEventId} already on ${originalPacketId} — consume incoming only`,
      );
      const existingEvent = (existingEventSnap.val() || {}) as Record<string, unknown>;
      const receipt = buildAppliedEditReceipt({
        editEventId,
        originalPacketId,
        payloadDigest: (data as { payloadDigest?: unknown }).payloadDigest,
        appliedAt: typeof existingEvent.editedAt === 'string'
          ? existingEvent.editedAt
          : new Date().toISOString(),
      });
      await db.ref().update({
        [`packets/incoming/${context.params.packetId}`]: null,
        ...editReceiptWritePaths(editEventId, receipt),
      });
      return null;
    }

    // Product: WB-M / Dashboard pull corrections are never age-gated.
    // originalSubmittedAt is audit-only (does not create a deadline).
    const nowMs = Date.now();
    const auditCtx = resolveEditAuditContext(origPacket as Record<string, unknown>);
    const editSource = normalizeEditSource((data as { source?: unknown }).source);
    const originalSubmissionAt =
      auditCtx.originalSubmissionAt ||
      resolveOriginalSubmissionAt(origPacket as Record<string, unknown>);
    // Origin of the pull (wbt/wbm) — separate from correction source.
    const originAppContext =
      normalizeOriginAppContext(origPacket.originAppContext) !== 'unknown'
        ? normalizeOriginAppContext(origPacket.originAppContext)
        : normalizeOriginAppContext((data as { originAppContext?: unknown }).originAppContext);
    const freezeOriginal = !origPacket.originalSubmittedAt;
    const sequence = nextEditCount(origPacket as Record<string, unknown>);
    const editedAtIso = new Date(nowMs).toISOString();

    // Get well config
    const cleanName = wellName.replace(/\s/g, '');
    let configSnap = await db.ref(`well_config/${wellName}`).once('value');
    if (!configSnap.exists()) {
      configSnap = await db.ref(`well_config/${cleanName}`).once('value');
    }
    const config = configSnap.val() || {};
    const tanks = config.tanks || config.numTanks || DEFAULTS.tanks;
    // Effective bbl/ft (override / derived); legacy 20×tanks fallback only.
    const bblPerFoot = Number(config.bblPerFoot) > 0 ? Number(config.bblPerFoot) : 20 * tanks;
    const pullBbls = config.pullBbls || DEFAULTS.pullBbls;
    const bottomInches = (config.bottomLevel || config.allowedBottom || DEFAULTS.bottomLevel) * 12;
    const loadLineInches = (config.loadLine ?? DEFAULTS.loadLine) * 12; // load-line floor (feet→inches)

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

    // Apply wellDown edit — use edited value if present, otherwise keep original.
    // newWellDown is the value stamped onto the historical packet record
    // (packets/processed/{originalPacketId}.wellDown) — what THIS edit asserts.
    const newWellDown = data.wellDown !== undefined ? (data.wellDown === true || data.wellDown === 'true') : (origPacket.wellDown || false);

    // ─── wellDown authoritative-write protection (5/8/2026) ─────────────
    // Edit packet ≠ Reactivate. Same rule as processIncomingPull: only
    // edits with wellDownIsAuthoritative=true are allowed to flip the
    // current wells/{wellName}/status/isDown. Non-authoritative edits
    // (e.g., WB T edit packets that hardcode wellDown=false) preserve the
    // existing isDown value while still updating the historical packet
    // record. nextEditIsDown is what gets written to the live status path
    // and broadcast onto outgoing response packets / WellStatus.
    const editIsAuthoritative =
      (data as any).wellDownIsAuthoritative === true &&
      data.wellDown !== undefined;
    const editExistingIsDownSnap = await db.ref(`wells/${wellName}/status/isDown`).once('value');
    const editExistingIsDown = editExistingIsDownSnap.val() === true;
    const nextEditIsDown = editIsAuthoritative ? newWellDown : editExistingIsDown;

    // Field-level paper trail from server-side previous values (never trust client "before").
    const fieldDiff = buildFieldDiff(origPacket as Record<string, unknown>, {
      tankTopInches: newTankTopInches,
      tankLevelFeet: newTankTopInches / 12,
      bblsTaken: newBblsTaken,
      dateTimeUTC: data.dateTimeUTC ? newDateTimeUTC : undefined,
      dateTime: data.dateTime ? newDateTime : undefined,
      wellDown: data.wellDown !== undefined ? newWellDown : undefined,
    });
    const editEvent = buildAppliedEditEvent({
      eventId: editEventId,
      packetId: originalPacketId,
      sequence,
      editedAt: editedAtIso,
      source: editSource,
      originAppContext,
      actorDriverId: (data as any).driverId ?? origPacket.driverId ?? null,
      actorDriverName: (data as any).driverName ?? null,
      clientAppVersion: (data as any).clientAppVersion ?? null,
      fields: fieldDiff,
      originalSubmissionAt,
      resolutionPath: editResolvedViaFallback ? 'invoiceDocId_fallback' : 'direct',
      editRequestId: context.params.packetId,
    });
    const trailSummary = editSummaryFields({
      editedAt: editedAtIso,
      source: editSource,
      editCount: sequence,
      originalSubmissionAt,
      freezeOriginal,
    });
    const historyPaths = editHistoryWritePaths(originalPacketId, editEvent);
    const receipt = buildAppliedEditReceipt({
      editEventId,
      originalPacketId,
      payloadDigest: (data as { payloadDigest?: unknown }).payloadDigest,
      appliedAt: editedAtIso,
    });
    const receiptPaths = editReceiptWritePaths(editEventId, receipt);

    // No top level = non-production-tank edit. Update basic fields only, skip tank
    // math — but still through the ONE canonical coordinator (it writes isDown, a
    // canonical-status location) so nothing bypasses the serialized writer.
    if (newTankTopInches <= 0) {
      console.log(`[NO-LEVEL EDIT] ${wellName}: No top level, skipping tank math`);
      const noLevelCommit = await runCanonicalMutation(makeCoordinatorIO(db, wellName), {
        wellName, operationId: editEventId,
        buildPatch: async () => {
          const curRev = Number((await db.ref(`wells/${wellName}/status/chronoRevision`).once('value')).val()) || 0;
          const revision = curRev + 1;
          const noLevelReceipt: CommitReceipt = {
            operationId: editEventId, mutationType: 'edit', wellName, fence: revision, revision,
            affectedPacketIds: [originalPacketId], committedAtMs: Date.now(), patchHash: `${editEventId}:${revision}:nolevel`,
          };
          const patch = assembleCanonicalPatch({
            processedUpdates: Object.fromEntries(
              Object.entries({
                tankTopInches: 0, tankLevelFeet: 0, bblsTaken: newBblsTaken, tankAfterInches: 0, tankAfterFeet: '',
                dateTimeUTC: newDateTimeUTC, dateTime: newDateTime, noLevel: true, wellDown: newWellDown,
                ...fallbackAuditFields, ...trailSummary,
                ...(typeof data.revisionAt === 'string' && data.revisionAt ? { lastRevisionAt: data.revisionAt } : {}),
              }).map(([k, v]) => [`packets/processed/${originalPacketId}/${k}`, v]),
            ),
            fence: { wellName, revision },
            receipt: noLevelReceipt, receiptPath: receiptPathFor(wellName, editEventId),
          });
          Object.assign(patch, historyPaths, receiptPaths);
          patch[`packets/incoming/${context.params.packetId}`] = null;
          patch[`wells/${wellName}/status/isDown`] = nextEditIsDown;
          return { patch, receipt: noLevelReceipt };
        },
      });
      if (noLevelCommit.status !== 'committed' && noLevelCommit.status !== 'already_done') {
        console.error(`[CANONICAL-EDIT] ${wellName}: ${originalPacketId} → ${noLevelCommit.status} (no-level; incoming left for retry)`);
      }
      return null;
    }

    // Recalculate tankAfter
    const bblsInInches = newBblsTaken > 0 ? (newBblsTaken / bblPerFoot) * 12 : 0;
    // ── Load-line clamp (Commit A) — mirror of processIncomingPull. The edit
    // path is how GS5 acquired its -1'2" (edited pull), so it must clamp too. ──
    const rawNewTankAfterInches = newTankTopInches - bblsInInches;
    const newTankAfterInches = Math.max(rawNewTankAfterInches, loadLineInches);
    const editHitLoadLine = rawNewTankAfterInches < loadLineInches;

    // Get the previous pull's data for timeDif/recovery/flowRate recalc
    const prevOutgoingSnap = await db.ref('packets/processed')
      .orderByChild('wellName')
      .equalTo(wellName)
      .once('value');

    // Find the pull immediately before the edited one (by timestamp), and evaluate
    // the edited logical pull's Late-Entry provenance AT MUTATION TIME: it is late
    // iff a strictly-newer pull already exists among the OTHER rows for this well.
    // This is stored on the edited row only — unrelated rows are never relabeled.
    const editedTime = new Date(newDateTimeUTC).getTime();
    let prevTankAfterInches = 0;
    let prevTimestamp = '';
    const editPeers: Array<{ dateTimeUTC: string; packetId: string }> = [];

    prevOutgoingSnap.forEach((child) => {
      if (child.key === originalPacketId) return; // Skip self
      const pkt = child.val();
      const pktTime = new Date(pkt.dateTimeUTC).getTime();
      editPeers.push({ dateTimeUTC: String(pkt.dateTimeUTC), packetId: String(child.key) });
      if (pktTime < editedTime) {
        // This is a candidate for "previous pull"
        if (!prevTimestamp || pktTime > new Date(prevTimestamp).getTime()) {
          prevTankAfterInches = pkt.tankAfterInches || 0;
          prevTimestamp = pkt.dateTimeUTC;
        }
      }
    });
    // Late-Entry provenance for the edited pull, by the COMPLETE canonical order.
    const editLateEntry = isLateEntryByCanonicalOrder(newDateTimeUTC, String(originalPacketId), editPeers);

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

    // Update the processed packet with new values + canonical trail summary
    const updates: { [key: string]: any } = {
      tankTopInches: newTankTopInches,
      tankLevelFeet: newTankTopInches / 12,
      bblsTaken: newBblsTaken,
      tankAfterInches: newTankAfterInches,
      tankAfterFeet: inchesToFeetInches(newTankAfterInches),
      rawCalculatedBottomInches: rawNewTankAfterInches,
      hitLoadLine: editHitLoadLine,
      recoveryInches,
      flowRateDays,
      flowRate,
      timeDif,
      timeDifDays,
      dateTimeUTC: newDateTimeUTC,
      dateTime: newDateTime,
      wellDown: newWellDown,
      lateEntry: editLateEntry, // stable provenance for the edited pull (evaluated above)
      ...fallbackAuditFields,
      ...trailSummary,
      ...(typeof data.revisionAt === 'string' && data.revisionAt ? { lastRevisionAt: data.revisionAt } : {}),
    };

    // The edit's processed summary + immutable history + receipt + isDown +
    // successor cascade + outgoing/current + wells-status + performance + AFR are
    // ALL committed as ONE atomic patch through the serialized coordinator at the
    // end of this block (never as separate writes). We only COMPUTE here.

    // CASCADE: the NEXT packet's recovery was based on our old tankAfterInches.
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
    const cascadeUpdates: Record<string, unknown> = {};
    if (nextPacketKey && nextPacket && nextPacket.tankTopInches > 0) {
      const nextRecovery = Math.max(0, nextPacket.tankTopInches - newTankAfterInches);
      const nextTimeDifDays = (closestNextTime - editedTime) / (1000 * 60 * 60 * 24);
      let nextFlowRateDays = 0;
      let nextFlowRate = '';
      if (nextRecovery > 0 && nextTimeDifDays > 0) {
        nextFlowRateDays = (nextTimeDifDays / nextRecovery) * 12;
        nextFlowRate = daysToHMMSS(nextFlowRateDays);
      }
      cascadeUpdates[`packets/processed/${nextPacketKey}/recoveryInches`] = nextRecovery;
      cascadeUpdates[`packets/processed/${nextPacketKey}/flowRateDays`] = nextFlowRateDays;
      cascadeUpdates[`packets/processed/${nextPacketKey}/flowRate`] = nextFlowRate;
    }

    // Recalculate AFR and update outgoing response if this was the most recent pull
    const afr = await calculateAFR(wellName, flowRateDays);

    // Recalculate window/overnight bbls/day (edit may have changed flow rates)
    const editBblPerFoot = bblPerFoot;
    const editHistoricalPulls = await getHistoricalPulls(wellName, 500);
    const editPullTimeMs = new Date(origPacket.dateTimeUTC).getTime();
    const editWindowBblsDay = calculateWindowBblsPerDay(editHistoricalPulls, editBblPerFoot, editPullTimeMs);
    const editOvernightBblsDay = calculateOvernightBblsPerDay(editHistoricalPulls, editBblPerFoot, editPullTimeMs);

    // Check if this is the most recent pull for the well, and collect the prior
    // response ids (the canonical commit deletes them + writes the new one).
    const outgoingSnap = await db.ref('packets/outgoing')
      .orderByChild('wellName')
      .equalTo(wellName)
      .once('value');

    let isLatestPull = false;
    let hasOutgoing = false;
    const editOldResponseIds: string[] = [];
    outgoingSnap.forEach((child) => {
      hasOutgoing = true;
      if (child.key) editOldResponseIds.push(child.key);
      const resp = child.val();
      // If the outgoing response points to this packet's timestamp, it's the latest
      // (check both original and new dateTimeUTC in case date was edited).
      if (resp.lastPullDateTimeUTC === origPacket.dateTimeUTC || resp.lastPullDateTimeUTC === newDateTimeUTC) {
        isLatestPull = true;
      }
    });
    // If no outgoing response exists for this well at all, treat as latest.
    if (!hasOutgoing) {
      isLatestPull = true;
    }

    // Build the outgoing / AFR / wells-status sidecar — only when this edit is the
    // latest pull (otherwise current/outgoing are unchanged). Computed here, all
    // committed in ONE atomic patch below.
    const editSidecar: CanonicalSidecar = {};
    if (isLatestPull && afr > 0) {
      const pullHeightInches = (pullBbls / bblPerFoot) * 12;
      const recoveryNeeded = Math.max(0, (bottomInches + pullHeightInches) - newTankAfterInches);
      let estTimeToPull = '';
      let estDateTimePull = '';
      if (recoveryNeeded > 0) {
        const estDays = (recoveryNeeded / 12) * afr;
        estTimeToPull = daysToHMM(estDays);
        estDateTimePull = new Date(new Date(newDateTimeUTC).getTime() + estDays * 86400000).toISOString();
      } else {
        estTimeToPull = '0:00';
        estDateTimePull = newDateTimeUTC;
      }
      const bbls24hrs = Math.round((1 / afr) * bblPerFoot).toString();
      const responseTimestamp = new Date();
      const responseId = `response_${responseTimestamp.toISOString().replace(/[-:]/g, '').replace('T', '_').split('.')[0]}_${cleanName}`;
      const response: Record<string, unknown> = {
        wellName,
        currentLevel: inchesToFeetInches(newTankAfterInches),
        flowRate: daysToHMMSS(afr),
        bbls24hrs,
        lastPullTopLevel: inchesToFeetInches(newTankTopInches),
        lastPullBottomLevel: inchesToFeetInches(newTankAfterInches),
        lastPullBbls: newBblsTaken.toString(),
        lastPullDateTime: newDateTime || formatLocalDateTime(new Date(newDateTimeUTC)),
        lastPullDateTimeUTC: newDateTimeUTC,
        timeTillPull: nextEditIsDown ? 'Down' : (estTimeToPull || 'Calculating...'),
        nextPullTime: estDateTimePull ? formatLocalDateTime(new Date(estDateTimePull)) : 'Unknown',
        nextPullTimeUTC: estDateTimePull,
        wellDown: nextEditIsDown,
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
        companyId: outgoingCompanyId(config),
      };
      editSidecar.outgoing = { deleteResponseIds: editOldResponseIds, responseId, response };
      const afrMinutes = afr * 24 * 60;
      editSidecar.afr = { wellName, avgFlowRate: daysToHMMSS(afr), avgFlowRateMinutes: Math.round(afrMinutes * 100) / 100 };
      editSidecar.wellStatus = { wellName, status: {
        wellName,
        config: { tanks, bottomLevel: bottomInches / 12, route: config.route || 'Unassigned', pullBbls },
        current: { level: inchesToFeetInches(newTankAfterInches), levelInches: newTankAfterInches, asOf: new Date().toISOString() },
        lastPull: {
          dateTime: newDateTime || formatLocalDateTime(new Date(newDateTimeUTC)), dateTimeUTC: newDateTimeUTC,
          topLevel: inchesToFeetInches(newTankTopInches), topLevelInches: newTankTopInches,
          bottomLevel: inchesToFeetInches(newTankAfterInches), bottomLevelInches: newTankAfterInches,
          rawCalculatedBottom: inchesToFeetInches(rawNewTankAfterInches), rawCalculatedBottomInches: rawNewTankAfterInches,
          hitLoadLine: editHitLoadLine, bblsTaken: newBblsTaken, driverName: origPacket.driverName || '', packetId: originalPacketId,
        },
        calculated: {
          flowRate: daysToHMMSS(afr), flowRateMinutes: Math.round(afrMinutes * 100) / 100,
          bbls24hrs: Math.round((1 / afr) * bblPerFoot) || 0,
          nextPullTime: recoveryNeeded <= 0 ? formatLocalDateTime(new Date(newDateTimeUTC)) : formatLocalDateTime(new Date(new Date(newDateTimeUTC).getTime() + (recoveryNeeded / 12) * afr * 86400000)),
          nextPullTimeUTC: estDateTimePull,
          timeTillPull: nextEditIsDown ? 'Down' : (recoveryNeeded <= 0 ? '0:00' : daysToHMM((recoveryNeeded / 12) * afr)),
        },
        isDown: nextEditIsDown, updatedAt: new Date().toISOString(),
      } };
    }

    // Performance row (WB M reads here) — computed; committed atomically below.
    const perfPullTime = new Date(newDateTimeUTC);
    const editPerfTimestamp = `${perfPullTime.getFullYear()}${String(perfPullTime.getMonth() + 1).padStart(2, '0')}${String(perfPullTime.getDate()).padStart(2, '0')}_${String(perfPullTime.getHours()).padStart(2, '0')}${String(perfPullTime.getMinutes()).padStart(2, '0')}${String(perfPullTime.getSeconds()).padStart(2, '0')}`;
    const editPerfDateStr = `${perfPullTime.getFullYear()}-${String(perfPullTime.getMonth() + 1).padStart(2, '0')}-${String(perfPullTime.getDate()).padStart(2, '0')}`;
    const editPerfWellKey = wellName.replace(/\s+/g, '_');
    const editActualInches = Math.floor(newTankTopInches);
    const editPredictedInches = origPacket.predictedLevelInches ? Math.floor(Number(origPacket.predictedLevelInches)) : editActualInches;
    // On a date edit, remove the OLD performance row (different timestamp key).
    let editOldPerfRemovalPath: string | null = null;
    if (data.dateTimeUTC && data.dateTimeUTC !== origPacket.dateTimeUTC) {
      const oldPullTime = new Date(origPacket.dateTimeUTC);
      const oldPerfTimestamp = `${oldPullTime.getFullYear()}${String(oldPullTime.getMonth() + 1).padStart(2, '0')}${String(oldPullTime.getDate()).padStart(2, '0')}_${String(oldPullTime.getHours()).padStart(2, '0')}${String(oldPullTime.getMinutes()).padStart(2, '0')}${String(oldPullTime.getSeconds()).padStart(2, '0')}`;
      editOldPerfRemovalPath = `performance/${editPerfWellKey}/rows/${oldPerfTimestamp}`;
    }
    const editPerfPiece = { wellKey: editPerfWellKey, perfTimestamp: editPerfTimestamp, row: { d: editPerfDateStr, a: editActualInches, p: editPredictedInches } as Record<string, unknown>, wellName, updatedIso: new Date().toISOString() };

    // ── ONE canonical commit for the edit ───────────────────────────────────
    // processed material + derived (edited row) + single-hop successor cascade +
    // outgoing/current + wells-status + performance + AFR + chronoRevision +
    // immutable edit-history + edit-receipt + isDown + incoming-consume, as a
    // single atomic multipath update, serialized by the per-well lock, with the
    // completion receipt in the SAME update.
    const editCommit = await runCanonicalMutation(makeCoordinatorIO(db, wellName), {
      wellName, operationId: editEventId,
      buildPatch: async () => {
        const curRev = Number((await db.ref(`wells/${wellName}/status/chronoRevision`).once('value')).val()) || 0;
        const revision = curRev + 1;
        const editReceipt: CommitReceipt = {
          operationId: editEventId, mutationType: 'edit', wellName, fence: revision, revision,
          affectedPacketIds: [originalPacketId, ...(nextPacketKey ? [nextPacketKey as string] : [])],
          committedAtMs: Date.now(), patchHash: `${editEventId}:${revision}`,
        };
        const patch = assembleCanonicalPatch({
          processedUpdates: {
            ...Object.fromEntries(Object.entries(updates).map(([k, v]) => [`packets/processed/${originalPacketId}/${k}`, v])),
            ...cascadeUpdates,
          },
          outgoing: editSidecar.outgoing ?? null,
          wellStatus: editSidecar.wellStatus ?? null,
          performance: editPerfPiece,
          production: [],
          afr: editSidecar.afr ?? null,
          fence: { wellName, revision },
          receipt: editReceipt, receiptPath: receiptPathFor(wellName, editEventId),
        });
        // Edit-specific atomic locations layered into the SAME patch.
        Object.assign(patch, historyPaths, receiptPaths);
        patch[`packets/incoming/${context.params.packetId}`] = null;
        patch[`wells/${wellName}/status/isDown`] = nextEditIsDown; // always, even when not latest
        if (editOldPerfRemovalPath) patch[editOldPerfRemovalPath] = null;
        return { patch, receipt: editReceipt };
      },
    });
    if (editCommit.status !== 'committed' && editCommit.status !== 'already_done') {
      console.error(`[CANONICAL-EDIT] ${wellName}: ${originalPacketId} → ${editCommit.status} (incoming left for retry)`);
      return null;
    }
    console.log(`[CANONICAL-EDIT] ${wellName}: ${originalPacketId} → ${editCommit.status} (processed+cascade+outgoing+status+perf+afr+history+receipt, 1 atomic update)`);

    // ── Cascade to Firestore: DETERMINISTIC identity resolution ──
    // P0 (2026-06-23): the prior back-patch matched a ticket by packetId and, on
    // miss, by wellName+date+bbls. With two same-well/same-day tickets that bbls
    // heuristic collided and (a) updated the WRONG ticket and (b) backfilled
    // packetId onto it, poisoning all future edits (#19017 vs #19203 for
    // 20260622_192528_Gab1_ivnuo2). The REAL anchor is invoice.packetId (+ the
    // invoiceDocId carried on the processed packet). Resolve the target
    // deterministically; NEVER write Firestore unless identity is proven; NEVER
    // stamp packetId from a heuristic; NO docs[0] / bbls-only / totalBBL==newBbls
    // / cancelled-by-amount matching.
    const editDiag = async (event: string, result: string, reason: string, extra: Record<string, any> = {}) => {
      console.log(`[${event}] ${result} — ${reason} ${JSON.stringify(extra)}`);
      try {
        await admin.firestore().collection('wb_diagnostics').add({
          app: 'cf', area: 'edit', event, result, reason,
          source: data.source || 'cf',
          extra: { originalPacketId, wellName, newBblsTaken, ...extra },
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch {}
    };

    try {
      const firestore = admin.firestore();
      const newTopFI = inchesToFeetInches(newTankTopInches);
      const newBottomFI = inchesToFeetInches(newTankAfterInches);
      const isCancelled = (inv: any) => inv?.status === 'cancelled' || inv?.status === 'canceled';

      await editDiag('edit.firestoreResolve.start', 'ok', 'resolving exact Firestore identity', {
        invoiceDocIdOnPacket: origPacket.invoiceDocId || null,
      });

      let invoiceRef: any = null;
      let invoiceData: any = null;
      let ticketRef: any = null;
      let resolvedVia: string | null = null;

      // Resolve the ticket doc WITHIN a known invoice via its ticketSummaries.
      const resolveTicketFromInvoice = async (invRef: any, invData: any): Promise<any> => {
        const summaries: any[] = Array.isArray(invData.ticketSummaries) ? invData.ticketSummaries : [];
        let chosen: any = summaries.find(s => s && s.packetId && s.packetId === originalPacketId);
        if (!chosen && summaries.length === 1) chosen = summaries[0];
        if (!chosen && summaries.length === 0) {
          const tickets: string[] = Array.isArray(invData.tickets) ? invData.tickets : [];
          if (tickets.length === 1) chosen = { ticketNumber: tickets[0] };
        }
        if (!chosen) return null;
        if (chosen.docId) return firestore.collection('tickets').doc(chosen.docId);
        if (chosen.ticketNumber) {
          const tq = await firestore.collection('tickets')
            .where('ticketNumber', '==', String(chosen.ticketNumber))
            .where('invoiceDocId', '==', invRef.id)
            .limit(2).get();
          if (tq.size === 1) return tq.docs[0].ref;
        }
        return null;
      };

      // A. By the invoiceDocId carried on the processed packet (strongest).
      if (origPacket.invoiceDocId) {
        const snap = await firestore.collection('invoices').doc(String(origPacket.invoiceDocId)).get();
        if (snap.exists) {
          const inv = snap.data() as any;
          if (isCancelled(inv)) {
            await editDiag('edit.firestoreResolve.byInvoiceDocId.success', 'skipped', 'invoice is cancelled', { invoiceDocId: snap.id });
          } else if (inv.packetId && inv.packetId !== originalPacketId) {
            await editDiag('edit.firestoreResolve.byInvoiceDocId.success', 'skipped', 'invoice.packetId mismatch', { invoiceDocId: snap.id, invoicePacketId: inv.packetId });
          } else {
            invoiceRef = snap.ref; invoiceData = inv; resolvedVia = 'invoiceDocId';
            ticketRef = await resolveTicketFromInvoice(snap.ref, inv);
            await editDiag('edit.firestoreResolve.byInvoiceDocId.success', 'ok', 'resolved invoice via packet.invoiceDocId', { invoiceDocId: snap.id, ticketResolved: !!ticketRef });
          }
        }
      }

      // B. By invoices where packetId == originalPacketId (non-cancelled, exactly one).
      if (!invoiceRef) {
        const invq = await firestore.collection('invoices').where('packetId', '==', originalPacketId).limit(5).get();
        const live = invq.docs.filter(d => !isCancelled(d.data()));
        if (live.length === 1) {
          invoiceRef = live[0].ref; invoiceData = live[0].data(); resolvedVia = 'invoicePacketId';
          ticketRef = await resolveTicketFromInvoice(invoiceRef, invoiceData);
          await editDiag('edit.firestoreResolve.byInvoicePacketId.success', 'ok', 'resolved invoice by packetId', { invoiceDocId: invoiceRef.id, ticketResolved: !!ticketRef });
        } else if (live.length > 1) {
          await editDiag('edit.firestoreCascade.noExactIdentity.noWrite', 'skipped', 'multiple non-cancelled invoices match packetId', { count: live.length });
        } else if (invq.size > 0) {
          await editDiag('edit.firestoreCascade.noExactIdentity.noWrite', 'skipped', 'only cancelled invoices match packetId', { count: invq.size });
        }
      }

      // C. By tickets where packetId == originalPacketId — LOW priority (may be
      //    poisoned). Verify the matched ticket's invoice actually anchors this packet.
      if (!invoiceRef && !ticketRef) {
        const tq = await firestore.collection('tickets').where('packetId', '==', originalPacketId).limit(5).get();
        if (tq.size === 1) {
          const cand = tq.docs[0];
          const candInvId = cand.data().invoiceDocId;
          let verified = false;
          if (candInvId) {
            const invSnap = await firestore.collection('invoices').doc(String(candInvId)).get();
            if (invSnap.exists) {
              const inv = invSnap.data() as any;
              const claimsPacket = inv.packetId === originalPacketId;
              const listsTicket = !inv.packetId && Array.isArray(inv.tickets) && inv.tickets.includes(String(cand.data().ticketNumber));
              if (!isCancelled(inv) && (claimsPacket || listsTicket)) {
                invoiceRef = invSnap.ref; invoiceData = inv; ticketRef = cand.ref; verified = true; resolvedVia = 'ticketPacketId';
              }
            }
          }
          if (verified) {
            await editDiag('edit.firestoreResolve.byTicketPacketId.success', 'ok', 'resolved + verified via ticket.packetId', { ticketId: cand.id, invoiceDocId: invoiceRef.id });
          } else {
            await editDiag('edit.firestoreCascade.suspiciousPoisonedTicket.noWrite', 'skipped', 'ticket.packetId match not verified against its invoice (possible poison)', { ticketId: cand.id, ticketInvoiceDocId: candInvId || null });
          }
        } else if (tq.size > 1) {
          await editDiag('edit.firestoreCascade.suspiciousPoisonedTicket.noWrite', 'skipped', 'multiple tickets carry this packetId (poisoned)', { count: tq.size });
        }
      }

      // D. Heuristic wellName+date — DIAGNOSTIC ONLY. Never write, never stamp packetId.
      if (!invoiceRef && !ticketRef) {
        let datePart = (origPacket.dateTime || '').split(' ')[0] || (origPacket.dateTime || '').split('T')[0] || '';
        if (datePart.includes('-')) { const [y, m, d] = datePart.split('-'); datePart = `${m}/${d}/${y}`; }
        else if (datePart.includes('/')) { const p = datePart.split('/'); datePart = `${p[0].padStart(2, '0')}/${p[1].padStart(2, '0')}/${p[2]}`; }
        let candidateCount = 0;
        if (datePart && wellName) {
          const cands = await firestore.collection('tickets').where('wellName', '==', wellName).where('date', '==', datePart).limit(10).get();
          candidateCount = cands.size;
        }
        await editDiag('edit.firestoreResolve.heuristicAmbiguous.noWrite', 'skipped', 'no deterministic identity; heuristic candidates left for MANUAL resolution (no Firestore write)', { datePart, candidateCount });
      }

      // ── Write ONLY when identity is exact ──
      if (invoiceRef && invoiceData) {
        // Ticket doc (if resolved). packetId backfill is safe — match was deterministic.
        if (ticketRef) {
          await ticketRef.update({
            bbls: String(newBblsTaken),
            top: newTopFI,
            bottom: newBottomFI,
            editedAt: admin.firestore.Timestamp.now(),
            editedBy: data.source || 'dashboard',
            updatedBy: data.source || 'dashboard',
            updatedAt: admin.firestore.Timestamp.now(),
            packetId: originalPacketId,
          });
        }

        // Invoice doc: update the matching summary + recompute totalBBL from summaries
        // + reconcile packetSnapshot. Preserve all other summary/invoice fields.
        const summaries: any[] = Array.isArray(invoiceData.ticketSummaries)
          ? invoiceData.ticketSummaries.map((s: any) => ({ ...s })) : [];
        let matchedSummary: any = summaries.find(s =>
          (s.packetId && s.packetId === originalPacketId) || (ticketRef && s.docId && s.docId === ticketRef.id));
        if (!matchedSummary && summaries.length === 1) matchedSummary = summaries[0];
        if (matchedSummary) {
          matchedSummary.qty = String(newBblsTaken);
          matchedSummary.bbls = String(newBblsTaken);
          matchedSummary.top = newTopFI;
          matchedSummary.bottom = newBottomFI;
        }
        let invTotal = 0;
        if (summaries.length > 0) {
          for (const s of summaries) invTotal += parseFloat(String(s.qty ?? s.bbls ?? '0')) || 0;
        } else {
          invTotal = newBblsTaken;
        }
        const existingSnap = invoiceData.packetSnapshot && typeof invoiceData.packetSnapshot === 'object' ? invoiceData.packetSnapshot : {};
        const invUpdate: Record<string, any> = {
          totalBBL: invTotal,
          packetSnapshot: { ...existingSnap, bblsTaken: newBblsTaken, tankAfterFeet: newBottomFI },
          editedAt: admin.firestore.Timestamp.now(),
          editedBy: data.source || 'dashboard',
        };
        if (summaries.length > 0) invUpdate.ticketSummaries = summaries;
        await invoiceRef.update(invUpdate);

        // Dispatch cascade (recompute from tickets) using the packet's own dispatchId.
        const dispatchId = origPacket.dispatchId;
        if (dispatchId && ticketRef) {
          const allTicketsSnap = await firestore.collection('tickets').where('dispatchId', '==', dispatchId).get();
          let dTotal = 0;
          allTicketsSnap.forEach(t => { dTotal += (t.id === ticketRef.id ? newBblsTaken : (parseFloat(t.data().bbls) || 0)); });
          await firestore.collection('dispatches').doc(dispatchId).update({ totalBBL: dTotal }).catch(() => {});
        }

        // canonical_jobs reconcile + edited event.
        try {
          await firestore.collection('canonical_jobs').doc(originalPacketId).update({
            bblsTaken: newBblsTaken,
            tankLevelFeet: newTankTopInches / 12,
            tankAfterFeet: newTankAfterInches / 12,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            events: admin.firestore.FieldValue.arrayUnion({
              type: 'edited', actorSource: data.source || 'cf', timestamp: Date.now(),
              extra: { bbls: newBblsTaken, via: resolvedVia },
            }),
          });
        } catch (cjErr) {
          console.log('Edit: canonical_jobs reconcile skipped:', (cjErr as any)?.message);
        }

        await editDiag('edit.firestoreCascade.success', 'ok', 'updated exact ticket/invoice/canonical', {
          invoiceDocId: invoiceRef.id, ticketId: ticketRef?.id || null, resolvedVia, totalBBL: invTotal,
        });
      } else {
        await editDiag('edit.firestoreCascade.noExactIdentity.noWrite', 'skipped', 'no exact Firestore identity — RTDB updated, Firestore left untouched (manual resolution)', {});
      }
    } catch (fsErr) {
      // Non-blocking — RTDB is already updated, Firestore cascade is best-effort
      console.error(`Edit: Firestore cascade error (non-blocking):`, fsErr);
    }

    // (the edit request was consumed as part of the ONE canonical atomic update
    // above — never a separate remove here.)

    await notifyIncomingVersionBestEffort(db.ref('packets/incoming_version'), {
      outgoingCommitted: true,
      pullAccepted: true,
    });

    console.log(`Edit complete for ${wellName}: ${originalPacketId}`);
    return null;
}

// Handle delete requests — removes from processed and recalculates outgoing from remaining data

export const processDeleteRequest = functionsV1.runWith({ timeoutSeconds: CANONICAL_COMMIT_TIMEOUT_SECONDS, memory: '512MB' }).database
  .ref('packets/incoming/{packetId}')
  .onCreate(async (snapshot, context) => {
    const data = snapshot.val();

    if (data.requestType !== 'delete') {
      return null;
    }

    const targetPacketId = data.packetId;
    const wellName = data.wellName;

    console.log(`Processing delete for ${wellName}: ${targetPacketId}`);

    // Malformed/unresolvable delete (no well or no target id) → governed quarantine,
    // NOT a silent no-op. A well-formed delete whose target happens to be absent is
    // handled below as an authorized terminal no-op (with a receipt), which is a
    // DIFFERENT, deterministic outcome from a malformed request.
    if (typeof wellName !== 'string' || !wellName || typeof targetPacketId !== 'string' || !targetPacketId) {
      console.log(`[QUARANTINE] delete request malformed — wellName=${JSON.stringify(wellName)} targetPacketId=${JSON.stringify(targetPacketId)}`);
      await quarantineIncomingPacket(db.ref(), {
        packetId: context.params.packetId,
        packet: data,
        verdict: malformedDeleteVerdict(wellName, targetPacketId),
        nowMs: Date.now(),
      });
      return null;
    }

    // Read the packet before deleting (to check if it was the latest)
    const targetSnap = await db.ref(`packets/processed/${targetPacketId}`).once('value');
    const deletedPacket = targetSnap.exists() ? targetSnap.val() : null;

    // Audit archive of the delete request — computed up front so it commits inside
    // the SAME atomic patch as the canonical state + receipt + request removal.
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
    const deleteIncomingId = context.params.packetId;

    // Route the delete through the ONE canonical coordinator: null the row,
    // recompute every affected successor via the engine (each successor's
    // predecessor moves; historical bottoms preserved), rebuild outgoing/current
    // from the new latest, and land it all — plus the completion receipt — in ONE
    // atomic patch. This replaces the hand-rolled next-packet cascade (which used
    // the universal 20 bbl/ft); recovery now uses the well's RESOLVED total.
    if (deletedPacket) {
      const cleanName = wellName.replace(/\s/g, '');
      let configSnap = await db.ref(`well_config/${wellName}`).once('value');
      if (!configSnap.exists()) configSnap = await db.ref(`well_config/${cleanName}`).once('value');
      const config = configSnap.val() || {};
      const tanks = config.tanks || config.numTanks || DEFAULTS.tanks;
      const pullBbls = config.pullBbls || DEFAULTS.pullBbls;
      const bottomInches = (config.bottomLevel || config.allowedBottom || DEFAULTS.bottomLevel) * 12;
      const bblPerFoot = Number(config.bblPerFoot) > 0 ? Number(config.bblPerFoot) : 20 * tanks;
      const cfg: WellChronoConfig = {
        bblPerFoot, tanks,
        allowedBottomInches: (Number(config.allowedBottom ?? config.bottomLevel) || 0) * 12 || undefined,
        avgFlowRateDays: Number(config.avgFlowRateMinutes) > 0 ? Number(config.avgFlowRateMinutes) / 1440 : undefined,
      };

      const chain = await loadChronoPulls(wellName);

      // New latest (current) among the remaining FULL processed records (need
      // driver/display fields the chain doesn't carry). Skip the row being deleted.
      const remainingSnap = await db.ref('packets/processed')
        .orderByChild('wellName').equalTo(wellName).once('value');
      let latestPacket: Record<string, any> | null = null;
      let latestTime = 0;
      remainingSnap.forEach((child) => {
        if (child.key === targetPacketId) return;
        const pkt = child.val();
        const pktTime = new Date(pkt.dateTimeUTC).getTime();
        if (pktTime > latestTime) { latestTime = pktTime; latestPacket = pkt; }
      });

      // Prior outgoing response ids (the commit deletes them atomically).
      const oldResponses = await db.ref('packets/outgoing')
        .orderByChild('wellName').equalTo(wellName).once('value');
      const oldResponseIds: string[] = [];
      oldResponses.forEach((child) => { if (child.key) oldResponseIds.push(child.key); });

      // Deleted row's performance timestamp (removed in the same patch).
      const wellKey = wellName.replace(/\s+/g, '_');
      let deletedPerfTs: string | null = null;
      if (deletedPacket.dateTimeUTC) {
        const dt = new Date(deletedPacket.dateTimeUTC);
        deletedPerfTs = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}_${String(dt.getHours()).padStart(2, '0')}${String(dt.getMinutes()).padStart(2, '0')}${String(dt.getSeconds()).padStart(2, '0')}`;
      }

      // Build the outgoing/AFR sidecar from the new latest, or clear when none remain.
      const sidecar: CanonicalSidecar = {};
      if (latestPacket) {
        const lp = latestPacket as Record<string, any>;
        const afr = await calculateAFR(wellName, lp.flowRateDays || 0);
        const latestTimeMs = new Date(lp.dateTimeUTC).getTime();
        const historicalPulls = await getHistoricalPulls(wellName, 500);
        const windowBblsDay = calculateWindowBblsPerDay(historicalPulls, bblPerFoot, latestTimeMs);
        const overnightBblsDay = calculateOvernightBblsPerDay(historicalPulls, bblPerFoot, latestTimeMs);
        const tankAfterInches = lp.tankAfterInches || 0;
        const pullHeightInches = (pullBbls / 20 / tanks) * 12;
        const recoveryNeeded = Math.max(0, (bottomInches + pullHeightInches) - tankAfterInches);
        let estTimeToPull = ''; let estDateTimePull = '';
        if (afr > 0 && recoveryNeeded > 0) {
          const estDays = (recoveryNeeded / 12) * afr;
          estTimeToPull = daysToHMM(estDays);
          estDateTimePull = new Date(latestTimeMs + estDays * 86400000).toISOString();
        } else if (recoveryNeeded === 0) { estTimeToPull = '0:00'; estDateTimePull = lp.dateTimeUTC; }
        const bbls24hrs = (afr > 0 ? Math.round((1 / afr) * 20 * tanks) : 0).toString();
        const timestamp = new Date();
        const responseId = `response_${timestamp.toISOString().replace(/[-:]/g, '').replace('T', '_').split('.')[0]}_${cleanName}`;
        const response: Record<string, unknown> = {
          wellName,
          currentLevel: inchesToFeetInches(tankAfterInches),
          flowRate: afr > 0 ? daysToHMMSS(afr) : 'Unknown',
          bbls24hrs,
          timeTillPull: lp.wellDown ? 'Down' : (estTimeToPull || 'Calculating...'),
          nextPullTime: estDateTimePull ? formatLocalDateTime(new Date(estDateTimePull)) : 'Unknown',
          nextPullTimeUTC: estDateTimePull,
          lastPullDateTime: lp.dateTime || formatLocalDateTime(new Date(lp.dateTimeUTC)),
          lastPullDateTimeUTC: lp.dateTimeUTC,
          lastPullBbls: String(lp.bblsTaken),
          lastPullTopLevel: inchesToFeetInches(lp.tankTopInches),
          lastPullBottomLevel: inchesToFeetInches(tankAfterInches),
          lastPullDriverId: lp.driverId || null,
          lastPullDriverName: lp.driverName || null,
          lastPullPacketId: lp.packetId || null,
          wellDown: lp.wellDown || false,
          status: 'success',
          timestamp: timestamp.toISOString(),
          timestampUTC: timestamp.toISOString(),
          isEdit: true,          // WB M accepts even though lastPullDateTimeUTC may be older
          isDeleteRebuild: true,
          windowBblsDay: windowBblsDay > 0 ? windowBblsDay.toString() : null,
          overnightBblsDay: overnightBblsDay > 0 ? overnightBblsDay.toString() : null,
          companyId: outgoingCompanyId(config),
        };
        sidecar.outgoing = { deleteResponseIds: oldResponseIds, responseId, response };
        if (afr > 0) { const m = afr * 24 * 60; sidecar.afr = { wellName, avgFlowRate: daysToHMMSS(afr), avgFlowRateMinutes: Math.round(m * 100) / 100 }; }
      } else {
        // No remaining pulls — clear outgoing (delete-only, no replacement).
        sidecar.outgoing = { deleteResponseIds: oldResponseIds };
      }

      const outcome = await runCanonicalMutation(makeCoordinatorIO(db, wellName), {
        wellName, operationId: `delete_${targetPacketId}`,
        buildPatch: async () => {
          const curRev = Number((await db.ref(`wells/${wellName}/status/chronoRevision`).once('value')).val()) || 0;
          const revision = curRev + 1;
          const built = buildDeleteMutation({
            wellName, operationId: `delete_${targetPacketId}`, fence: revision, revision,
            committedAtMs: Date.now(), patchHash: `delete_${targetPacketId}:${revision}`, sidecar,
            existingChain: chain, deletePacketId: targetPacketId, cfg,
          });
          if (deletedPerfTs) built.patch[`performance/${wellKey}/rows/${deletedPerfTs}`] = null;
          // Audit archive + source-request removal are PART of the same atomic patch.
          built.patch[`packets/processed/delete_${targetPacketId}`] = auditData;
          built.patch[`packets/incoming/${deleteIncomingId}`] = null;
          return { patch: built.patch, receipt: built.receipt };
        },
      });
      console.log(`[CANONICAL-DELETE] ${wellName}: ${targetPacketId} → ${outcome.status}`);
      if (outcome.status !== 'committed' && outcome.status !== 'already_done') {
        console.error(`[CANONICAL-DELETE] ${wellName}: ${targetPacketId} → ${outcome.status} (incoming left for retry)`);
        return null;
      }
    }

    // packet-not-found: no canonical state changed, so there is no coordinator
    // commit — consume the orphan delete request + write its audit archive as ONE
    // atomic update (never a lone remove that could strand the audit).
    if (!deletedPacket) {
      // Authorized, well-formed delete whose target is already absent: a terminal,
      // deterministic NO-OP mutation. It still routes through the governed
      // coordinator so it gets an operation RECEIPT (same-id replay → already_done,
      // distinguishable from a collision) and consumes the source request in the
      // SAME atomic update — with NO well-state (current/outgoing/status/perf) change.
      const notFoundOutcome = await runCanonicalMutation(makeCoordinatorIO(db, wellName), {
        wellName, operationId: `delete_${targetPacketId}`,
        buildPatch: async () => {
          const curRev = Number((await db.ref(`wells/${wellName}/status/chronoRevision`).once('value')).val()) || 0;
          const revision = curRev + 1;
          const receipt: CommitReceipt = {
            operationId: `delete_${targetPacketId}`, mutationType: 'delete', wellName, fence: revision, revision,
            affectedPacketIds: [], committedAtMs: Date.now(), patchHash: `delete_${targetPacketId}:${revision}:notfound`,
          };
          const patch = assembleCanonicalPatch({
            processedUpdates: {}, // no row removed — the target was already absent
            fence: { wellName, revision },
            receipt, receiptPath: receiptPathFor(wellName, `delete_${targetPacketId}`),
          });
          patch[`packets/processed/delete_${targetPacketId}`] = auditData; // terminal audit result
          patch[`packets/incoming/${deleteIncomingId}`] = null;            // source-request consumption
          return { patch, receipt };
        },
      });
      console.log(`[CANONICAL-DELETE] ${wellName}: ${targetPacketId} → ${notFoundOutcome.status} (authorized no-op, target absent)`);
    }

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
  computed?: { tankAfterInches: number; tanks: number },
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
    let bottomInches: number;
    let sourceUsed: string;

    if (computed && Number.isFinite(computed.tankAfterInches)) {
      // Caller already computed the correct bottom (uses well_config.tanks). Use it directly.
      tanks = computed.tanks || 1;
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
      } catch (e) {
        console.warn('[LevelChat] well_config lookup failed, defaulting tanks=1:', e);
      }
      const bblsInInches = data.bblsTaken > 0 ? (data.bblsTaken / (20 * tanks)) * 12 : 0;
      bottomInches = topInches - bblsInInches;
      sourceUsed = `recompute(well_config.tanks=${tanks})`;
    }

    const bblPerFt = 20 * tanks;
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

// ============================================================
// ADMIN — inviteEmployee
// Create a Firebase Auth account + RTDB users/{uid} record for a new
// dashboard user with the chosen role. If a driverHash is supplied, the
// new user is linked to that driver record (driver's phone-app login
// stays intact; they now ALSO have dashboard credentials at the picked
// role). Returns a password-reset link the admin can send / click to
// finish onboarding — no email infra required for v1.
//
// Authorization:
//   - Requires the caller to be authenticated (context.auth).
//   - Caller must have 'manageDrivers' capability at the target company,
//     checked against companies/{companyId}.roleCapabilities with fallback
//     to DEFAULT_ROLE_CAPABILITIES_SERVER.
//   - If the caller has no companyId (WB admin), they can invite anyone.
//
// Edge cases:
//   - Email already exists in Firebase Auth → we REUSE that user (update
//     role/companyId) instead of failing. Admin gets a reset link so the
//     existing user can claim / reset the dashboard password.
//   - driverHash supplied but driver doesn't exist → reject.
//   - Linking: drivers/approved/{hash}.dashboardUid = uid AND
//     users/{uid}.driverHash = hash. Allows UI to show the link in both
//     directions.
// ============================================================
export const inviteEmployee = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    const auth = request.auth;
    if (!auth?.uid) {
      throw new httpsV2.HttpsError('unauthenticated', 'Must be signed in');
    }
    const { email, displayName, role, companyId, driverHash } = (request.data || {}) as {
      email?: string;
      displayName?: string;
      role?: string;
      companyId?: string;       // target company for the new employee
      driverHash?: string;      // optional — link to an existing driver
    };
    if (!email || !role) {
      throw new httpsV2.HttpsError('invalid-argument', 'email and role are required');
    }
    const VALID_ROLES = ['driver', 'viewer', 'dispatch', 'payroll', 'manager', 'admin', 'it'];
    if (!VALID_ROLES.includes(role)) {
      throw new httpsV2.HttpsError('invalid-argument', `role must be one of: ${VALID_ROLES.join(', ')}`);
    }
    const normalizedEmail = email.trim().toLowerCase();

    // Caller authorization — must have manageDrivers capability at the
    // target company. WB admin (no companyId on their record) can invite
    // to any company.
    const callerSnap = await db.ref(`users/${auth.uid}`).once('value');
    const callerData = callerSnap.val();
    if (!callerData) {
      throw new httpsV2.HttpsError('permission-denied', 'Caller is not a registered dashboard user');
    }
    const callerCid = callerData.companyId || '';
    if (callerCid && companyId && callerCid !== companyId) {
      throw new httpsV2.HttpsError('permission-denied', 'Cannot invite to a company you do not belong to');
    }
    // Load the target company's roleCapabilities override (if any) to
    // evaluate the caller's manageDrivers capability.
    let callerCaps: string[] = [];
    if (callerCid) {
      const cSnap = await firestoreDb.collection('companies').doc(callerCid).get();
      const roleCaps = (cSnap.data()?.roleCapabilities || {}) as Record<string, string[]>;
      callerCaps = resolveCapsForRole(callerData.role, roleCaps);
    } else {
      callerCaps = resolveCapsForRole(callerData.role, {});
    }
    if (!callerCaps.includes('manageDrivers')) {
      throw new httpsV2.HttpsError('permission-denied', 'Caller lacks manageDrivers capability');
    }

    // If driverHash supplied, verify it exists
    let driverData: any = null;
    if (driverHash) {
      const dSnap = await db.ref(`drivers/approved/${driverHash}`).once('value');
      if (!dSnap.exists()) {
        throw new httpsV2.HttpsError('not-found', `Driver hash ${driverHash.slice(0, 8)} not found in approved drivers`);
      }
      driverData = dSnap.val();
    }

    // Find or create the Firebase Auth user
    const authAdmin = admin.auth();
    let uid: string;
    let existed = false;
    try {
      const existing = await authAdmin.getUserByEmail(normalizedEmail);
      uid = existing.uid;
      existed = true;
      console.log(`[inviteEmployee] reusing existing auth user ${uid} for ${normalizedEmail}`);
    } catch (err: any) {
      if (err?.code !== 'auth/user-not-found') throw err;
      const resolvedName =
        displayName?.trim() ||
        driverData?.legalName ||
        driverData?.displayName ||
        normalizedEmail.split('@')[0];
      const created = await authAdmin.createUser({
        email: normalizedEmail,
        emailVerified: false,
        displayName: resolvedName,
        disabled: false,
      });
      uid = created.uid;
      console.log(`[inviteEmployee] created new auth user ${uid} for ${normalizedEmail}`);
    }

    // Resolve display name for RTDB
    const resolvedDisplayName =
      displayName?.trim() ||
      driverData?.legalName ||
      driverData?.displayName ||
      normalizedEmail.split('@')[0];

    // Write the users/{uid} record. Merges with existing entry if any.
    const userUpdate: Record<string, any> = {
      email: normalizedEmail,
      displayName: resolvedDisplayName,
      role,
    };
    if (companyId) userUpdate.companyId = companyId;
    if (driverHash) userUpdate.driverHash = driverHash;
    await db.ref(`users/${uid}`).update(userUpdate);

    // Link the driver record back to the new dashboard user so the UI can
    // show the link in both directions.
    if (driverHash) {
      await db.ref(`drivers/approved/${driverHash}`).update({
        dashboardUid: uid,
        dashboardRole: role,
      });
    }

    // Generate password-reset link. For a brand-new user this effectively
    // becomes a "set initial password" link. Safe to use the generic
    // generatePasswordResetLink for both new and existing users.
    let resetLink: string | null = null;
    try {
      resetLink = await authAdmin.generatePasswordResetLink(normalizedEmail);
    } catch (err: any) {
      console.warn(`[inviteEmployee] failed to generate reset link for ${normalizedEmail}:`, err?.message);
    }

    return {
      uid,
      email: normalizedEmail,
      role,
      displayName: resolvedDisplayName,
      existed,
      resetLink,
      driverHash: driverHash || null,
    };
  },
);

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
// ============================================================
// addSplitLeg — Add a leg to an existing dispatch split chain.
//
// Used by:
//   - Dashboard: pre-dispatch multi-leg creation (Split Ticket + "+")
//   - WB T: field-time remainder / extra-destination case where the
//     driver discovers the need for an additional split leg
//     (e.g., partial delivery, remainder to SWD).
//
// The chain is identified by splitGroupId — every sibling dispatch
// shares one. This callable enumerates siblings, computes next
// sequence + total, writes the new leg with full lineage, and
// updates splitTotal on every existing sibling dispatch AND any
// associated invoice doc. Atomic via Firestore batch.
//
// The new leg is created in status='pending' — it does NOT auto-
// accept. Driver intentionally opens it from DJD (per user
// directive: field-created legs should not auto-open after save;
// only dispatcher-prebuilt chains auto-continue on close).
//
// Inputs:
//   parentDispatchId : any sibling dispatchId in the chain
//   callerDriverHash : optional, attributes 'field' origination
//   legSpec          : { disposal, disposalLat?, disposalLng?,
//                        bbls?, jobType?, serviceType?, notes? }
//
// Output:
//   { newDispatchId, splitGroupId, splitSequence, splitTotal }
//
// Errors:
//   invalid-argument    — missing parentDispatchId or legSpec.disposal
//   not-found           — parent dispatch missing
//   failed-precondition — parent has no splitGroupId
//   permission-denied   — callerDriverHash mismatch with parent
//   internal            — sibling enumeration failed
// ============================================================
export const addSplitLeg = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    const data = (request.data || {}) as {
      parentDispatchId?: string;
      callerDriverHash?: string;
      legSpec?: {
        disposal?: string;
        disposalLat?: number | null;
        disposalLng?: number | null;
        bbls?: number | null;
        jobType?: string | null;
        serviceType?: string | null;
        notes?: string | null;
      };
    };

    const parentDispatchId = data.parentDispatchId;
    const legSpec = data.legSpec || {};
    const callerDriverHash = data.callerDriverHash || null;

    if (!parentDispatchId) {
      throw new httpsV2.HttpsError('invalid-argument', 'parentDispatchId is required');
    }
    if (!legSpec.disposal || typeof legSpec.disposal !== 'string') {
      throw new httpsV2.HttpsError('invalid-argument', 'legSpec.disposal is required');
    }

    const parentRef = firestoreDb.collection('dispatches').doc(parentDispatchId);
    const parentSnap = await parentRef.get();
    if (!parentSnap.exists) {
      throw new httpsV2.HttpsError('not-found', `Parent dispatch ${parentDispatchId} not found`);
    }
    const parent = parentSnap.data() as Record<string, any>;
    const splitGroupId = parent.splitGroupId;
    if (!splitGroupId) {
      throw new httpsV2.HttpsError(
        'failed-precondition',
        `Parent dispatch ${parentDispatchId} is not part of a split chain (no splitGroupId)`,
      );
    }
    if (callerDriverHash && parent.driverHash && callerDriverHash !== parent.driverHash) {
      throw new httpsV2.HttpsError(
        'permission-denied',
        'Caller driverHash does not match parent dispatch driver',
      );
    }

    const siblingSnap = await firestoreDb
      .collection('dispatches')
      .where('splitGroupId', '==', splitGroupId)
      .get();
    if (siblingSnap.empty) {
      throw new httpsV2.HttpsError(
        'internal',
        `Could not enumerate siblings for splitGroupId=${splitGroupId}`,
      );
    }

    let maxSequence = 0;
    let leg1DispatchId: string | null = null;
    const siblingRefs: FirebaseFirestore.DocumentReference[] = [];
    siblingSnap.forEach((docSnap) => {
      const d = docSnap.data() as Record<string, any>;
      const seq = typeof d.splitSequence === 'number' ? d.splitSequence : 0;
      if (seq > maxSequence) maxSequence = seq;
      if (seq === 1) leg1DispatchId = docSnap.id;
      siblingRefs.push(docSnap.ref);
    });
    const nextSequence = maxSequence + 1;
    const newTotal = siblingSnap.size + 1;
    const rootParentId = leg1DispatchId || parentDispatchId;

    const now = admin.firestore.Timestamp.now();
    const newDispatchRef = firestoreDb.collection('dispatches').doc();
    const newDispatch: Record<string, any> = {
      driverHash: parent.driverHash,
      driverName: parent.driverName,
      driverFirstName: parent.driverFirstName || null,
      wellName: parent.wellName,
      ndicWellName: parent.ndicWellName || parent.wellName,
      operator: parent.operator || null,
      packageId: parent.packageId || null,
      companyId: parent.companyId || null,
      priority: parent.priority || 5,
      onsiteBy: parent.onsiteBy || null,

      disposal: legSpec.disposal,
      ...(legSpec.disposalLat != null ? { disposalLat: legSpec.disposalLat } : {}),
      ...(legSpec.disposalLng != null ? { disposalLng: legSpec.disposalLng } : {}),
      ...(legSpec.bbls != null ? { bbls: legSpec.bbls } : {}),
      jobType: legSpec.jobType || parent.jobType || null,
      serviceType: legSpec.serviceType || parent.serviceType || null,
      notes:
        legSpec.notes ||
        `Split ticket ${String.fromCharCode(65 + nextSequence - 1)} (field-added)`,

      splitGroupId,
      splitSequence: nextSequence,
      splitTotal: newTotal,
      parentDispatchId: rootParentId,
      splitOriginatedAt: callerDriverHash ? 'field' : 'dashboard',
      splitOriginatedBy:
        callerDriverHash || (request.auth?.uid || 'addSplitLeg-cf'),

      status: 'pending',
      assignedAt: now,
      assignedBy: callerDriverHash
        ? `driver:${callerDriverHash}`
        : (request.auth?.uid || 'addSplitLeg-cf'),
      createdAt: now,
      loadCount: 1,
      loadsCompleted: 0,
    };

    const batch = firestoreDb.batch();
    batch.set(newDispatchRef, newDispatch);

    for (const ref of siblingRefs) {
      batch.update(ref, {
        splitTotal: newTotal,
        updatedAt: now,
      });
    }

    const invSnap = await firestoreDb
      .collection('invoices')
      .where('dispatchSplitGroupId', '==', splitGroupId)
      .get();
    invSnap.forEach((doc) => {
      batch.update(doc.ref, {
        dispatchSplitTotal: newTotal,
        updatedAt: now,
      });
    });

    await batch.commit();

    console.log(
      `[addSplitLeg] added leg seq=${nextSequence} total=${newTotal} ` +
        `to splitGroupId=${splitGroupId} parent=${rootParentId} ` +
        `originatedAt=${callerDriverHash ? 'field' : 'dashboard'}`,
    );

    return {
      newDispatchId: newDispatchRef.id,
      splitGroupId,
      splitSequence: nextSequence,
      splitTotal: newTotal,
    };
  },
);

export {
  recoverHandoffOrphan,
  listStuckHandoffs,
} from './handoff-recovery';

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
  adminGetDashboardCatalog,
  adminGetWellPool,
  adminGetWellHistory,
  adminGetWellPerformance,
  dismissDispatch,
  staffWriteDispatch,
  staffWriteDriverAssignment,
  staffWriteWellConfig,
  staffConvertApprovedDriverSecureLogin,
  upgradeOwnLegacyDriverLogin,
  staffHydrateCanonicalIdentity,
  staffRetireLegacyDriverLogin,
  getOwnDriverHydration,
  // Operational path hardening
  ingestDriverPacket,
  ingestWbmPull,
  ingestWbmEdit,
  getGovernedWellConfig,
  upsertDriverShift,
  resolveActiveDriverShift,
  claimDriverShift,
  closeDriverShift,
  recordDepartReturn,
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
