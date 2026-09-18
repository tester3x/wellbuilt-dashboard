/**
 * Authoritative, server-governed split mutations.
 *
 * Implements:
 *   - addSplitLeg
 *   - removeSplitLeg
 *   - resequenceSplitFamily
 *
 * Requirements:
 *   - Server-side actor resolution (drivers and staff). All client-provided
 *     driver hashes, company IDs, and roles are treated as untrusted.
 *   - Strict tenant isolation: all queries and mutations are scoped by
 *     companyId + splitGroupId. Cross-company access and mixed-company families
 *     are rejected.
 *   - Single -> Split auto-minting preserved for non-terminal single parents.
 *   - Anchor origin (pickupWellName) and disposal destinationType preserved.
 *   - BBL volume conservation with audit fields.
 *   - Contiguous splitSequence rewrite preserving anchor and started legs.
 *   - Invoices mirrored with new splitSequence and splitTotal.
 *   - Forward-compatible capability enforcement seam (SplitCapabilityAuthorizer).
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireRegisteredDashboardUser } from '../adminAuth';
import { writeSecurityAudit } from '../audit';

// ── Status Sets ─────────────────────────────────────────────────────────────
export const SPLIT_TERMINAL_STATUSES = new Set([
  'completed',
  'cancelled',
  'canceled',
  'declined',
  'dismissed',
]);

export const SPLIT_STARTED_STATUSES = new Set([
  'accepted',
  'in_progress',
  'paused',
]);

export const numSeq = (v: unknown): number =>
  typeof v === 'number' && isFinite(v) ? v : Number.POSITIVE_INFINITY;

// ── Actor Types ─────────────────────────────────────────────────────────────
export type SplitActor =
  | {
      kind: 'driver';
      uid: string;
      driverId: string;
      driverHash?: string;
      companyId: string;
      displayName?: string;
    }
  | {
      kind: 'staff';
      uid: string;
      companyId?: string;
      isPlatformAdmin: boolean;
      roles: string[];
      caps: string[];
    };

// ── Capability Enforcement Seam ─────────────────────────────────────────────
export interface CapabilityEnforcementContext {
  operation: 'add' | 'remove' | 'resequence';
  dispatch?: Record<string, unknown>;
  splitGroupId?: string;
  actor: SplitActor;
}

export interface SplitCapabilityAuthorizer {
  authorizeSplitOperation(
    context: CapabilityEnforcementContext,
  ): Promise<{ allowed: boolean; reason?: string }>;
}

export const defaultSplitCapabilityAuthorizer: SplitCapabilityAuthorizer = {
  async authorizeSplitOperation(_context) {
    return { allowed: true };
  },
};

// ── Server-side Actor Resolution ────────────────────────────────────────────
export type SplitActorReaders = {
  getDriverProfile?: (
    driverId: string,
  ) => Promise<{
    exists: boolean;
    active?: boolean;
    companyId?: string | null;
    legacyDriverHash?: string | null;
    displayName?: string | null;
  }>;
  getDashboardUser?: (
    uid: string,
    token?: Record<string, unknown> | null,
  ) => Promise<{
    uid: string;
    roles: string[];
    companyId?: string;
    caps: string[];
    isPlatformAdmin: boolean;
  }>;
};

export async function resolveSplitActor(
  request: httpsV2.CallableRequest<unknown>,
  untrustedCallerDriverHash?: string | null,
  readers?: SplitActorReaders,
): Promise<SplitActor> {
  const uid = request.auth?.uid;
  if (!uid || typeof uid !== 'string') {
    throw new httpsV2.HttpsError('unauthenticated', 'Authentication required');
  }

  const token = request.auth?.token as Record<string, unknown> | undefined;

  const readProfile = async (id: string) => {
    if (readers?.getDriverProfile) {
      return readers.getDriverProfile(id);
    }
    const snap = await admin.database().ref(`drivers/profiles/${id}`).once('value');
    if (!snap.exists()) {
      return { exists: false };
    }
    const val = (snap.val() || {}) as Record<string, unknown>;
    return {
      exists: true,
      active: val.active !== false,
      companyId: typeof val.companyId === 'string' ? val.companyId : null,
      legacyDriverHash: typeof val.legacyDriverHash === 'string' ? val.legacyDriverHash : null,
      displayName: typeof val.displayName === 'string' ? val.displayName : null,
    };
  };

  // 1. Authenticated driver via custom claims
  if (token?.kind === 'driver' && typeof token.driverId === 'string' && token.driverId) {
    const driverId = String(token.driverId).trim();
    const prof = await readProfile(driverId);
    if (prof.exists && prof.active === false) {
      throw new httpsV2.HttpsError('permission-denied', 'Driver deactivated');
    }
    const tokenCompany = typeof token.companyId === 'string' ? token.companyId.trim() : '';
    const profCompany = typeof prof.companyId === 'string' ? prof.companyId.trim() : '';
    const companyId = tokenCompany || profCompany;
    if (!companyId) {
      throw new httpsV2.HttpsError('permission-denied', 'Driver has no assigned company');
    }

    const untrusted = untrustedCallerDriverHash?.trim();
    if (untrusted) {
      const legacyHash = typeof prof.legacyDriverHash === 'string' ? prof.legacyDriverHash.trim() : '';
      if (untrusted !== driverId && (!legacyHash || untrusted !== legacyHash)) {
        throw new httpsV2.HttpsError(
          'permission-denied',
          'Spoofed driver hash: does not match authenticated driver',
        );
      }
    }

    return {
      kind: 'driver',
      uid,
      driverId,
      driverHash: untrusted || driverId,
      companyId,
      displayName: typeof prof.displayName === 'string' ? prof.displayName : undefined,
    };
  }

  // 2. Direct driver profile lookup by uid
  const driverDirectProf = await readProfile(uid);
  if (driverDirectProf.exists) {
    if (driverDirectProf.active === false) {
      throw new httpsV2.HttpsError('permission-denied', 'Driver deactivated');
    }
    const companyId = typeof driverDirectProf.companyId === 'string' ? driverDirectProf.companyId.trim() : '';
    if (!companyId) {
      throw new httpsV2.HttpsError('permission-denied', 'Driver has no assigned company');
    }
    const untrusted = untrustedCallerDriverHash?.trim();
    const legacyHash = typeof driverDirectProf.legacyDriverHash === 'string' ? driverDirectProf.legacyDriverHash.trim() : '';
    if (untrusted && untrusted !== uid && (!legacyHash || untrusted !== legacyHash)) {
      throw new httpsV2.HttpsError(
        'permission-denied',
        'Spoofed driver hash: does not match authenticated driver',
      );
    }
    return {
      kind: 'driver',
      uid,
      driverId: uid,
      driverHash: untrusted || uid,
      companyId,
      displayName: typeof driverDirectProf.displayName === 'string' ? driverDirectProf.displayName : undefined,
    };
  }

  // 3. Dashboard staff user
  try {
    const staffCaller = readers?.getDashboardUser
      ? await readers.getDashboardUser(uid, token)
      : await requireRegisteredDashboardUser(uid, token);
    const isStaffRole = staffCaller.roles.some((r: string) =>
      ['admin', 'it', 'manager', 'dispatch'].includes(r),
    );
    const hasManageDrivers = staffCaller.caps.includes('manageDrivers');
    if (!isStaffRole && !hasManageDrivers && !staffCaller.isPlatformAdmin) {
      throw new httpsV2.HttpsError('permission-denied', 'Caller lacks required staff permissions');
    }
    return {
      kind: 'staff',
      uid,
      companyId: staffCaller.companyId,
      isPlatformAdmin: staffCaller.isPlatformAdmin,
      roles: staffCaller.roles,
      caps: staffCaller.caps,
    };
  } catch (err: any) {
    if (err instanceof httpsV2.HttpsError) throw err;
    throw new httpsV2.HttpsError('permission-denied', 'Caller is not authorized');
  }
}

// ── Pure Decision Evaluators ────────────────────────────────────────────────

export type EvaluateAddSplitLegInput = {
  actor: SplitActor;
  parent: Record<string, unknown> | null;
  parentDispatchId: string;
  siblings: Array<{ id: string; [key: string]: unknown }>;
  legSpec: {
    disposal?: unknown;
    disposalLat?: unknown;
    disposalLng?: unknown;
    bbls?: unknown;
    jobType?: unknown;
    serviceType?: unknown;
    notes?: unknown;
    destinationType?: unknown;
  };
  nowMillis?: number;
  idempotencyKey?: string;
};

export type EvaluateAddSplitLegResult =
  | {
      ok: true;
      splitGroupId: string;
      isFirstSplit: boolean;
      nextSequence: number;
      newTotal: number;
      rootParentId: string;
      anchorWellName: string | null;
      parentBblsBefore: number;
      parentBblsAfter: number | null;
      reduceBy: number;
      newDispatchFields: Record<string, unknown>;
      parentUpdateFields: Record<string, unknown>;
      siblingUpdateFields: Record<string, unknown>;
    }
  | {
      ok: false;
      code: 'not-found' | 'permission-denied' | 'failed-precondition' | 'invalid-argument';
      reason: string;
    };

export function evaluateAddSplitLeg(input: EvaluateAddSplitLegInput): EvaluateAddSplitLegResult {
  const { actor, parent, parentDispatchId, siblings, legSpec } = input;

  if (!parentDispatchId || typeof parentDispatchId !== 'string') {
    return { ok: false, code: 'invalid-argument', reason: 'parentDispatchId is required' };
  }
  if (!parent) {
    return { ok: false, code: 'not-found', reason: `Parent dispatch ${parentDispatchId} not found` };
  }

  const disposal = typeof legSpec.disposal === 'string' ? legSpec.disposal.trim() : '';
  if (!disposal) {
    return { ok: false, code: 'invalid-argument', reason: 'legSpec.disposal is required' };
  }

  const parentCompanyId = typeof parent.companyId === 'string' ? parent.companyId.trim() : '';
  if (!parentCompanyId) {
    return { ok: false, code: 'failed-precondition', reason: 'Parent dispatch has no companyId' };
  }

  // Tenant scoping & actor authorization
  if (actor.kind === 'driver') {
    if (actor.companyId !== parentCompanyId) {
      return { ok: false, code: 'permission-denied', reason: 'Cross-company access denied' };
    }
    const isOwner =
      parent.driverId === actor.driverId ||
      parent.driverHash === actor.driverId ||
      (actor.driverHash && parent.driverHash === actor.driverHash) ||
      parent.assignedDriverId === actor.driverId;
    if (!isOwner && parent.driverId) {
      return { ok: false, code: 'permission-denied', reason: 'Caller is not assigned to this dispatch' };
    }
  } else {
    if (!actor.isPlatformAdmin && actor.companyId !== parentCompanyId) {
      return { ok: false, code: 'permission-denied', reason: 'Cross-company access denied' };
    }
  }

  // Terminal parent guard on first split
  const isFirstSplit = !parent.splitGroupId;
  const parentStatus = String(parent.status || '');
  if (isFirstSplit && SPLIT_TERMINAL_STATUSES.has(parentStatus)) {
    return { ok: false, code: 'failed-precondition', reason: `Cannot split a ${parentStatus} job.` };
  }

  const splitGroupId =
    (typeof parent.splitGroupId === 'string' && parent.splitGroupId.trim())
      ? parent.splitGroupId.trim()
      : `split_${input.nowMillis || Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  let maxSequence = 0;
  let leg1DispatchId: string | null = null;
  let anchorWellName: string | null = null;
  let siblingCount = 0;

  if (isFirstSplit) {
    maxSequence = 1;
    leg1DispatchId = parentDispatchId;
    anchorWellName = typeof parent.wellName === 'string' ? parent.wellName : null;
    siblingCount = 1;
  } else {
    if (siblings.length === 0) {
      return {
        ok: false,
        code: 'failed-precondition',
        reason: `Could not enumerate siblings for splitGroupId=${splitGroupId}`,
      };
    }
    for (const sib of siblings) {
      const sibCompany = typeof sib.companyId === 'string' ? sib.companyId.trim() : '';
      if (!sibCompany || sibCompany !== parentCompanyId) {
        return {
          ok: false,
          code: 'failed-precondition',
          reason: 'Split family contains mixed company members',
        };
      }
      const seq = numSeq(sib.splitSequence);
      if (isFinite(seq) && seq > maxSequence) maxSequence = seq;
      if (seq === 1) {
        leg1DispatchId = sib.id;
        anchorWellName = typeof sib.wellName === 'string' ? sib.wellName : null;
      }
    }
    siblingCount = siblings.length;
  }

  if (!anchorWellName && typeof parent.wellName === 'string') {
    anchorWellName = parent.wellName;
  }

  const destinationType =
    typeof legSpec.destinationType === 'string' && legSpec.destinationType.trim()
      ? legSpec.destinationType.trim()
      : null;
  const nextSequence = maxSequence + 1;
  const newTotal = siblingCount + 1;
  const rootParentId = leg1DispatchId || parentDispatchId;

  // BBL volume conservation
  const parentBblsCurrent =
    typeof parent.bbls === 'number' && isFinite(parent.bbls) ? parent.bbls : 0;
  const reduceBy =
    typeof legSpec.bbls === 'number' && isFinite(legSpec.bbls) && legSpec.bbls > 0
      ? legSpec.bbls
      : 0;
  let parentBblsAfter: number | null = null;
  const parentUpdateFields: Record<string, unknown> = {
    splitTotal: newTotal,
  };
  if (isFirstSplit) {
    parentUpdateFields.splitGroupId = splitGroupId;
    parentUpdateFields.splitSequence = 1;
  }
  if (reduceBy > 0 && parentBblsCurrent > 0) {
    parentBblsAfter = Math.max(0, parentBblsCurrent - reduceBy);
    const existingOriginal =
      typeof parent.originalBblsBeforeSplitAdjust === 'number'
        ? parent.originalBblsBeforeSplitAdjust
        : parentBblsCurrent;
    const existingAdjustedBy = Array.isArray(parent.splitAdjustedByLegId)
      ? parent.splitAdjustedByLegId
      : [];
    const existingAdjustedAt = Array.isArray(parent.splitAdjustedAt)
      ? parent.splitAdjustedAt
      : [];
    const existingAdjustedAmount = Array.isArray(parent.splitAdjustedAmount)
      ? parent.splitAdjustedAmount
      : [];
    parentUpdateFields.bbls = parentBblsAfter;
    parentUpdateFields.originalBblsBeforeSplitAdjust = existingOriginal;
    parentUpdateFields._splitAdjustReduction = {
      reduceBy,
      existingAdjustedBy,
      existingAdjustedAt,
      existingAdjustedAmount,
    };
  }

  const newDispatchFields: Record<string, unknown> = {
    driverId: parent.driverId || (actor.kind === 'driver' ? actor.driverId : null),
    driverHash: parent.driverHash || (actor.kind === 'driver' ? (actor.driverHash || actor.driverId) : null),
    driverName: parent.driverName || null,
    driverFirstName: parent.driverFirstName || null,
    wellName: disposal,
    ndicWellName: disposal,
    operator: parent.operator || null,
    packageId: parent.packageId || null,
    companyId: parentCompanyId,
    priority: parent.priority || 5,
    onsiteBy: parent.onsiteBy || null,
    disposal,
    ...(typeof legSpec.disposalLat === 'number' ? { disposalLat: legSpec.disposalLat } : {}),
    ...(typeof legSpec.disposalLng === 'number' ? { disposalLng: legSpec.disposalLng } : {}),
    ...(anchorWellName ? { pickupWellName: anchorWellName } : {}),
    ...(destinationType ? { destinationType } : {}),
    ...(destinationType === 'SWD' ? { legType: 'disposal' } : {}),
    ...(reduceBy > 0 ? { bbls: reduceBy } : typeof legSpec.bbls === 'number' ? { bbls: legSpec.bbls } : {}),
    jobType: legSpec.jobType || parent.jobType || null,
    serviceType: legSpec.serviceType || parent.serviceType || null,
    notes:
      legSpec.notes ||
      `Split ticket ${String.fromCharCode(65 + nextSequence - 1)} (field-added)`,
    splitGroupId,
    splitSequence: nextSequence,
    splitTotal: newTotal,
    ...(parent.splitFamilyColor ? { splitFamilyColor: parent.splitFamilyColor } : {}),
    parentDispatchId: rootParentId,
    splitOriginatedAt: actor.kind === 'driver' ? 'field' : 'dashboard',
    splitOriginatedBy: actor.kind === 'driver' ? actor.driverId : actor.uid,
    status: 'pending',
    assignedBy: actor.kind === 'driver' ? `driver:${actor.driverId}` : actor.uid,
    loadCount: 1,
    loadsCompleted: 0,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  };

  return {
    ok: true,
    splitGroupId,
    isFirstSplit,
    nextSequence,
    newTotal,
    rootParentId,
    anchorWellName,
    parentBblsBefore: parentBblsCurrent,
    parentBblsAfter: parentBblsAfter ?? parentBblsCurrent,
    reduceBy,
    newDispatchFields,
    parentUpdateFields,
    siblingUpdateFields: { splitTotal: newTotal },
  };
}

export type EvaluateRemoveSplitLegInput = {
  actor: SplitActor;
  legDispatchId: string;
  leg: Record<string, unknown> | null;
  family: Array<{ id: string; [key: string]: unknown }>;
  reason?: string;
};

export type EvaluateRemoveSplitLegResult =
  | {
      ok: true;
      idempotent?: boolean;
      splitGroupId: string;
      removedId: string;
      newTotal: number;
      base: number;
      order: Array<{ id: string; splitSequence: number }>;
      updates: Array<{ id: string; splitSequence: number; splitTotal: number }>;
      cancelFields: Record<string, unknown>;
    }
  | {
      ok: false;
      code: 'not-found' | 'permission-denied' | 'failed-precondition' | 'invalid-argument';
      reason: string;
    };

export function evaluateRemoveSplitLeg(input: EvaluateRemoveSplitLegInput): EvaluateRemoveSplitLegResult {
  const { actor, legDispatchId, leg, family, reason } = input;

  if (!legDispatchId || typeof legDispatchId !== 'string') {
    return { ok: false, code: 'invalid-argument', reason: 'legDispatchId is required' };
  }
  if (!leg) {
    return { ok: false, code: 'not-found', reason: `Dispatch ${legDispatchId} not found` };
  }

  const splitGroupId = typeof leg.splitGroupId === 'string' ? leg.splitGroupId.trim() : '';
  if (!splitGroupId) {
    return { ok: false, code: 'failed-precondition', reason: 'Dispatch is not part of a split family' };
  }

  const legCompanyId = typeof leg.companyId === 'string' ? leg.companyId.trim() : '';
  if (!legCompanyId) {
    return { ok: false, code: 'failed-precondition', reason: 'Dispatch has no companyId' };
  }

  // Tenant scoping & actor authorization
  if (actor.kind === 'driver') {
    if (actor.companyId !== legCompanyId) {
      return { ok: false, code: 'permission-denied', reason: 'Cross-company access denied' };
    }
    const isOwner =
      leg.driverId === actor.driverId ||
      leg.driverHash === actor.driverId ||
      (actor.driverHash && leg.driverHash === actor.driverHash) ||
      leg.assignedDriverId === actor.driverId;
    if (!isOwner && leg.driverId) {
      return { ok: false, code: 'permission-denied', reason: 'Caller is not assigned to this dispatch' };
    }
  } else {
    if (!actor.isPlatformAdmin && actor.companyId !== legCompanyId) {
      return { ok: false, code: 'permission-denied', reason: 'Cross-company access denied' };
    }
  }

  // Verify all family members belong to same tenant (mixed family rejection)
  for (const m of family) {
    const memCompany = typeof m.companyId === 'string' ? m.companyId.trim() : '';
    if (!memCompany || memCompany !== legCompanyId) {
      return { ok: false, code: 'failed-precondition', reason: 'Split family contains mixed company members' };
    }
  }

  const live = family
    .filter((l) => !SPLIT_TERMINAL_STATUSES.has(String(l.status)))
    .sort((a, b) => numSeq(a.splitSequence) - numSeq(b.splitSequence));

  const legStatus = String(leg.status || '');

  // Terminal & started guards
  if (SPLIT_TERMINAL_STATUSES.has(legStatus)) {
    if (legStatus === 'cancelled' && leg.splitLegRemoved === true) {
      const remaining = live.filter((l) => l.id !== legDispatchId);
      const baseSeqsR = remaining.map((l) => numSeq(l.splitSequence)).filter((n) => isFinite(n));
      const baseR = baseSeqsR.length ? Math.min(...baseSeqsR) : 1;
      return {
        ok: true,
        idempotent: true,
        splitGroupId,
        removedId: legDispatchId,
        newTotal: remaining.length,
        base: baseR,
        order: remaining.map((l, idx) => ({ id: l.id, splitSequence: baseR + idx })),
        updates: [],
        cancelFields: {},
      };
    }
    return { ok: false, code: 'failed-precondition', reason: `Leg already ${legStatus}.` };
  }

  // Anchor guard: cannot remove the lowest live sequence leg
  const anchorId = live[0]?.id;
  if (legDispatchId === anchorId) {
    return {
      ok: false,
      code: 'failed-precondition',
      reason: 'Cannot remove the anchor leg (A) — cancel the family instead.',
    };
  }

  if (SPLIT_STARTED_STATUSES.has(legStatus)) {
    return { ok: false, code: 'failed-precondition', reason: `Cannot remove a started leg (status ${legStatus}).` };
  }

  const remaining = live.filter((l) => l.id !== legDispatchId);
  const newTotal = remaining.length;
  const baseSeqsR = remaining.map((l) => numSeq(l.splitSequence)).filter((n) => isFinite(n));
  const baseR = baseSeqsR.length ? Math.min(...baseSeqsR) : 1;

  const updates = remaining.map((l, idx) => ({
    id: l.id,
    splitSequence: baseR + idx,
    splitTotal: newTotal,
  }));

  const cleanReason = typeof reason === 'string' ? reason.trim().slice(0, 200) : '';
  const cancelFields: Record<string, unknown> = {
    status: 'cancelled',
    cancelReason: cleanReason || 'Split leg removed (planning cleanup)',
    splitLegRemoved: true,
    splitRemoveReason: cleanReason || null,
    splitRemovedBy: actor.kind === 'driver' ? actor.driverId : actor.uid,
  };

  return {
    ok: true,
    splitGroupId,
    removedId: legDispatchId,
    newTotal,
    base: baseR,
    order: remaining.map((l, idx) => ({ id: l.id, splitSequence: baseR + idx })),
    updates,
    cancelFields,
  };
}

export type EvaluateResequenceSplitFamilyInput = {
  actor: SplitActor;
  splitGroupId: string;
  orderedLegIds: unknown;
  family: Array<{ id: string; [key: string]: unknown }>;
};

export type EvaluateResequenceSplitFamilyResult =
  | {
      ok: true;
      idempotent?: boolean;
      splitGroupId: string;
      newTotal: number;
      base: number;
      order: Array<{ id: string; splitSequence: number }>;
      updates: Array<{ id: string; splitSequence: number; splitTotal: number }>;
    }
  | {
      ok: false;
      code: 'not-found' | 'permission-denied' | 'failed-precondition' | 'invalid-argument';
      reason: string;
    };

export function evaluateResequenceSplitFamily(
  input: EvaluateResequenceSplitFamilyInput,
): EvaluateResequenceSplitFamilyResult {
  const { actor, splitGroupId, orderedLegIds, family } = input;

  if (!splitGroupId || typeof splitGroupId !== 'string') {
    return { ok: false, code: 'invalid-argument', reason: 'splitGroupId is required' };
  }
  if (!Array.isArray(orderedLegIds) || orderedLegIds.length === 0) {
    return {
      ok: false,
      code: 'invalid-argument',
      reason: 'orderedLegIds must be a non-empty array of leg IDs',
    };
  }
  for (const id of orderedLegIds) {
    if (typeof id !== 'string' || !id.trim()) {
      return { ok: false, code: 'invalid-argument', reason: 'Each orderedLegId must be a non-empty string' };
    }
  }

  if (family.length === 0) {
    return {
      ok: false,
      code: 'not-found',
      reason: `No dispatches for splitGroupId=${splitGroupId}`,
    };
  }

  const firstDocCompany = typeof family[0].companyId === 'string' ? family[0].companyId.trim() : '';
  if (!firstDocCompany) {
    return { ok: false, code: 'failed-precondition', reason: 'Split family has no companyId' };
  }

  // Tenant scoping & mixed family check
  for (const doc of family) {
    const memCompany = typeof doc.companyId === 'string' ? doc.companyId.trim() : '';
    if (!memCompany || memCompany !== firstDocCompany) {
      return {
        ok: false,
        code: 'failed-precondition',
        reason: 'Split family contains mixed company members',
      };
    }
  }

  // Authorization
  if (actor.kind === 'driver') {
    if (actor.companyId !== firstDocCompany) {
      return { ok: false, code: 'permission-denied', reason: 'Cross-company access denied' };
    }
    for (const doc of family) {
      const isOwner =
        doc.driverId === actor.driverId ||
        doc.driverHash === actor.driverId ||
        (actor.driverHash && doc.driverHash === actor.driverHash) ||
        doc.assignedDriverId === actor.driverId;
      if (!isOwner && doc.driverId) {
        return {
          ok: false,
          code: 'permission-denied',
          reason: 'Caller is not assigned to all legs in this split family',
        };
      }
    }
  } else {
    if (!actor.isPlatformAdmin && actor.companyId !== firstDocCompany) {
      return { ok: false, code: 'permission-denied', reason: 'Cross-company access denied' };
    }
  }

  const live = family
    .filter((l) => !SPLIT_TERMINAL_STATUSES.has(String(l.status)))
    .sort((a, b) => numSeq(a.splitSequence) - numSeq(b.splitSequence));

  const liveIds = new Set(live.map((l) => l.id));
  const reqSet = new Set(orderedLegIds);

  if (orderedLegIds.length !== liveIds.size || reqSet.size !== liveIds.size || !orderedLegIds.every((id) => liveIds.has(id))) {
    return {
      ok: false,
      code: 'failed-precondition',
      reason: 'orderedLegIds must be exactly the live (non-terminal) legs',
    };
  }

  // Anchor leg (A) cannot move
  if (orderedLegIds[0] !== live[0].id) {
    return { ok: false, code: 'failed-precondition', reason: 'Anchor leg (A) cannot move' };
  }

  // Locked legs (anchor + started) must keep their current index
  const isLocked = (l: { id: string; status?: unknown }) =>
    l.id === live[0].id || SPLIT_STARTED_STATUSES.has(String(l.status));
  for (let i = 0; i < live.length; i++) {
    if (isLocked(live[i]) && orderedLegIds[i] !== live[i].id) {
      return {
        ok: false,
        code: 'failed-precondition',
        reason: `A started/anchor leg cannot change position (index ${i}).`,
      };
    }
  }

  const baseSeqs = live.map((l) => numSeq(l.splitSequence)).filter((n) => isFinite(n));
  const base = baseSeqs.length ? Math.min(...baseSeqs) : 1;
  const newTotal = orderedLegIds.length;

  // Check idempotency: order already identical
  const isAlreadyOrdered = live.every((l, idx) => l.id === orderedLegIds[idx] && numSeq(l.splitSequence) === base + idx);
  if (isAlreadyOrdered) {
    return {
      ok: true,
      idempotent: true,
      splitGroupId,
      newTotal,
      base,
      order: orderedLegIds.map((id, idx) => ({ id, splitSequence: base + idx })),
      updates: [],
    };
  }

  const updates = orderedLegIds.map((id, idx) => ({
    id,
    splitSequence: base + idx,
    splitTotal: newTotal,
  }));

  return {
    ok: true,
    splitGroupId,
    newTotal,
    base,
    order: orderedLegIds.map((id, idx) => ({ id, splitSequence: base + idx })),
    updates,
  };
}

// ── Callable Implementations ────────────────────────────────────────────────

export const addSplitLeg = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as {
      parentDispatchId?: string;
      callerDriverHash?: string;
      idempotencyKey?: string;
      legSpec?: {
        disposal?: string;
        disposalLat?: number | null;
        disposalLng?: number | null;
        bbls?: number | null;
        jobType?: string | null;
        serviceType?: string | null;
        notes?: string | null;
        destinationType?: string | null;
      };
    };

    const actor = await resolveSplitActor(request, data.callerDriverHash);

    const parentDispatchId = typeof data.parentDispatchId === 'string' ? data.parentDispatchId.trim() : '';
    if (!parentDispatchId) {
      throw new httpsV2.HttpsError('invalid-argument', 'parentDispatchId is required');
    }
    const legSpec = data.legSpec || {};
    if (!legSpec.disposal || typeof legSpec.disposal !== 'string') {
      throw new httpsV2.HttpsError('invalid-argument', 'legSpec.disposal is required');
    }

    const fs = admin.firestore();

    // Idempotency check if key supplied
    const idemKey = typeof data.idempotencyKey === 'string' ? data.idempotencyKey.trim() : '';
    if (idemKey) {
      const exQuery = await fs
        .collection('dispatches')
        .where('idempotencyKey', '==', idemKey)
        .limit(1)
        .get();
      if (!exQuery.empty) {
        const exDoc = exQuery.docs[0];
        const exData = exDoc.data() || {};
        return {
          idempotent: true,
          newDispatchId: exDoc.id,
          splitGroupId: exData.splitGroupId,
          splitSequence: exData.splitSequence,
          splitTotal: exData.splitTotal,
          parentBblsBefore: exData.bbls ?? null,
          parentBblsAfter: exData.bbls ?? null,
        };
      }
    }

    const now = admin.firestore.Timestamp.now();
    const newDispatchRef = fs.collection('dispatches').doc();

    const result = await fs.runTransaction(async (tx) => {
      const parentRef = fs.collection('dispatches').doc(parentDispatchId);
      const parentSnap = await tx.get(parentRef);
      const parentData = parentSnap.exists ? (parentSnap.data() as Record<string, unknown>) : null;

      // Capability enforcement seam
      const capCheck = await defaultSplitCapabilityAuthorizer.authorizeSplitOperation({
        operation: 'add',
        dispatch: parentData || undefined,
        splitGroupId: parentData?.splitGroupId as string | undefined,
        actor,
      });
      if (!capCheck.allowed) {
        throw new httpsV2.HttpsError('permission-denied', capCheck.reason || 'Split operation not permitted');
      }

      let siblings: Array<{ id: string; [key: string]: unknown }> = [];
      const parentSplitGroupId = parentData?.splitGroupId as string | undefined;
      const parentCompanyId = parentData?.companyId as string | undefined;

      if (parentSplitGroupId && parentCompanyId) {
        const sibSnap = await tx.get(
          fs
            .collection('dispatches')
            .where('companyId', '==', parentCompanyId)
            .where('splitGroupId', '==', parentSplitGroupId),
        );
        siblings = sibSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      }

      const evaluation = evaluateAddSplitLeg({
        actor,
        parent: parentData,
        parentDispatchId,
        siblings,
        legSpec,
        nowMillis: now.toMillis(),
        idempotencyKey: idemKey || undefined,
      });

      if (!evaluation.ok) {
        throw new httpsV2.HttpsError(evaluation.code, evaluation.reason);
      }

      // Writes in transaction
      tx.set(newDispatchRef, {
        ...evaluation.newDispatchFields,
        createdAt: now,
        assignedAt: now,
      });

      // Update parent
      const pUpdates: Record<string, unknown> = {
        ...evaluation.parentUpdateFields,
        updatedAt: now,
      };
      if (evaluation.reduceBy > 0 && evaluation.parentBblsAfter != null) {
        const red = evaluation.parentUpdateFields._splitAdjustReduction as {
          reduceBy: number;
          existingAdjustedBy: string[];
          existingAdjustedAt: unknown[];
          existingAdjustedAmount: number[];
        };
        delete pUpdates._splitAdjustReduction;
        pUpdates.splitAdjustedByLegId = [...red.existingAdjustedBy, newDispatchRef.id];
        pUpdates.splitAdjustedAt = [...red.existingAdjustedAt, now];
        pUpdates.splitAdjustedAmount = [...red.existingAdjustedAmount, red.reduceBy];
      }
      tx.update(parentRef, pUpdates);

      // Update siblings
      for (const sib of siblings) {
        if (sib.id !== parentDispatchId) {
          const sRef = fs.collection('dispatches').doc(sib.id);
          tx.update(sRef, {
            ...evaluation.siblingUpdateFields,
            updatedAt: now,
          });
        }
      }

      return evaluation;
    });

    // Mirror to invoices (matching company & splitGroupId)
    try {
      const invSnap = await fs
        .collection('invoices')
        .where('companyId', '==', result.newDispatchFields.companyId)
        .where('dispatchSplitGroupId', '==', result.splitGroupId)
        .get();
      if (!invSnap.empty) {
        const invBatch = fs.batch();
        invSnap.forEach((d) => {
          invBatch.update(d.ref, {
            dispatchSplitTotal: result.newTotal,
            updatedAt: now,
          });
        });
        await invBatch.commit();
      }
    } catch (e: any) {
      console.warn('[addSplitLeg] invoice mirror failed:', e?.message);
    }

    await writeSecurityAudit({
      action: 'addSplitLeg',
      actorUid: actor.uid,
      driverId: actor.kind === 'driver' ? actor.driverId : undefined,
      detail: {
        parentDispatchId,
        newDispatchId: newDispatchRef.id,
        splitGroupId: result.splitGroupId,
        splitSequence: result.nextSequence,
        companyId: result.newDispatchFields.companyId,
      },
    });

    return {
      newDispatchId: newDispatchRef.id,
      splitGroupId: result.splitGroupId,
      splitSequence: result.nextSequence,
      splitTotal: result.newTotal,
      parentBblsBefore: result.parentBblsBefore,
      parentBblsAfter: result.parentBblsAfter ?? result.parentBblsBefore,
    };
  },
);

export const removeSplitLeg = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as {
      legDispatchId?: string;
      callerDriverHash?: string;
      reason?: string;
    };

    const actor = await resolveSplitActor(request, data.callerDriverHash);

    const legDispatchId = typeof data.legDispatchId === 'string' ? data.legDispatchId.trim() : '';
    if (!legDispatchId) {
      throw new httpsV2.HttpsError('invalid-argument', 'legDispatchId is required');
    }

    const fs = admin.firestore();
    const now = admin.firestore.Timestamp.now();

    const result = await fs.runTransaction(async (tx) => {
      const legRef = fs.collection('dispatches').doc(legDispatchId);
      const legSnap = await tx.get(legRef);
      const legData = legSnap.exists ? (legSnap.data() as Record<string, unknown>) : null;

      const splitGroupId = legData?.splitGroupId as string | undefined;
      const companyId = legData?.companyId as string | undefined;

      let family: Array<{ id: string; [key: string]: unknown }> = [];
      if (splitGroupId && companyId) {
        const famSnap = await tx.get(
          fs
            .collection('dispatches')
            .where('companyId', '==', companyId)
            .where('splitGroupId', '==', splitGroupId),
        );
        family = famSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      }

      // Capability enforcement seam
      const capCheck = await defaultSplitCapabilityAuthorizer.authorizeSplitOperation({
        operation: 'remove',
        dispatch: legData || undefined,
        splitGroupId,
        actor,
      });
      if (!capCheck.allowed) {
        throw new httpsV2.HttpsError('permission-denied', capCheck.reason || 'Split operation not permitted');
      }

      const evaluation = evaluateRemoveSplitLeg({
        actor,
        legDispatchId,
        leg: legData,
        family,
        reason: data.reason,
      });

      if (!evaluation.ok) {
        throw new httpsV2.HttpsError(evaluation.code, evaluation.reason);
      }

      if (evaluation.idempotent) {
        return evaluation;
      }

      // Mark cancelled
      tx.update(legRef, {
        ...evaluation.cancelFields,
        cancelledAt: now,
        declinedAt: now,
        splitRemovedAt: now,
        updatedAt: now,
      });

      // Resequence remaining siblings
      for (const upd of evaluation.updates) {
        const sRef = fs.collection('dispatches').doc(upd.id);
        tx.update(sRef, {
          splitSequence: upd.splitSequence,
          splitTotal: upd.splitTotal,
          updatedAt: now,
        });
      }

      return evaluation;
    });

    if (result.idempotent) {
      return {
        idempotent: true,
        splitGroupId: result.splitGroupId,
        removedId: result.removedId,
        newTotal: result.newTotal,
        order: result.order,
      };
    }

    // Mirror to invoices
    try {
      const seqById = new Map(result.order.map((o) => [o.id, o.splitSequence]));
      const invSnap = await fs
        .collection('invoices')
        .where('companyId', '==', actor.companyId)
        .where('dispatchSplitGroupId', '==', result.splitGroupId)
        .get();
      if (!invSnap.empty) {
        const invBatch = fs.batch();
        invSnap.forEach((d) => {
          const upd: Record<string, unknown> = {
            dispatchSplitTotal: result.newTotal,
            updatedAt: now,
          };
          const sid = (d.data() as any).dispatchId;
          if (sid && seqById.has(sid)) upd.dispatchSplitSequence = seqById.get(sid);
          invBatch.update(d.ref, upd);
        });
        await invBatch.commit();
      }
    } catch (e: any) {
      console.warn('[removeSplitLeg] invoice mirror failed:', e?.message);
    }

    await writeSecurityAudit({
      action: 'removeSplitLeg',
      actorUid: actor.uid,
      driverId: actor.kind === 'driver' ? actor.driverId : undefined,
      detail: {
        legDispatchId,
        splitGroupId: result.splitGroupId,
        newTotal: result.newTotal,
      },
    });

    return {
      splitGroupId: result.splitGroupId,
      removedId: result.removedId,
      newTotal: result.newTotal,
      order: result.order,
    };
  },
);

export const resequenceSplitFamily = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as {
      splitGroupId?: string;
      orderedLegIds?: string[];
      callerDriverHash?: string;
    };

    const actor = await resolveSplitActor(request, data.callerDriverHash);

    const splitGroupId = typeof data.splitGroupId === 'string' ? data.splitGroupId.trim() : '';
    const orderedLegIds = data.orderedLegIds;
    if (!splitGroupId || !Array.isArray(orderedLegIds) || orderedLegIds.length === 0) {
      throw new httpsV2.HttpsError(
        'invalid-argument',
        'splitGroupId and non-empty orderedLegIds are required',
      );
    }

    const fs = admin.firestore();
    const now = admin.firestore.Timestamp.now();

    const result = await fs.runTransaction(async (tx) => {
      // Tenant-scoped query
      let famQuery: FirebaseFirestore.Query;
      if (actor.companyId) {
        famQuery = fs
          .collection('dispatches')
          .where('companyId', '==', actor.companyId)
          .where('splitGroupId', '==', splitGroupId);
      } else if (actor.kind === 'staff' && actor.isPlatformAdmin) {
        famQuery = fs.collection('dispatches').where('splitGroupId', '==', splitGroupId);
      } else {
        throw new httpsV2.HttpsError('permission-denied', 'Actor has no companyId');
      }

      const famSnap = await tx.get(famQuery);
      const family = famSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

      // Capability enforcement seam
      const capCheck = await defaultSplitCapabilityAuthorizer.authorizeSplitOperation({
        operation: 'resequence',
        splitGroupId,
        actor,
      });
      if (!capCheck.allowed) {
        throw new httpsV2.HttpsError('permission-denied', capCheck.reason || 'Split operation not permitted');
      }

      const evaluation = evaluateResequenceSplitFamily({
        actor,
        splitGroupId,
        orderedLegIds,
        family,
      });

      if (!evaluation.ok) {
        throw new httpsV2.HttpsError(evaluation.code, evaluation.reason);
      }

      if (evaluation.idempotent) {
        return evaluation;
      }

      for (const upd of evaluation.updates) {
        const legRef = fs.collection('dispatches').doc(upd.id);
        tx.update(legRef, {
          splitSequence: upd.splitSequence,
          splitTotal: upd.splitTotal,
          updatedAt: now,
        });
      }

      return evaluation;
    });

    if (result.idempotent) {
      return {
        idempotent: true,
        splitGroupId: result.splitGroupId,
        newTotal: result.newTotal,
        base: result.base,
        order: result.order,
      };
    }

    // Mirror to invoices
    try {
      const seqById = new Map(result.order.map((o) => [o.id, o.splitSequence]));
      const invCompany = actor.companyId;
      let invQuery: FirebaseFirestore.Query = fs
        .collection('invoices')
        .where('dispatchSplitGroupId', '==', result.splitGroupId);
      if (invCompany) {
        invQuery = invQuery.where('companyId', '==', invCompany);
      }
      const invSnap = await invQuery.get();
      if (!invSnap.empty) {
        const invBatch = fs.batch();
        invSnap.forEach((d) => {
          const upd: Record<string, unknown> = {
            dispatchSplitTotal: result.newTotal,
            updatedAt: now,
          };
          const sid = (d.data() as any).dispatchId;
          if (sid && seqById.has(sid)) upd.dispatchSplitSequence = seqById.get(sid);
          invBatch.update(d.ref, upd);
        });
        await invBatch.commit();
      }
    } catch (e: any) {
      console.warn('[resequenceSplitFamily] invoice mirror failed:', e?.message);
    }

    await writeSecurityAudit({
      action: 'resequenceSplitFamily',
      actorUid: actor.uid,
      driverId: actor.kind === 'driver' ? actor.driverId : undefined,
      detail: {
        splitGroupId: result.splitGroupId,
        newTotal: result.newTotal,
      },
    });

    return {
      splitGroupId: result.splitGroupId,
      newTotal: result.newTotal,
      base: result.base,
      order: result.order,
    };
  },
);
