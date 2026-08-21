/**
 * Apply core for submitFieldCommand. Company-scoped outgoing/processed,
 * original-packet well binding, server well-down authority, real tank math.
 */
import type { SecureDriver } from '../requireDriverAuth';
import {
  afrDaysFromHistory,
  computeTankLevels,
  estimatePull,
  inchesToFeetInches,
  resolveBblPerFoot,
  type HistoricalPull,
} from './tankDomain';
import { contentDigest, decideAtomicMarkerWrite, generationNumber } from './fieldCommandLease';

export type FieldCommandType = 'pull' | 'edit' | 'delete';

export function incrementIncomingVersionValue(current: unknown): string {
  const raw = current && typeof current === 'object' && !Array.isArray(current)
    ? (current as { value?: unknown }).value
    : current;
  const n = parseInt(String(raw ?? '0'), 10);
  const base = Number.isFinite(n) ? n : 0;
  return String(base + 1);
}

export function applyIncomingVersionState(
  current: unknown,
  scopeKey: string,
): { next: { value: string; acks: Record<string, boolean> }; already: boolean } {
  let value = '0';
  let acks: Record<string, boolean> = {};
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    const o = current as { value?: unknown; acks?: Record<string, boolean> };
    value = String(o.value ?? '0');
    acks = { ...(o.acks || {}) };
  } else if (current != null) {
    value = String(current);
  }
  if (acks[scopeKey]) return { next: { value, acks }, already: true };
  const nextVal = incrementIncomingVersionValue(value);
  return { next: { value: nextVal, acks: { ...acks, [scopeKey]: true } }, already: false };
}

export interface FieldApplyStores {
  getProcessed(packetId: string): Promise<Record<string, unknown> | null>;
  createProcessedOnly(packetId: string, data: Record<string, unknown>): Promise<void>;
  updateProcessed(packetId: string, patch: Record<string, unknown>): Promise<void>;
  listProcessedForWell(
    wellName: string,
    companyId: string,
  ): Promise<Array<{ id: string; data: Record<string, unknown> }>>;
  replaceOutgoingForWell(
    wellName: string,
    companyId: string,
    responseId: string,
    response: Record<string, unknown>,
  ): Promise<void>;
  incrementIncomingVersion(): Promise<void>;
  incrementIncomingVersionOnce?(scopeKey: string): Promise<void>;
  setWellDown(wellName: string, isDown: boolean): Promise<void>;
  getWellDown(wellName: string): Promise<boolean>;
  getWellConfig(wellName: string): Promise<Record<string, unknown>>;
  updateLinkedInvoice?(invoiceId: string, patch: Record<string, unknown>): Promise<void>;
  updateLinkedDispatch?(dispatchId: string, patch: Record<string, unknown>): Promise<void>;
  updateLinkedTicket?(ticketId: string, patch: Record<string, unknown>): Promise<void>;
  getLinkedInvoice?(invoiceId: string): Promise<Record<string, unknown> | null>;
  getLinkedDispatch?(dispatchId: string): Promise<Record<string, unknown> | null>;
  getLinkedTicket?(ticketId: string): Promise<Record<string, unknown> | null>;
  outgoingExists?(outgoingId: string): Promise<boolean>;
  getOutgoing?(outgoingId: string): Promise<Record<string, unknown> | null>;
  patchOutgoing?(outgoingId: string, patch: Record<string, unknown>): Promise<void>;
  /**
   * Compare-and-set processed marker generation + data in one transaction.
   * Returning undefined from apply aborts (used for stale).
   */
  transactProcessed?(
    packetId: string,
    apply: (curr: Record<string, unknown> | null) => Record<string, unknown> | undefined,
  ): Promise<{ committed: boolean; snapshot: Record<string, unknown> | null }>;
  /**
   * Compare-and-set outgoing companion generation + data.
   */
  transactOutgoing?(
    outgoingId: string,
    apply: (curr: Record<string, unknown> | null) => Record<string, unknown> | undefined,
  ): Promise<{ committed: boolean; snapshot: Record<string, unknown> | null }>;
  persistEffect?(name: FieldEffectName, extra?: Record<string, unknown>): Promise<void>;
}

export function packetTimestampPrefix(packetId: string): string {
  const clean = String(packetId || '').replace(/^edit_/, '');
  const parts = clean.split('_');
  if (parts.length >= 2) return `${parts[0]}_${parts[1]}`;
  return clean.slice(0, 15);
}

export function scopedProcessedId(companyId: string, packetId: string): string {
  const prefix = `${companyId}__`;
  if (String(packetId).startsWith(prefix)) return String(packetId);
  return `${prefix}${packetId}`;
}

export function outgoingResponseId(packetId: string, wellName: string, companyId?: string): string {
  const bare = companyId ? String(packetId).replace(new RegExp(`^${companyId}__`), '') : packetId;
  const ts = packetTimestampPrefix(bare);
  const clean = String(wellName || '').replace(/\s+/g, '');
  const co = String(companyId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48);
  return co ? `response_${co}_${ts}_${clean}` : `response_${ts}_${clean}`;
}

void contentDigest;

export function decideWellAssignment(input: {
  driverCompanyId?: string;
  wellCompanyId?: string | null;
  assignedRoutes?: unknown;
  assignedWells?: unknown;
  wellName: string;
  wellRoute?: string | null;
}): { ok: true } | { ok: false; reason: 'well_unscoped' | 'cross_company' | 'well_not_assigned'; detail: string } {
  if (!input.wellCompanyId) return { ok: false, reason: 'well_unscoped', detail: 'well_company' };
  if (!input.driverCompanyId || input.wellCompanyId !== input.driverCompanyId) {
    return { ok: false, reason: 'cross_company', detail: 'well' };
  }
  const wells = Array.isArray(input.assignedWells) ? input.assignedWells.map((w) => String(w).toLowerCase()) : [];
  if (wells.length && !wells.includes(input.wellName.toLowerCase())) {
    return { ok: false, reason: 'well_not_assigned', detail: 'well' };
  }
  const routes = Array.isArray(input.assignedRoutes) ? input.assignedRoutes.map((r) => String(r).toLowerCase()) : [];
  if (routes.length) {
    const route = (input.wellRoute || '').toLowerCase();
    if (!route || !routes.includes(route)) {
      return { ok: false, reason: 'well_not_assigned', detail: 'route' };
    }
  }
  return { ok: true };
}

export function decideCommittedWellDown(input: {
  existingDown: boolean;
  requestedDown: boolean | undefined;
  isManager: boolean;
}): boolean {
  if (typeof input.requestedDown !== 'boolean') return input.existingDown;
  if (input.isManager) return input.requestedDown;
  if (input.requestedDown === true) return true;
  return input.existingDown;
}

export type FieldEffectName =
  | 'processed'
  | 'outgoing'
  | 'wellDown'
  | 'linkedInvoice'
  | 'linkedDispatch'
  | 'linkedTicket'
  | 'commitMarkers';

export type FieldEffectMap = Partial<Record<FieldEffectName, true>>;

export class FieldApplyInterrupt extends Error {
  constructor(
    public readonly after: FieldEffectName,
    public readonly doneEffects: FieldEffectMap,
  ) {
    super(`fail_after_${after}`);
    this.name = 'FieldApplyInterrupt';
  }
}

async function runEffect(
  stores: FieldApplyStores,
  name: FieldEffectName,
  done: FieldEffectMap,
  failAfter: FieldEffectName | `${FieldEffectName}_before_persist` | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  if (done[name]) return;
  await fn();
  if (failAfter === `${name}_before_persist`) {
    throw new FieldApplyInterrupt(name, { ...done });
  }
  if (stores.persistEffect) {
    await stores.persistEffect(name);
  }
  done[name] = true;
  if (failAfter === name) throw new FieldApplyInterrupt(name, { ...done });
}

export async function applyFieldCommandMutation(
  stores: FieldApplyStores,
  input: {
    type: FieldCommandType;
    packetId: string;
    originalPacketId?: string;
    stamped: Record<string, unknown>;
    driver: SecureDriver;
    manager: boolean;
    skipVersionIncrement?: boolean;
    doneEffects?: FieldEffectMap;
    failAfter?: FieldEffectName | `${FieldEffectName}_before_persist`;
  },
): Promise<{
  outgoingId: string | null;
  targetPacketId: string;
  wellDown: boolean;
  doneEffects: FieldEffectMap;
  healed?: boolean;
}> {
  const companyId = input.driver.companyId;
  const done: FieldEffectMap = { ...(input.doneEffects || {}) };
  let orig: Record<string, unknown> | null = null;
  if (input.type !== 'pull') {
    orig = await stores.getProcessed(String(input.originalPacketId || ''));
    if (!orig) throw Object.assign(new Error('not_owner'), { code: 'not_owner' });
    if (orig.companyId !== companyId) {
      throw Object.assign(new Error('cross_company'), { code: 'cross_company' });
    }
    const origWell = String(orig.wellName || '');
    if (input.stamped.wellName && String(input.stamped.wellName) !== origWell) {
      throw Object.assign(new Error('well_mismatch'), { code: 'well_mismatch' });
    }
    input.stamped.wellName = origWell;
    input.stamped.companyId = orig.companyId;
    // Server-owned links. Client invoiceDocId/dispatchId on edit/delete are ignored.
    input.stamped.invoiceDocId = orig.invoiceDocId ?? null;
    input.stamped.dispatchId = orig.dispatchId ?? null;
    input.stamped.ticketId = orig.ticketId ?? orig.ticketDocId ?? null;
    await preflightLinkedResources(stores, orig, companyId, String(input.originalPacketId || ''));
  }

  const wellName = String(input.stamped.wellName || '');
  const config = await stores.getWellConfig(wellName);
  const bblPerFoot = resolveBblPerFoot(config);
  const tanks = Number(config.tanks || config.numTanks || 1) || 1;
  const pullBbls = Number(config.pullBbls || 200) || 200;
  const bottomInches = (Number(config.bottomLevel || config.allowedBottom || 3) || 3) * 12;

  if (input.type === 'delete') {
    const target = String(input.originalPacketId || '');
    await runEffect(stores, 'processed', done, input.failAfter, async () => {
      await stores.updateProcessed(target, {
        deleted: true,
        deletedAt: new Date().toISOString(),
        deletedBy: input.driver.driverId,
      });
    });
    const remaining = (await stores.listProcessedForWell(wellName, companyId))
      .filter((row) => row.id !== target && row.data.deleted !== true && row.data.requestType !== 'delete')
      .sort((a, b) => String(b.data.dateTimeUTC || '').localeCompare(String(a.data.dateTimeUTC || '')));
    let outgoingId: string | null = null;
    let wellDown = false;
    await runEffect(stores, 'outgoing', done, input.failAfter, async () => {
      if (remaining[0]) {
        const latest = remaining[0];
        const built = await buildAndWriteOutgoing(stores, {
          wellName,
          companyId,
          packetId: latest.id,
          tankLevelFeet: Number(latest.data.tankLevelFeet || 0),
          bblsTaken: Number(latest.data.bblsTaken || 0),
          dateTime: latest.data.dateTime,
          dateTimeUTC: String(latest.data.dateTimeUTC || ''),
          wellDown: latest.data.wellDown === true,
          driverId: String(latest.data.driverId || input.driver.driverId),
          driverName: typeof latest.data.driverName === 'string' ? latest.data.driverName : null,
          config,
          bblPerFoot,
          tanks,
          pullBbls,
          bottomInches,
          isEdit: false,
        });
        outgoingId = built.outgoingId;
        wellDown = built.wellDown;
      } else {
        outgoingId = outgoingResponseId(target, wellName, companyId);
        await stores.replaceOutgoingForWell(wellName, companyId, outgoingId, {
          wellName,
          companyId,
          status: 'success',
          wellDown: false,
          processedBy: 'submitFieldCommand',
          timestamp: new Date().toISOString(),
        });
      }
    });
    await applyLinkedDocumentEffects(stores, {
      orig,
      companyId,
      targetId: target,
      processed: { deleted: true, lastPullPacketId: target },
      done,
      failAfter: input.failAfter,
      mode: 'delete',
    });
    if (!input.skipVersionIncrement) await stores.incrementIncomingVersion();
    return { outgoingId, targetPacketId: target, wellDown, doneEffects: done };
  }

  const targetId = input.type === 'edit' ? String(input.originalPacketId || '') : input.packetId;
  const existingDown = await stores.getWellDown(wellName);
  const nextDown = decideCommittedWellDown({
    existingDown,
    requestedDown: typeof input.stamped.wellDown === 'boolean' ? input.stamped.wellDown : undefined,
    isManager: input.manager,
  });
  if (typeof input.stamped.wellDown === 'boolean' && nextDown !== existingDown) {
    await runEffect(stores, 'wellDown', done, input.failAfter, async () => {
      await stores.setWellDown(wellName, nextDown);
    });
  }

  const levels = computeTankLevels({
    tankLevelFeet: Number(input.stamped.tankLevelFeet || 0),
    bblsTaken: Number(input.stamped.bblsTaken || 0),
    bblPerFoot,
  });
  const processed: Record<string, unknown> = {
    ...input.stamped,
    wellDown: nextDown,
    tankTopInches: levels.tankTopInches,
    tankAfterInches: levels.tankAfterInches,
    tankAfterFeet: inchesToFeetInches(levels.tankAfterInches),
    processedAt: new Date().toISOString(),
    processedBy: 'submitFieldCommand',
    companyId,
    driverId: input.driver.driverId,
    driverName: input.driver.displayName || null,
  };

  let healed = false;
  if (input.type === 'pull') {
    const already = await stores.getProcessed(input.packetId);
    if (already) {
      if (already.companyId !== companyId) {
        throw Object.assign(new Error('packet_collision'), { code: 'packet_collision' });
      }
      done.processed = true;
      healed = true;
    } else {
      await runEffect(stores, 'processed', done, input.failAfter, async () => {
        await stores.createProcessedOnly(input.packetId, processed);
      });
    }
  } else {
    await runEffect(stores, 'processed', done, input.failAfter, async () => {
      // Preserve the original semantic type. Never publish requestType:'edit'
      // or any badge/confirmation marker before the receipt is committed.
      await stores.updateProcessed(targetId, {
        ...processed,
        requestType: 'pull',
        invoiceDocId: orig?.invoiceDocId ?? null,
        dispatchId: orig?.dispatchId ?? null,
        ticketId: orig?.ticketId ?? orig?.ticketDocId ?? null,
      });
    });
    await applyLinkedDocumentEffects(stores, {
      orig,
      companyId,
      targetId,
      processed,
      done,
      failAfter: input.failAfter,
      mode: 'edit',
    });
  }

  let outgoingId: string | null = outgoingResponseId(targetId, wellName, companyId);
  await runEffect(stores, 'outgoing', done, input.failAfter, async () => {
    const built = await buildAndWriteOutgoing(stores, {
      wellName,
      companyId,
      packetId: targetId,
      tankLevelFeet: Number(input.stamped.tankLevelFeet || 0),
      bblsTaken: Number(input.stamped.bblsTaken || 0),
      dateTime: input.stamped.dateTime,
      dateTimeUTC: String(input.stamped.dateTimeUTC || ''),
      wellDown: nextDown,
      driverId: input.driver.driverId,
      driverName: input.driver.displayName || null,
      config,
      bblPerFoot,
      tanks,
      pullBbls,
      bottomInches,
      isEdit: false,
    });
    outgoingId = built.outgoingId;
  });
  if (!input.skipVersionIncrement) await stores.incrementIncomingVersion();
  return { outgoingId, targetPacketId: targetId, wellDown: nextDown, doneEffects: done, healed };
}

/**
 * Server-owned committed edit marker. Called only after the receipt
 * status is `committed`. WB-M may confirm a new secure edit from this
 * marker, the callable committed response, or getFieldCommandStatus.
 */
export const REQUIRED_OUTGOING_FIELDS = [
  'wellName',
  'companyId',
  'currentLevel',
  'status',
  'lastPullPacketId',
  'lastPullDateTimeUTC',
  'lastPullBbls',
  'processedBy',
] as const;

export function outgoingHasRequiredSchema(doc: Record<string, unknown> | null | undefined): boolean {
  if (!doc) return false;
  return REQUIRED_OUTGOING_FIELDS.every((k) => doc[k] != null && doc[k] !== '');
}

export function reconstructOutgoingFromProcessed(
  processed: Record<string, unknown> | null,
  input: { fenceGeneration: number; receiptKey: string; outgoingId: string },
): Record<string, unknown> | null {
  if (!processed) return null;
  const wellName = typeof processed.wellName === 'string' ? processed.wellName : '';
  const companyId = typeof processed.companyId === 'string' ? processed.companyId : '';
  const lastPullPacketId = typeof processed.packetId === 'string'
    ? processed.packetId
    : typeof processed.lastPullPacketId === 'string' ? processed.lastPullPacketId : '';
  const lastPullDateTimeUTC = typeof processed.dateTimeUTC === 'string' ? processed.dateTimeUTC : '';
  const lastPullBbls = processed.bblsTaken != null ? String(processed.bblsTaken) : '';
  const currentLevel = processed.currentLevel != null
    ? processed.currentLevel
    : processed.tankLevelFeet != null ? processed.tankLevelFeet : '';
  if (!wellName || !companyId || !lastPullPacketId || !lastPullDateTimeUTC) return null;
  const now = new Date().toISOString();
  return {
    wellName,
    companyId,
    currentLevel,
    status: 'success',
    timestamp: now,
    timestampUTC: now,
    lastPullDateTime: processed.dateTime || lastPullDateTimeUTC,
    lastPullDateTimeUTC,
    lastPullBbls,
    lastPullTopLevel: processed.lastPullTopLevel ?? processed.tankLevelFeet ?? currentLevel,
    lastPullBottomLevel: processed.lastPullBottomLevel ?? currentLevel,
    lastPullDriverId: processed.driverId || null,
    lastPullDriverName: processed.driverName || null,
    lastPullPacketId,
    wellDown: processed.wellDown === true,
    processedBy: 'submitFieldCommand',
    isEdit: true,
    editCommitted: true,
    editCommittedGeneration: input.fenceGeneration,
    editCommittedReceiptKey: input.receiptKey,
    outgoingId: input.outgoingId,
  };
}

export async function publishCommittedEditMarkers(
  stores: FieldApplyStores,
  input: {
    targetId: string;
    receiptKey: string;
    fenceGeneration: number;
    driverId: string;
    outgoingId?: string | null;
  },
): Promise<{ complete: boolean; reason?: string }> {
  const existing = await stores.getProcessed(input.targetId);
  const outgoingRequired = !!input.outgoingId;
  let outgoing: Record<string, unknown> | null = null;
  if (input.outgoingId) {
    if (stores.getOutgoing) outgoing = await stores.getOutgoing(input.outgoingId);
    else if (stores.outgoingExists) {
      outgoing = (await stores.outgoingExists(input.outgoingId)) ? { present: true } : null;
    }
  }
  const dec = decideAtomicMarkerWrite({
    processedGeneration: existing?.editCommittedGeneration,
    outgoingGeneration: outgoing?.editCommittedGeneration,
    incomingGeneration: input.fenceGeneration,
    outgoingRequired,
    outgoingPresent: !!outgoing,
  });
  if (dec === 'stale') return { complete: false, reason: 'stale' };

  const now = new Date().toISOString();
  const processedPatch = {
    editCommitted: true,
    editCommittedReceiptKey: input.receiptKey,
    editCommittedGeneration: input.fenceGeneration,
    editCommittedAt: now,
    wasEdited: true,
    isEdit: true,
    editedAt: now,
    editedBy: input.driverId,
    outgoingMarkerGeneration: outgoingRequired ? input.fenceGeneration : existing?.outgoingMarkerGeneration ?? null,
  };

  if (dec === 'write') {
    const applyProcessed = (curr: Record<string, unknown> | null) => {
      const g = generationNumber(curr?.editCommittedGeneration);
      if (input.fenceGeneration < g) return undefined;
      return { ...(curr || {}), ...processedPatch };
    };
    if (stores.transactProcessed) {
      const tx = await stores.transactProcessed(input.targetId, applyProcessed);
      if (!tx.committed) return { complete: false, reason: 'stale' };
    } else {
      const latest = await stores.getProcessed(input.targetId);
      const g = generationNumber(latest?.editCommittedGeneration);
      if (input.fenceGeneration < g) return { complete: false, reason: 'stale' };
      await stores.updateProcessed(input.targetId, processedPatch);
    }
  }

  if (outgoingRequired && input.outgoingId && (dec === 'write' || dec === 'heal_outgoing')) {
    const applyOutgoing = (curr: Record<string, unknown> | null) => {
      const g = generationNumber(curr?.editCommittedGeneration);
      if (input.fenceGeneration < g) return undefined;
      if (outgoingHasRequiredSchema(curr)) {
        return {
          ...curr,
          isEdit: true,
          editCommitted: true,
          editCommittedGeneration: input.fenceGeneration,
          editCommittedReceiptKey: input.receiptKey,
        };
      }
      const rebuilt = reconstructOutgoingFromProcessed(existing, {
        fenceGeneration: input.fenceGeneration,
        receiptKey: input.receiptKey,
        outgoingId: input.outgoingId!,
      });
      if (!rebuilt || !outgoingHasRequiredSchema(rebuilt)) return undefined;
      return { ...(curr || {}), ...rebuilt };
    };
    if (stores.transactOutgoing) {
      const tx = await stores.transactOutgoing(input.outgoingId, applyOutgoing);
      if (!tx.committed) return { complete: false, reason: 'outgoing_incomplete' };
    } else if (stores.patchOutgoing) {
      const latestOut = stores.getOutgoing ? await stores.getOutgoing(input.outgoingId) : null;
      if (generationNumber(latestOut?.editCommittedGeneration) > input.fenceGeneration) {
        return { complete: false, reason: 'outgoing_stale_or_missing' };
      }
      const next = applyOutgoing(latestOut);
      if (!next) return { complete: false, reason: 'outgoing_incomplete' };
      await stores.patchOutgoing(input.outgoingId, next);
    } else {
      return { complete: false, reason: 'outgoing_unavailable' };
    }
  }

  const afterProcessed = await stores.getProcessed(input.targetId);
  if (generationNumber(afterProcessed?.editCommittedGeneration) !== input.fenceGeneration) {
    return { complete: false, reason: 'processed_generation_mismatch' };
  }
  if (outgoingRequired && input.outgoingId) {
    const afterOut = stores.getOutgoing
      ? await stores.getOutgoing(input.outgoingId)
      : null;
    if (
      !afterOut
      || generationNumber(afterOut.editCommittedGeneration) !== input.fenceGeneration
      || !outgoingHasRequiredSchema(afterOut)
    ) {
      return { complete: false, reason: 'outgoing_incomplete' };
    }
  }
  if (dec === 'skip') return { complete: true, reason: 'idempotent' };
  return { complete: true };
}

export async function preflightLinkedResources(
  stores: FieldApplyStores,
  orig: Record<string, unknown>,
  companyId: string,
  targetId: string,
): Promise<void> {
  const invoiceId = orig.invoiceDocId ? String(orig.invoiceDocId) : '';
  const dispatchId = orig.dispatchId ? String(orig.dispatchId) : '';
  const ticketId = orig.ticketId ? String(orig.ticketId) : orig.ticketDocId ? String(orig.ticketDocId) : '';
  if (invoiceId) {
    if (!stores.getLinkedInvoice) throw Object.assign(new Error('linked_unavailable'), { code: 'linked_unavailable' });
    const inv = await stores.getLinkedInvoice(invoiceId);
    if (!inv) throw Object.assign(new Error('linked_missing'), { code: 'linked_missing' });
    if (inv.companyId !== companyId) throw Object.assign(new Error('linked_mismatch'), { code: 'linked_mismatch' });
    if (inv.lastPullPacketId && inv.lastPullPacketId !== targetId && inv.packetId !== targetId) {
      throw Object.assign(new Error('linked_mismatch'), { code: 'linked_mismatch' });
    }
  }
  if (dispatchId) {
    if (!stores.getLinkedDispatch) throw Object.assign(new Error('linked_unavailable'), { code: 'linked_unavailable' });
    const d = await stores.getLinkedDispatch(dispatchId);
    if (!d) throw Object.assign(new Error('linked_missing'), { code: 'linked_missing' });
    if (d.companyId !== companyId) throw Object.assign(new Error('linked_mismatch'), { code: 'linked_mismatch' });
  }
  if (ticketId) {
    if (!stores.getLinkedTicket) throw Object.assign(new Error('linked_unavailable'), { code: 'linked_unavailable' });
    const t = await stores.getLinkedTicket(ticketId);
    if (!t) throw Object.assign(new Error('linked_missing'), { code: 'linked_missing' });
    if (t.companyId !== companyId) throw Object.assign(new Error('linked_mismatch'), { code: 'linked_mismatch' });
  }
}

async function applyLinkedDocumentEffects(
  stores: FieldApplyStores,
  input: {
    orig: Record<string, unknown> | null;
    companyId: string;
    targetId: string;
    processed: Record<string, unknown>;
    done: FieldEffectMap;
    failAfter?: FieldEffectName | `${FieldEffectName}_before_persist`;
    mode: 'edit' | 'delete';
  },
): Promise<void> {
  const invoiceId = input.orig?.invoiceDocId ? String(input.orig.invoiceDocId) : '';
  const dispatchId = input.orig?.dispatchId ? String(input.orig.dispatchId) : '';
  const ticketId = input.orig?.ticketId
    ? String(input.orig.ticketId)
    : input.orig?.ticketDocId
      ? String(input.orig.ticketDocId)
      : '';
  const patch =
    input.mode === 'delete'
      ? { lastPullDeleted: true, lastPullPacketId: input.targetId, companyId: input.companyId }
      : {
          tankLevelFeet: input.processed.tankLevelFeet,
          bblsTaken: input.processed.bblsTaken,
          dateTimeUTC: input.processed.dateTimeUTC,
          lastPullPacketId: input.targetId,
          companyId: input.companyId,
        };
  if (invoiceId) {
    if (!stores.getLinkedInvoice || !stores.updateLinkedInvoice) {
      throw Object.assign(new Error('linked_unavailable'), { code: 'linked_unavailable' });
    }
    await runEffect(stores, 'linkedInvoice', input.done, input.failAfter, async () => {
      const inv = await stores.getLinkedInvoice!(invoiceId);
      if (!inv) throw Object.assign(new Error('linked_missing'), { code: 'linked_missing' });
      if (inv.companyId !== input.companyId) {
        throw Object.assign(new Error('linked_mismatch'), { code: 'linked_mismatch' });
      }
      const associated =
        inv.lastPullPacketId === input.targetId ||
        inv.packetId === input.targetId ||
        inv.invoiceDocId === invoiceId;
      if (!associated && inv.lastPullPacketId && inv.lastPullPacketId !== input.targetId) {
        throw Object.assign(new Error('linked_mismatch'), { code: 'linked_mismatch' });
      }
      await stores.updateLinkedInvoice!(invoiceId, patch);
    });
  }
  if (dispatchId) {
    if (!stores.getLinkedDispatch || !stores.updateLinkedDispatch) {
      throw Object.assign(new Error('linked_unavailable'), { code: 'linked_unavailable' });
    }
    await runEffect(stores, 'linkedDispatch', input.done, input.failAfter, async () => {
      const d = await stores.getLinkedDispatch!(dispatchId);
      if (!d) throw Object.assign(new Error('linked_missing'), { code: 'linked_missing' });
      if (d.companyId !== input.companyId) {
        throw Object.assign(new Error('linked_mismatch'), { code: 'linked_mismatch' });
      }
      await stores.updateLinkedDispatch!(dispatchId, patch);
    });
  }
  if (ticketId) {
    if (!stores.getLinkedTicket || !stores.updateLinkedTicket) {
      throw Object.assign(new Error('linked_unavailable'), { code: 'linked_unavailable' });
    }
    await runEffect(stores, 'linkedTicket', input.done, input.failAfter, async () => {
      const t = await stores.getLinkedTicket!(ticketId);
      if (!t) throw Object.assign(new Error('linked_missing'), { code: 'linked_missing' });
      if (t.companyId !== input.companyId) {
        throw Object.assign(new Error('linked_mismatch'), { code: 'linked_mismatch' });
      }
      await stores.updateLinkedTicket!(ticketId, patch);
    });
  }
}

async function buildAndWriteOutgoing(
  stores: FieldApplyStores,
  input: {
    wellName: string;
    companyId: string;
    packetId: string;
    tankLevelFeet: number;
    bblsTaken: number;
    dateTime: unknown;
    dateTimeUTC: string;
    wellDown: boolean;
    driverId: string;
    driverName: string | null;
    config: Record<string, unknown>;
    bblPerFoot: number;
    tanks: number;
    pullBbls: number;
    bottomInches: number;
    isEdit: boolean;
  },
): Promise<{ outgoingId: string; wellDown: boolean }> {
  const historyRows = await stores.listProcessedForWell(input.wellName, input.companyId);
  const historical: HistoricalPull[] = historyRows
    .filter((r) => r.data.deleted !== true && r.data.requestType !== 'delete')
    .map((r) => ({
      key: r.id,
      timestamp: new Date(String(r.data.dateTimeUTC || 0)).getTime() || 0,
      tankLevelFeet: Number(r.data.tankLevelFeet || 0),
      bblsTaken: Number(r.data.bblsTaken || 0),
      wellDown: r.data.wellDown === true,
    }))
    .filter((r) => r.timestamp > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
  const pullTs = new Date(input.dateTimeUTC).getTime() || Date.now();
  const afr = afrDaysFromHistory(historical, input.bblPerFoot, pullTs);
  const levels = computeTankLevels({
    tankLevelFeet: input.tankLevelFeet,
    bblsTaken: input.bblsTaken,
    bblPerFoot: input.bblPerFoot,
  });
  const est = estimatePull({
    tankAfterInches: levels.tankAfterInches,
    bottomInches: input.bottomInches,
    pullBbls: input.pullBbls,
    tanks: input.tanks,
    afrDays: afr,
    dateTimeUTC: input.dateTimeUTC,
    wellDown: input.wellDown,
    bblPerFoot: input.bblPerFoot,
  });
  const now = new Date().toISOString();
  const outgoingId = outgoingResponseId(input.packetId, input.wellName, input.companyId);
  await stores.replaceOutgoingForWell(input.wellName, input.companyId, outgoingId, {
    wellName: input.wellName,
    companyId: input.companyId,
    currentLevel: inchesToFeetInches(levels.tankAfterInches),
    timeTillPull: est.timeTillPull,
    nextPullTime: est.nextPullTimeUTC,
    nextPullTimeUTC: est.nextPullTimeUTC,
    flowRate: est.flowRate,
    bbls24hrs: est.bbls24hrs,
    status: 'success',
    timestamp: now,
    timestampUTC: now,
    lastPullDateTime: input.dateTime || null,
    lastPullDateTimeUTC: input.dateTimeUTC,
    lastPullBbls: String(input.bblsTaken ?? ''),
    lastPullTopLevel: inchesToFeetInches(levels.tankTopInches),
    lastPullBottomLevel: inchesToFeetInches(levels.tankAfterInches),
    lastPullDriverId: input.driverId,
    lastPullDriverName: input.driverName,
    lastPullPacketId: input.packetId,
    wellDown: input.wellDown,
    processedBy: 'submitFieldCommand',
    isEdit: input.isEdit,
  });
  return { outgoingId, wellDown: input.wellDown };
}
