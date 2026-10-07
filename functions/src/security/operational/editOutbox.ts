import {effectiveFlow} from '../../effectiveFlow';
import {refreshFlowWindow} from '../../refreshFlowWindow';
/**
 * Event-scoped durable edit outbox and state machine.
 *
 * Guarantees that:
 * 1. Outbox state is persisted BEFORE / ATOMICALLY with any mutation.
 * 2. Failed outgoing writes or crashes do not lose work or allow replayed no-ops to swallow changes.
 * 3. Exact committed outgoing payload (including AFR flow rate, company, driver, hints) is preserved and replayed.
 * 4. Source-authoritative order is assigned once at birth and preserved on retry.
 * 5. Distinct edits are never swallowed by concurrent or pending sibling edits.
 * 6. Older retries never regress newer completed edits (superseded check).
 * 7. Infrastructure errors are distinguished from intentional non-delivery and retried durably.
 */
import type * as admin from 'firebase-admin';
import {
  computePullRevision,
  findDispatchIdsForPull,
  publishPullCorrectionToDispatches,
  type PullCorrectionSignal,
  type DispatchLookupHints,
} from './pullCorrectionSignal';
import {
  buildAppliedEditEvent,
  buildFieldDiff,
  editHistoryWritePaths,
  editSummaryFields,
  nextEditCount,
  normalizeEditSource,
  normalizeOriginAppContext,
  resolveEditAuditContext,
  resolveOriginalSubmissionAt,
  resolveEditEventId,
  type FieldChange,
} from '../../editHistory';

export interface OutboxMeasurements {
  tankTopInches: number;
  tankLevelFeet: number;
  bblsTaken: number;
  dateTimeUTC: string;
  dateTime: string;
  tankAfterInches: number;
  tankAfterFeet: string;
  rawCalculatedBottomInches: number;
  hitLoadLine: boolean;
  recoveryInches: number;
  flowRateDays: number;
  flowRate: string; // Individual pull interval flow rate
  timeDif: string;
  timeDifDays: number;
  wellDown: boolean;
  noLevel?: boolean;
}

export interface EditOutboxRecord {
  eventId: string;
  incomingPacketId: string;
  originalPacketId: string;
  wellName: string;
  companyId: string;
  driverId: string | null;
  driverName: string | null;
  sequence: number;
  source: string;
  createdAtMs: number; // Source-authoritative order, set ONCE at birth
  updatedAtMs: number;
  attempts: number;

  stage: 'prepared' | 'processed_written' | 'outgoing_committed' | 'dispatches_delivered' | 'done';
  completed: boolean;
  superseded?: boolean;
  supersededByEventId?: string;
  supersededByRevision?: string;

  measurements: OutboxMeasurements;
  fieldDiff: FieldChange[] | Record<string, unknown>;
  trailSummary: Record<string, unknown>;
  historyPaths: Record<string, unknown>;
  nextEditIsDown: boolean;
  editIsAuthoritative: boolean;
  configKey: string;

  revision: string;
  isLatestPull: boolean;
  afr: number;
  outgoingPayload: Record<string, any> | null;
  outgoingResponseId?: string;

  dispatchSignal: PullCorrectionSignal | null;
  dispatchLookupHints: DispatchLookupHints | null;
  targetDispatchIds: string[];
  deliveredDispatchIds: string[];
  pendingDispatchIds: string[];
  permanentSkipReason?: string | null;

  lastError?: string | null;
  lastErrorStage?: string | null;
}

// ── Pure Formatting & Domain Helpers ──────────────────────────────────────────

export function inchesToFeetInches(inches: number): string {
  const feet = Math.floor(inches / 12);
  const remainingInches = Math.floor(inches % 12);
  return `${feet}'${remainingInches}"`;
}

export function feetInchesToInches(str: string): number {
  if (!str) return 0;
  const match = str.match(/(\d+)'(\d+)"/);
  if (match) {
    return parseInt(match[1], 10) * 12 + parseInt(match[2], 10);
  }
  return 0;
}

export function daysToHMM(days: number): string {
  const totalMinutes = Math.floor(days * 24 * 60);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${hours}:${mins.toString().padStart(2, '0')}`;
}

export function daysToHMMSS(days: number): string {
  const totalSeconds = Math.floor(days * 24 * 60 * 60);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export function formatLocalDateTime(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const year = d.getFullYear();
  let hours = d.getHours();
  const mins = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${month}/${day}/${year} ${hours}:${mins} ${ampm}`;
}

export function outgoingCompanyId(config: { companyId?: unknown } | null | undefined): string {
  const cid = typeof config?.companyId === 'string' ? config.companyId.trim() : '';
  return cid || 'liquid-gold';
}

// ── Outbox Preparation ────────────────────────────────────────────────────────

export async function prepareEditOutbox(
  db: admin.database.Database,
  incomingPacketId: string,
  data: Record<string, any>,
  origPacket: Record<string, any>,
  config: Record<string, any>,
  wellName: string,
  configKey: string,
): Promise<EditOutboxRecord> {
  const originalPacketId = data.canonicalPacketId || data.originalPacketId || data.packetId;
  const editEventId = resolveEditEventId({
    incomingPacketId,
    clientEventId: data.editEventId,
  });

  // Check if an outbox record already exists for this event
  const existingOutboxSnap = await db.ref(`packets/editOutbox/${editEventId}`).once('value');
  if (existingOutboxSnap.exists()) {
    return existingOutboxSnap.val() as EditOutboxRecord;
  }

  let nowMs = Date.now();
  let maxSeq = nextEditCount(origPacket);
  let maxBirthMs = nowMs;

  const outboxForPacketSnap = await db.ref('packets/editOutbox')
    .orderByChild('originalPacketId')
    .equalTo(originalPacketId)
    .once('value');
  if (outboxForPacketSnap.exists()) {
    outboxForPacketSnap.forEach((child) => {
      const rec = child.val() as EditOutboxRecord;
      if (rec) {
        if (typeof rec.sequence === 'number' && rec.sequence >= maxSeq) {
          maxSeq = rec.sequence + 1;
        }
        if (typeof rec.createdAtMs === 'number' && rec.createdAtMs >= maxBirthMs) {
          maxBirthMs = rec.createdAtMs + 1;
        }
      }
    });
  }
  const sequence = maxSeq;
  nowMs = maxBirthMs;
  const auditCtx = resolveEditAuditContext(origPacket);
  const editSource = normalizeEditSource(data.source);
  const originalSubmissionAt =
    auditCtx.originalSubmissionAt || resolveOriginalSubmissionAt(origPacket);
  const originAppContext =
    normalizeOriginAppContext(origPacket.originAppContext) !== 'unknown'
      ? normalizeOriginAppContext(origPacket.originAppContext)
      : normalizeOriginAppContext(data.originAppContext);
  const freezeOriginal = !origPacket.originalSubmittedAt;
  const editedAtIso = new Date(nowMs).toISOString();

  const tanks = config.tanks || config.numTanks || 1;
  const bblPerFoot = Number(config.bblPerFoot) > 0 ? Number(config.bblPerFoot) : 20 * tanks;
  const pullBbls = config.pullBbls || 100;
  const bottomInches = (config.bottomLevel || config.allowedBottom || 1) * 12;
  const loadLineInches = (config.loadLine ?? 0) * 12;

  let newTankTopInches = origPacket.tankTopInches;
  if (data.tankTopInches !== undefined) {
    newTankTopInches = data.tankTopInches;
  } else if (data.tankLevelFeet !== undefined) {
    newTankTopInches = data.tankLevelFeet * 12;
  }
  const newBblsTaken = data.bblsTaken !== undefined ? data.bblsTaken : origPacket.bblsTaken;
  const newDateTimeUTC = data.dateTimeUTC || origPacket.dateTimeUTC;
  const rawDateTime = data.dateTime || origPacket.dateTime;
  const newDateTime = rawDateTime ? rawDateTime.replace(/:(\d{2})\s*(AM|PM)/i, ' $2') : '';

  const newWellDown =
    data.wellDown !== undefined
      ? (data.wellDown === true || data.wellDown === 'true')
      : (origPacket.wellDown || false);

  const editIsAuthoritative =
    data.wellDownIsAuthoritative === true && data.wellDown !== undefined;
  const editExistingIsDownSnap = await db.ref(`wells/${wellName}/status/isDown`).once('value');
  const editExistingIsDown = editExistingIsDownSnap.val() === true;
  const nextEditIsDown = editIsAuthoritative ? newWellDown : editExistingIsDown;

  const fieldDiff = buildFieldDiff(origPacket, {
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
    actorDriverId: data.driverId ?? origPacket.driverId ?? null,
    actorDriverName: data.driverName ?? null,
    clientAppVersion: data.clientAppVersion ?? null,
    fields: fieldDiff,
    originalSubmissionAt,
    resolutionPath: 'direct',
    editRequestId: incomingPacketId,
  });

  const trailSummary = editSummaryFields({
    editedAt: editedAtIso,
    source: editSource,
    editCount: sequence,
    originalSubmissionAt,
    freezeOriginal,
  });
  const historyPaths = editHistoryWritePaths(originalPacketId, editEvent);

  // Non-production-tank edit
  if (newTankTopInches <= 0) {
    const record: EditOutboxRecord = {
      eventId: editEventId,
      incomingPacketId,
      originalPacketId,
      wellName,
      companyId: outgoingCompanyId(config),
      driverId: origPacket.driverId || data.driverId || null,
      driverName: origPacket.driverName || data.driverName || null,
      sequence,
      source: editSource,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      attempts: 0,
      stage: 'prepared',
      completed: false,
      measurements: {
        tankTopInches: 0,
        tankLevelFeet: 0,
        bblsTaken: newBblsTaken,
        dateTimeUTC: newDateTimeUTC,
        dateTime: newDateTime,
        tankAfterInches: 0,
        tankAfterFeet: '',
        rawCalculatedBottomInches: 0,
        hitLoadLine: false,
        recoveryInches: 0,
        flowRateDays: 0,
        flowRate: '',
        timeDif: '',
        timeDifDays: 0,
        wellDown: newWellDown,
        noLevel: true,
      },
      fieldDiff,
      trailSummary,
      historyPaths,
      nextEditIsDown,
      editIsAuthoritative,
      configKey,
      revision: '',
      isLatestPull: false,
      afr: 0,
      outgoingPayload: null,
      dispatchSignal: null,
      dispatchLookupHints: null,
      targetDispatchIds: [],
      deliveredDispatchIds: [],
      pendingDispatchIds: [],
    };
    await db.ref(`packets/editOutbox/${editEventId}`).set(record);
    return record;
  }

  // Recalculate tankAfter
  const bblsInInches = newBblsTaken > 0 ? (newBblsTaken / bblPerFoot) * 12 : 0;
  const rawNewTankAfterInches = newTankTopInches - bblsInInches;
  const newTankAfterInches = Math.max(rawNewTankAfterInches, loadLineInches);
  const editHitLoadLine = rawNewTankAfterInches < loadLineInches;

  // Previous pull for interval flow rate
  const prevOutgoingSnap = await db.ref('packets/processed')
    .orderByChild('wellName')
    .equalTo(wellName)
    .once('value');

  const editedTime = new Date(newDateTimeUTC).getTime();
  let prevTankAfterInches = 0;
  let prevTimestamp = '';

  prevOutgoingSnap.forEach((child) => {
    if (child.key === originalPacketId) return;
    const pkt = child.val();
    const pktTime = new Date(pkt.dateTimeUTC).getTime();
    if (pktTime < editedTime) {
      if (!prevTimestamp || pktTime > new Date(prevTimestamp).getTime()) {
        prevTankAfterInches = pkt.tankAfterInches || 0;
        prevTimestamp = pkt.dateTimeUTC;
      }
    }
  });

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
      flowRateDays = 0;
    } else {
      flowRate = daysToHMMSS(flowRateDays);
    }
  }

  if (flowRateDays === 0 && Number(origPacket.flowRateDays) > 0) {
    flowRateDays = Number(origPacket.flowRateDays);
    if (!flowRate && origPacket.flowRate) {
      flowRate = origPacket.flowRate;
    }
  }

  const flowWindow=effectiveFlow({...prevOutgoingSnap.val(),[originalPacketId]:{...origPacket,packetId:originalPacketId,tankTopInches:newTankTopInches,tankAfterInches:newTankAfterInches,bblsTaken:newBblsTaken,dateTimeUTC:newDateTimeUTC,wellDown:nextEditIsDown}},config);
  if(flowWindow){const sample=flowWindow.results.find(r=>r.packetId===originalPacketId);flowRateDays=sample?.flowRateDays||0;flowRate=flowRateDays?daysToHMMSS(flowRateDays):'';recoveryInches=sample?.recoveryInches||0;timeDifDays=sample?.timeDifDays||0;timeDif=timeDifDays?daysToHMM(timeDifDays):'';}
  // Calculate AFR across pulls
  const allPulls: any[] = [];
  prevOutgoingSnap.forEach((child) => {
    if (child.key === originalPacketId) {
      allPulls.push({
        dateTimeUTC: newDateTimeUTC,
        flowRateDays,
        tankTopInches: newTankTopInches,
      });
    } else {
      allPulls.push(child.val());
    }
  });

  allPulls.sort((a, b) => new Date(b.dateTimeUTC).getTime() - new Date(a.dateTimeUTC).getTime());
  const validRates: number[] = [];
  for (const p of allPulls) {
    const fr = Number(p.flowRateDays) || 0;
    if (fr > 0 && fr < 365) {
      validRates.push(fr);
      if (validRates.length >= 5) break;
    }
  }
  let afr = validRates.length > 0 ? validRates.reduce((sum, r) => sum + r, 0) / validRates.length : 0;
  if (afr === 0 && Number(origPacket.flowRateDays) > 0) {
    afr = Number(origPacket.flowRateDays);
  }
  if (afr === 0 && flowRateDays > 0) {
    afr = flowRateDays;
  }

  if(flowWindow)afr=flowWindow.averageDays;
  // Determine if latest pull — inspect both outgoing response and relative pull timestamps
  const outgoingSnap = await db.ref('packets/outgoing')
    .orderByChild('wellName')
    .equalTo(wellName)
    .once('value');

  let isLatestPull = false;
  let hasOutgoing = false;
  if (outgoingSnap.exists()) {
    outgoingSnap.forEach((child) => {
      hasOutgoing = true;
      const resp = child.val();
      if (
        resp &&
        (resp.lastPullDateTimeUTC === origPacket.dateTimeUTC ||
          resp.lastPullDateTimeUTC === newDateTimeUTC ||
          resp.originalPacketId === originalPacketId)
      ) {
        isLatestPull = true;
      }
    });
  }
  if (!hasOutgoing || (allPulls.length > 0 && allPulls[0].dateTimeUTC === newDateTimeUTC)) {
    isLatestPull = true;
  }

  let outgoingPayload: Record<string, any> | null = null;
  let dispatchSignal: PullCorrectionSignal | null = null;
  let newRevision = '';
  const newBottomLevelStr = inchesToFeetInches(newTankAfterInches);
  const newFlowRateStr = afr > 0 ? daysToHMMSS(afr) : (flowRate || origPacket.flowRate || '12:00:00');

  if (isLatestPull) {
    const pullHeightInches = (pullBbls / bblPerFoot) * 12;
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

    const bbls24 = (1 / afr) * bblPerFoot;
    const bbls24hrs = Math.round(bbls24).toString();
    newRevision = computePullRevision(originalPacketId, newBottomLevelStr, newDateTimeUTC, newFlowRateStr);

    outgoingPayload = {
      wellName,
      currentLevel: newBottomLevelStr,
      flowRate: newFlowRateStr, // Exact AFR flow rate
      bbls24hrs,
      lastPullTopLevel: inchesToFeetInches(newTankTopInches),
      lastPullBottomLevel: newBottomLevelStr,
      lastPullBbls: newBblsTaken.toString(),
      lastPullDateTime: newDateTime || formatLocalDateTime(new Date(newDateTimeUTC)),
      lastPullDateTimeUTC: newDateTimeUTC,
      timeTillPull: nextEditIsDown ? 'Down' : (estTimeToPull || 'Calculating...'),
      nextPullTime: estDateTimePull ? formatLocalDateTime(new Date(estDateTimePull)) : 'Unknown',
      nextPullTimeUTC: estDateTimePull,
      isEdit: true,
      originalPacketId,
      wellDown: nextEditIsDown,
      lastPullDriverId: origPacket.driverId || data.driverId || null,
      lastPullDriverName: origPacket.driverName || data.driverName || null,
      lastPullPacketId: originalPacketId,
      lastPullRevision: newRevision,
      windowBblsDay: null,
      overnightBblsDay: null,
      companyId: outgoingCompanyId(config),
    };

    dispatchSignal = {
      packetId: originalPacketId,
      revision: newRevision,
      sequence,
      bottomLevel: newBottomLevelStr,
      pullDateTimeUTC: newDateTimeUTC,
      flowRate: newFlowRateStr, // Exact AFR flow rate matches outgoing
      publishedAtMs: nowMs, // Source-authoritative order, set ONCE at birth
      wellName,
      companyId: outgoingCompanyId(config),
      driverId: origPacket.driverId || data.driverId || null,
    };
  }

  const dispatchLookupHints: DispatchLookupHints = {
    dispatchId: origPacket.dispatchId || data.dispatchId || null,
    ticketDispatchId: origPacket.ticketDispatchId || data.ticketDispatchId || null,
    invoiceDispatchId: origPacket.invoiceDispatchId || data.invoiceDispatchId || null,
    packetId: originalPacketId,
    companyId: outgoingCompanyId(config),
    wellName,
    driverId: origPacket.driverId || data.driverId || null,
  };

  const record: EditOutboxRecord = {
    eventId: editEventId,
    incomingPacketId,
    originalPacketId,
    wellName,
    companyId: outgoingCompanyId(config),
    driverId: origPacket.driverId || data.driverId || null,
    driverName: origPacket.driverName || data.driverName || null,
    sequence,
    source: editSource,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    attempts: 0,
    stage: 'prepared',
    completed: false,
    measurements: {
      tankTopInches: newTankTopInches,
      tankLevelFeet: newTankTopInches / 12,
      bblsTaken: newBblsTaken,
      dateTimeUTC: newDateTimeUTC,
      dateTime: newDateTime,
      tankAfterInches: newTankAfterInches,
      tankAfterFeet: inchesToFeetInches(newTankAfterInches),
      rawCalculatedBottomInches: rawNewTankAfterInches,
      hitLoadLine: editHitLoadLine,
      recoveryInches,
      flowRateDays,
      flowRate,
      timeDif,
      timeDifDays,
      wellDown: newWellDown,
    },
    fieldDiff,
    trailSummary,
    historyPaths,
    nextEditIsDown,
    editIsAuthoritative,
    configKey,
    revision: newRevision,
    isLatestPull,
    afr,
    outgoingPayload,
    dispatchSignal,
    dispatchLookupHints,
    targetDispatchIds: [],
    deliveredDispatchIds: [],
    pendingDispatchIds: [],
  };

  // Atomically persist outbox record BEFORE any mutation
  await db.ref(`packets/editOutbox/${editEventId}`).set(record);
  return record;
}

// ── Outbox Execution ──────────────────────────────────────────────────────────

export async function executeEditOutbox(
  db: admin.database.Database,
  firestore: admin.firestore.Firestore,
  outbox: EditOutboxRecord,
  options?: {
    serverTimestamp?: any;
    arrayUnion?: (val: unknown) => any;
    driverIdentityResolver?: (idA: string, idB: string) => Promise<boolean>;
  },
): Promise<{ ok: boolean; outbox: EditOutboxRecord; error?: string }> {
  const outboxRef = db.ref(`packets/editOutbox/${outbox.eventId}`);

  // 1. Superseded check: if a newer edit for this packet has already been applied,
  // do not overwrite newer business state on processed, outgoing, or dispatches.
  const processedSnap = await db.ref(`packets/processed/${outbox.originalPacketId}`).once('value');
  if (processedSnap.exists()) {
    const currentPkt = processedSnap.val() || {};
    const currentSeq = Number(currentPkt.editCount || 0);
    if (currentSeq > outbox.sequence) {
      console.log(
        `[EDIT_OUTBOX_SUPERSEDED] ${outbox.wellName}: outbox event ${outbox.eventId} (seq ${outbox.sequence}) ` +
          `is superseded by current packet state (seq ${currentSeq}) — completing without regression`,
      );
      outbox.superseded = true;
      outbox.stage = 'done';
      outbox.completed = true;
      outbox.updatedAtMs = Date.now();
      await outboxRef.update({
        superseded: true,
        stage: 'done',
        completed: true,
        updatedAtMs: outbox.updatedAtMs,
      });
      await db.ref(`packets/incoming/${outbox.incomingPacketId}`).remove().catch(() => {});
      return { ok: true, outbox };
    }
  }

  // 2. Stage: prepared → write processed packet + edit history
  if (outbox.stage === 'prepared') {
    const updates: Record<string, any> = {
      ...outbox.measurements,
      ...outbox.trailSummary,
      activeEditEventId: outbox.eventId,
    };

    await db.ref().update({
      ...Object.fromEntries(
        Object.entries(updates).map(([k, v]) => [`packets/processed/${outbox.originalPacketId}/${k}`, v]),
      ),
      ...outbox.historyPaths,
    });

    await db.ref(`wells/${outbox.wellName}/status/isDown`).set(outbox.nextEditIsDown);
    if (outbox.editIsAuthoritative) {
      await db.ref(`well_config/${outbox.configKey}/isDown`).set(outbox.nextEditIsDown);
    }

    outbox.stage = 'processed_written';
    outbox.attempts += 1;
    outbox.updatedAtMs = Date.now();
    await outboxRef.update({
      stage: 'processed_written',
      attempts: outbox.attempts,
      updatedAtMs: outbox.updatedAtMs,
    });
  }

  // 3. Stage: processed_written → commit outgoing row
  if (outbox.stage === 'processed_written') {
    if (outbox.outgoingPayload && outbox.isLatestPull) {
      let outgoingAlreadyMatches = false;
      const outgoingSnap = await db.ref('packets/outgoing')
        .orderByChild('wellName')
        .equalTo(outbox.wellName)
        .once('value');

      if (outgoingSnap.exists()) {
        outgoingSnap.forEach((child) => {
          if (child.val()?.lastPullRevision === outbox.revision) {
            outgoingAlreadyMatches = true;
          }
        });
      }

      if (!outgoingAlreadyMatches) {
        if (outgoingSnap.exists()) {
          const outgoingPromises: Promise<void>[] = [];
          outgoingSnap.forEach((child) => {
            outgoingPromises.push(child.ref.update(outbox.outgoingPayload!));
          });
          await Promise.all(outgoingPromises);
        } else {
          const respId =
            outbox.outgoingResponseId ||
            `response_${new Date(outbox.createdAtMs).toISOString().replace(/[-:]/g, '').replace('T', '_').split('.')[0]}_${outbox.wellName.replace(/\s/g, '')}`;
          await db.ref(`packets/outgoing/${respId}`).set(outbox.outgoingPayload);
        }
      }

      // Update AFR on well_config
      if (outbox.afr > 0) {
        const afrMinutes = outbox.afr * 24 * 60;
        await db.ref(`well_config/${outbox.wellName}`).update({
          avgFlowRate: daysToHMMSS(outbox.afr),
          avgFlowRateMinutes: Math.round(afrMinutes * 100) / 100,
        });
      }
    }

    await cascadeNextPacketRecovery(db, outbox);
    await updatePerformanceRow(db, outbox);
    await updateWellStatusRecalc(db, outbox);
    await refreshFlowWindow(db,outbox.wellName);

    // Stamp outgoing committed marker on processed packet
    if (outbox.revision) {
      await db.ref(`packets/processed/${outbox.originalPacketId}`).update({
        outgoingCommittedRevision: outbox.revision,
        outgoingCommittedEventId: outbox.eventId,
      });
    }

    outbox.stage = 'outgoing_committed';
    outbox.updatedAtMs = Date.now();
    await outboxRef.update({
      stage: 'outgoing_committed',
      updatedAtMs: outbox.updatedAtMs,
    });
  }

  // 4. Stage: outgoing_committed → publish confirmed pull correction to dispatches
  if (outbox.stage === 'outgoing_committed') {
    await cascadeToFirestore(firestore, outbox);
    if (!outbox.dispatchSignal) {
      outbox.stage = 'dispatches_delivered';
    } else {
      if (!outbox.targetDispatchIds || outbox.targetDispatchIds.length === 0) {
        try {
          outbox.targetDispatchIds = await findDispatchIdsForPull(
            firestore,
            outbox.dispatchLookupHints || { packetId: outbox.originalPacketId },
          );
        } catch (queryErr) {
          const errMsg = (queryErr as any)?.message || String(queryErr);
          outbox.lastError = errMsg;
          outbox.lastErrorStage = 'dispatch_query';
          outbox.updatedAtMs = Date.now();
          await outboxRef.update({
            lastError: errMsg,
            lastErrorStage: 'dispatch_query',
            updatedAtMs: outbox.updatedAtMs,
          });
          throw queryErr;
        }

        if (outbox.targetDispatchIds.length === 0) {
          outbox.permanentSkipReason = 'no_target_dispatches';
          outbox.stage = 'dispatches_delivered';
        }
      }

      if (outbox.targetDispatchIds && outbox.targetDispatchIds.length > 0) {
        const deliveredSet = new Set(outbox.deliveredDispatchIds || []);
        const pendingIds = outbox.targetDispatchIds.filter((id) => !deliveredSet.has(id));

        if (pendingIds.length > 0) {
          const pubResult = await publishPullCorrectionToDispatches(firestore, {
            dispatchIds: pendingIds,
            signal: outbox.dispatchSignal,
            rtdb: db,
            driverIdentityResolver: options?.driverIdentityResolver,
            serverTimestamp: options?.serverTimestamp,
            arrayUnion: options?.arrayUnion,
          });

          for (const did of pubResult.updatedDispatchIds) {
            deliveredSet.add(did);
          }
          outbox.deliveredDispatchIds = Array.from(deliveredSet);
          outbox.pendingDispatchIds = pubResult.failedDispatchIds;

          if (pubResult.failedDispatchIds.length > 0) {
            const errMsg = pubResult.error || 'Failed to update dispatches';
            outbox.lastError = errMsg;
            outbox.lastErrorStage = 'dispatch_publication';
            outbox.updatedAtMs = Date.now();
            await outboxRef.update({
              deliveredDispatchIds: outbox.deliveredDispatchIds,
              pendingDispatchIds: outbox.pendingDispatchIds,
              lastError: errMsg,
              lastErrorStage: 'dispatch_publication',
              updatedAtMs: outbox.updatedAtMs,
            });
            throw new Error(errMsg);
          } else {
            outbox.pendingDispatchIds = [];
            outbox.stage = 'dispatches_delivered';
          }
        } else {
          outbox.stage = 'dispatches_delivered';
        }
      }

      if (outbox.revision && outbox.stage === 'dispatches_delivered') {
        await db.ref(`packets/processed/${outbox.originalPacketId}`).update({
          lastPullDeliveredRevision: outbox.revision,
          lastPullDeliveredEventId: outbox.eventId,
          lastPullRevision: outbox.revision,
          dispatchSignalPending: null,
          dispatchSignalPendingRevision: null,
          dispatchSignalError: null,
        });
      }
    }

    outbox.updatedAtMs = Date.now();
    await outboxRef.update({
      stage: outbox.stage,
      deliveredDispatchIds: outbox.deliveredDispatchIds || [],
      pendingDispatchIds: outbox.pendingDispatchIds || [],
      permanentSkipReason: outbox.permanentSkipReason || null,
      updatedAtMs: outbox.updatedAtMs,
    });
  }

  // 5. Stage: dispatches_delivered → acknowledge and cleanup incoming request
  if (outbox.stage === 'dispatches_delivered') {
    outbox.stage = 'done';
    outbox.completed = true;
    outbox.updatedAtMs = Date.now();
    await outboxRef.update({
      stage: 'done',
      completed: true,
      updatedAtMs: outbox.updatedAtMs,
    });

    // Remove incoming packet ONLY after complete
    await db.ref(`packets/incoming/${outbox.incomingPacketId}`).remove().catch(() => {});

    // Notify incoming version
    try {
      const snap = await db.ref('packets/incoming_version').once('value');
      const cur = Number(snap.val() || 0);
      await db.ref('packets/incoming_version').set(cur + 1);
    } catch {}

    return { ok: true, outbox };
  }

  return { ok: true, outbox };
}

// ── Watchdog & Background Re-entry Consumers ──────────────────────────────────

/**
 * Re-enters and retries a stranded edit request from packets/incoming.
 * Used by watchdogStrandedPackets to ensure stranded edits are not lost or quarantined.
 */
export async function retryStrandedEditRequest(
  db: admin.database.Database,
  firestore: admin.firestore.Firestore,
  incomingPacketId: string,
  data: Record<string, any>,
): Promise<{ ok: boolean; outbox?: EditOutboxRecord; error?: string }> {
  try {
    const originalPacketId = data.packetId;
    if (!originalPacketId) {
      return { ok: false, error: 'missing_packet_id' };
    }

    const editEventId = resolveEditEventId({
      incomingPacketId,
      clientEventId: data.editEventId,
    });

    const outboxSnap = await db.ref(`packets/editOutbox/${editEventId}`).once('value');
    let outbox: EditOutboxRecord;

    if (outboxSnap.exists()) {
      outbox = outboxSnap.val() as EditOutboxRecord;
    } else {
      const origSnap = await db.ref(`packets/processed/${originalPacketId}`).once('value');
      if (!origSnap.exists()) {
        return { ok: false, error: 'original_packet_not_found' };
      }
      const origPacket = origSnap.val();
      const wellName = data.wellName || origPacket.wellName;
      const cleanName = (wellName || '').replace(/\s/g, '');
      let configSnap = await db.ref(`well_config/${wellName}`).once('value');
      if (!configSnap.exists()) {
        configSnap = await db.ref(`well_config/${cleanName}`).once('value');
      }
      const config = configSnap.val() || {};
      const configKey = configSnap.key || wellName;

      outbox = await prepareEditOutbox(
        db,
        incomingPacketId,
        data,
        origPacket,
        config,
        wellName,
        configKey,
      );
    }

    return await executeEditOutbox(db, firestore, outbox);
  } catch (err) {
    const errMsg = (err as any)?.message || String(err);
    console.warn(`[editOutbox] retryStrandedEditRequest error for ${incomingPacketId}:`, err);
    return { ok: false, error: errMsg };
  }
}

/**
 * Sweeps all pending outbox records across the system and executes uncompleted ones.
 */
export async function reconcileAllPendingOutboxRecords(
  db: admin.database.Database,
  firestore: admin.firestore.Firestore,
): Promise<{ checked: number; reconciled: number; failed: number }> {
  let checked = 0;
  let reconciled = 0;
  let failed = 0;

  try {
    const snap = await db.ref('packets/editOutbox').once('value');
    if (!snap.exists()) return { checked: 0, reconciled: 0, failed: 0 };

    const records = snap.val() as Record<string, EditOutboxRecord>;
    for (const [eventId, record] of Object.entries(records)) {
      if (record && !record.completed) {
        checked++;
        try {
          const outcome = await executeEditOutbox(db, firestore, record);
          if (outcome.ok) {
            reconciled++;
          } else {
            failed++;
          }
        } catch (err) {
          console.warn(`[editOutbox] reconcile failed for outbox event ${eventId}:`, err);
          failed++;
        }
      }
    }
  } catch (err) {
    console.warn('[editOutbox] reconcileAllPendingOutboxRecords sweep error:', err);
  }

  return { checked, reconciled, failed };
}

// ── Private Cascade & Domain Helpers ──────────────────────────────────────────

async function cascadeNextPacketRecovery(db: admin.database.Database, outbox: EditOutboxRecord): Promise<void> {
  if (outbox.measurements.tankTopInches <= 0) return;
  try {
    const prevOutgoingSnap = await db.ref('packets/processed')
      .orderByChild('wellName')
      .equalTo(outbox.wellName)
      .once('value');

    const editedTime = new Date(outbox.measurements.dateTimeUTC).getTime();
    let nextPacketKey: string | null = null;
    let nextPacket: any = null;
    let closestNextTime = Infinity;

    prevOutgoingSnap.forEach((child) => {
      if (child.key === outbox.originalPacketId) return;
      const pkt = child.val();
      const pktTime = new Date(pkt.dateTimeUTC).getTime();
      if (pktTime > editedTime && pktTime < closestNextTime) {
        closestNextTime = pktTime;
        nextPacketKey = child.key;
        nextPacket = pkt;
      }
    });

    if (nextPacketKey && nextPacket && nextPacket.tankTopInches > 0) {
      const nextRecovery = Math.max(0, nextPacket.tankTopInches - outbox.measurements.tankAfterInches);
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
    }
  } catch (err) {
    console.warn('[editOutbox] cascadeNextPacketRecovery warning:', err);
  }
}

async function updatePerformanceRow(db: admin.database.Database, outbox: EditOutboxRecord): Promise<void> {
  if (outbox.measurements.tankTopInches <= 0) return;
  try {
    const perfPullTime = new Date(outbox.measurements.dateTimeUTC);
    const perfTimestamp = `${perfPullTime.getFullYear()}${String(perfPullTime.getMonth() + 1).padStart(2, '0')}${String(perfPullTime.getDate()).padStart(2, '0')}_${String(perfPullTime.getHours()).padStart(2, '0')}${String(perfPullTime.getMinutes()).padStart(2, '0')}${String(perfPullTime.getSeconds()).padStart(2, '0')}`;
    const perfDateStr = `${perfPullTime.getFullYear()}-${String(perfPullTime.getMonth() + 1).padStart(2, '0')}-${String(perfPullTime.getDate()).padStart(2, '0')}`;
    const perfWellKey = outbox.wellName.replace(/\s+/g, '_');
    const actualInches = Math.floor(outbox.measurements.tankTopInches);

    await db.ref(`performance/${perfWellKey}/rows/${perfTimestamp}`).set({
      d: perfDateStr,
      a: actualInches,
      p: actualInches,
    });
    await db.ref(`performance/${perfWellKey}/wellName`).set(outbox.wellName);
    await db.ref(`performance/${perfWellKey}/updated`).set(new Date().toISOString());
  } catch (err) {
    console.warn('[editOutbox] updatePerformanceRow warning:', err);
  }
}

async function updateWellStatusRecalc(db: admin.database.Database, outbox: EditOutboxRecord): Promise<void> {
  if (!outbox.isLatestPull || outbox.afr <= 0) return;
  try {
    const editAfrMinutes = outbox.afr * 24 * 60;
    const configSnap = await db.ref(`well_config/${outbox.configKey}`).once('value');
    const cfg = configSnap.val() || {};
    const tanks = cfg.tanks || cfg.numTanks || 1;
    const pullBbls = cfg.pullBbls || 100;
    const bblPerFoot = Number(cfg.bblPerFoot) > 0 ? Number(cfg.bblPerFoot) : 20 * tanks;
    const bottomInches = (cfg.bottomLevel || cfg.allowedBottom || 1) * 12;

    const pullHeightIn = (pullBbls / bblPerFoot) * 12;
    const targetLvl = bottomInches + pullHeightIn;
    const recovNeeded = Math.max(0, targetLvl - outbox.measurements.tankAfterInches);
    const estDays = recovNeeded > 0 ? (recovNeeded / 12) * outbox.afr : 0;
    const pullDate = new Date(outbox.measurements.dateTimeUTC);
    const estDate = new Date(pullDate.getTime() + estDays * 24 * 60 * 60 * 1000);

    const editWellStatus = {
      wellName: outbox.wellName,
      config: {
        tanks,
        bottomLevel: bottomInches / 12,
        route: cfg.route || 'Unassigned',
        pullBbls,
      },
      current: {
        level: inchesToFeetInches(outbox.measurements.tankAfterInches),
        levelInches: outbox.measurements.tankAfterInches,
        asOf: new Date().toISOString(),
      },
      lastPull: {
        dateTime: outbox.measurements.dateTime || formatLocalDateTime(new Date(outbox.measurements.dateTimeUTC)),
        dateTimeUTC: outbox.measurements.dateTimeUTC,
        topLevel: inchesToFeetInches(outbox.measurements.tankTopInches),
        topLevelInches: outbox.measurements.tankTopInches,
        bottomLevel: inchesToFeetInches(outbox.measurements.tankAfterInches),
        bottomLevelInches: outbox.measurements.tankAfterInches,
        rawCalculatedBottom: inchesToFeetInches(outbox.measurements.rawCalculatedBottomInches),
        rawCalculatedBottomInches: outbox.measurements.rawCalculatedBottomInches,
        hitLoadLine: outbox.measurements.hitLoadLine,
        bblsTaken: outbox.measurements.bblsTaken,
        driverName: outbox.driverName || '',
        packetId: outbox.originalPacketId,
        revision: outbox.revision,
      },
      calculated: {
        flowRate: daysToHMMSS(outbox.afr),
        flowRateMinutes: Math.round(editAfrMinutes * 100) / 100,
        bbls24hrs: Math.round((1 / outbox.afr) * bblPerFoot) || 0,
        nextPullTime: recovNeeded <= 0 ? formatLocalDateTime(pullDate) : formatLocalDateTime(estDate),
        nextPullTimeUTC: recovNeeded <= 0 ? outbox.measurements.dateTimeUTC : estDate.toISOString(),
        timeTillPull: outbox.nextEditIsDown ? 'Down' : (recovNeeded <= 0 ? '0:00' : daysToHMM(estDays)),
      },
      isDown: outbox.nextEditIsDown,
      updatedAt: new Date().toISOString(),
    };
    await db.ref(`wells/${outbox.wellName}/status`).set(editWellStatus);
  } catch (err) {
    console.warn('[editOutbox] updateWellStatusRecalc warning:', err);
  }
}

async function cascadeToFirestore(
  firestore: admin.firestore.Firestore,
  outbox: EditOutboxRecord,
): Promise<void> {
  if (!firestore) return;
  try {
    const originalPacketId = outbox.originalPacketId;
    const newTopFI = inchesToFeetInches(outbox.measurements.tankTopInches);
    const newBottomFI = inchesToFeetInches(outbox.measurements.tankAfterInches);
    const newBblsTaken = outbox.measurements.bblsTaken;
    const isCancelled = (inv: any) => inv?.status === 'cancelled' || inv?.status === 'canceled';

    let invoiceRef: any = null;
    let invoiceData: any = null;
    let ticketRef: any = null;

    const resolveTicketFromInvoice = async (invRef: any, invData: any): Promise<any> => {
      const summaries: any[] = Array.isArray(invData.ticketSummaries) ? invData.ticketSummaries : [];
      let chosen: any = summaries.find((s: any) => s && s.packetId && s.packetId === originalPacketId);
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

    // By packetId in invoices
    const invq = await firestore.collection('invoices').where('packetId', '==', originalPacketId).limit(5).get();
    const live = invq.docs.filter((d) => !isCancelled(d.data()));
    if (live.length === 1) {
      invoiceRef = live[0].ref;
      invoiceData = live[0].data();
      ticketRef = await resolveTicketFromInvoice(invoiceRef, invoiceData);
    }

    if (invoiceRef && invoiceData) {
      if (ticketRef) {
        await ticketRef.update({
          bbls: String(newBblsTaken),
          top: newTopFI,
          bottom: newBottomFI,
          editedAt: new Date(),
          editedBy: outbox.source || 'dashboard',
          updatedBy: outbox.source || 'dashboard',
          updatedAt: new Date(),
          packetId: originalPacketId,
        }).catch(() => {});
      }

      const summaries: any[] = Array.isArray(invoiceData.ticketSummaries)
        ? invoiceData.ticketSummaries.map((s: any) => ({ ...s }))
        : [];
      let matchedSummary: any = summaries.find(
        (s: any) =>
          (s.packetId && s.packetId === originalPacketId) ||
          (ticketRef && s.docId && s.docId === ticketRef.id),
      );
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
      const existingSnap =
        invoiceData.packetSnapshot && typeof invoiceData.packetSnapshot === 'object'
          ? invoiceData.packetSnapshot
          : {};
      const invUpdate: Record<string, any> = {
        totalBBL: invTotal,
        packetSnapshot: { ...existingSnap, bblsTaken: newBblsTaken, tankAfterFeet: newBottomFI },
        editedAt: new Date(),
        editedBy: outbox.source || 'dashboard',
      };
      if (summaries.length > 0) invUpdate.ticketSummaries = summaries;
      await invoiceRef.update(invUpdate).catch(() => {});
    }
  } catch (err) {
    console.warn('[editOutbox] cascadeToFirestore non-blocking warning:', err);
  }
}

