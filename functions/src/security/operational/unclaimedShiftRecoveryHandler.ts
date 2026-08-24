/**
 * adminRecoverUnclaimedDriverShift — inspect / execute.
 *
 * Dual-gated through requireAdmin (wellbuiltAdmin claim AND enabled
 * platform_admins record). Drivers cannot call this. Ordinary
 * claimDriverShift is untouched, including isPlausibleLocalDate.
 *
 * Inspect writes nothing. Execute re-reads the inspect snapshot inside
 * one transaction before any write.
 */
import { createHash } from 'crypto';
import { AdminCallError, type AdminDeps, type AdminTransaction } from '../../admin/adminDeps.js';
import { requireAdmin } from '../../admin/adminHandlers.js';
import { ADMIN_AUDIT_COLLECTION, AUDIT_REASON_MAX, buildAuditRecord } from '../../admin/adminAudit.js';
import type { VerifiedCallerAuth } from '../../admin/authority.js';
import {
  recordAfterClaim,
  shiftAuthorityPath,
  shiftDayPath,
  type ShiftAuthorityRecord,
} from './shiftAuthority.js';
import { readAuthorityRecord } from './shiftAuthorityMigrationHandler.js';
import {
  AUTHORITY_RECOVERED_EVENT_TYPE,
  RECOVER_UNCLAIMED_OPERATION,
  buildAuthorityRecoveredEvent,
  computeInspectFingerprint,
  decideUnclaimedRecovery,
  recoveryAuditDocId,
  snapshotFromEvidence,
  type MintedDiagnosticEvidence,
  type RecoverMode,
  type UnclaimedRecoveryRequest,
} from './unclaimedShiftRecovery.js';

const KEYS = [
  'driverId',
  'companyId',
  'periodId',
  'expectedAuthorityVersion',
  'mode',
  'reason',
  'inspectStateFingerprint',
] as const;

export interface UnclaimedRecoveryReaders {
  findMintedDiagnostic(periodId: string): Promise<MintedDiagnosticEvidence>;
  hasPostTripReceipt(opts: {
    periodId: string;
    driverId: string;
    companyId: string;
  }): Promise<boolean>;
}

export interface UnclaimedRecoveryResult {
  mode: RecoverMode;
  changed: boolean;
  recoverable?: boolean;
  alreadyRecovered?: boolean;
  fingerprint?: string;
  reason?: string;
  evidence?: {
    initialized: boolean;
    authorityState: string;
    openPeriodId: string | null;
    lastClosedPeriodId: string | null;
    authorityVersion: number | null;
    originDayPresent: boolean;
    originDayCurrentShiftId: string | null;
    postTripPresent: boolean;
    mintedFound: boolean;
    mintedLegacyLocal: boolean;
  };
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function requireExactKeys(data: unknown): Record<string, unknown> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new AdminCallError('invalid-argument', 'payload_not_object');
  }
  const d = data as Record<string, unknown>;
  const extra = Object.keys(d).filter((k) => !(KEYS as readonly string[]).includes(k));
  if (extra.length) throw new AdminCallError('invalid-argument', `unknown_fields:${extra.join(',')}`);
  for (const k of KEYS) {
    if (d[k] === undefined) throw new AdminCallError('invalid-argument', `missing_field:${k}`);
  }
  return d;
}

function requireString(d: Record<string, unknown>, k: string, max = 200): string {
  const v = d[k];
  if (typeof v !== 'string' || v.length === 0 || v.length > max || v.includes('/')) {
    throw new AdminCallError('invalid-argument', `invalid_field:${k}`);
  }
  return v;
}

function parseRequest(data: unknown): UnclaimedRecoveryRequest {
  const d = requireExactKeys(data);
  const mode = d.mode;
  if (mode !== 'inspect' && mode !== 'execute') {
    throw new AdminCallError('invalid-argument', 'invalid_field:mode');
  }
  const expectedAuthorityVersion = d.expectedAuthorityVersion;
  if (typeof expectedAuthorityVersion !== 'number'
    || !Number.isInteger(expectedAuthorityVersion)
    || expectedAuthorityVersion < 1
    || expectedAuthorityVersion > 1_000_000) {
    throw new AdminCallError('invalid-argument', 'invalid_field:expectedAuthorityVersion');
  }
  const fingerprint = d.inspectStateFingerprint;
  if (typeof fingerprint !== 'string' || fingerprint.length > 128) {
    throw new AdminCallError('invalid-argument', 'invalid_field:inspectStateFingerprint');
  }
  const reason = requireString(d, 'reason', AUDIT_REASON_MAX);
  return {
    driverId: requireString(d, 'driverId', 128),
    companyId: requireString(d, 'companyId', 128),
    periodId: requireString(d, 'periodId', 32),
    expectedAuthorityVersion,
    mode,
    reason,
    inspectStateFingerprint: fingerprint,
  };
}

function toOriginDay(snap: { exists: boolean; data?: Record<string, unknown> }) {
  if (!snap.exists) return { readable: true, present: false as const };
  const current = snap.data?.currentShiftId;
  return {
    readable: true,
    present: true as const,
    currentShiftId: typeof current === 'string' ? current : null,
  };
}

async function gatherSnapshot(
  read: (path: string) => Promise<{ exists: boolean; data?: Record<string, unknown> }>,
  readers: UnclaimedRecoveryReaders,
  req: UnclaimedRecoveryRequest,
) {
  const originLocalDate = req.periodId.slice(0, 10);
  const authoritySnap = await read(shiftAuthorityPath(req.driverId));
  const originSnap = await read(shiftDayPath(req.driverId, originLocalDate));
  const [minted, postTripPresent] = await Promise.all([
    readers.findMintedDiagnostic(req.periodId),
    readers.hasPostTripReceipt({
      periodId: req.periodId,
      driverId: req.driverId,
      companyId: req.companyId,
    }),
  ]);
  const authority = readAuthorityRecord(authoritySnap);
  const originDay = toOriginDay(originSnap);
  const snapshot = snapshotFromEvidence({
    request: req, authority, originDay, postTripPresent, minted,
  });
  const fingerprint = computeInspectFingerprint(snapshot, sha256Hex);
  return { authority, originSnap, snapshot, fingerprint };
}

function redactedEvidence(snapshot: ReturnType<typeof snapshotFromEvidence>) {
  return {
    initialized: snapshot.initialized,
    authorityState: snapshot.authorityState,
    openPeriodId: snapshot.openPeriodId,
    lastClosedPeriodId: snapshot.lastClosedPeriodId,
    authorityVersion: snapshot.authorityVersion,
    originDayPresent: snapshot.originDayPresent,
    originDayCurrentShiftId: snapshot.originDayCurrentShiftId,
    postTripPresent: snapshot.postTripPresent,
    mintedFound: snapshot.mintedFound,
    mintedLegacyLocal: snapshot.mintedLegacyLocal,
  };
}

export async function recoverUnclaimedDriverShiftHandler(
  deps: AdminDeps,
  auth: VerifiedCallerAuth | null,
  data: unknown,
  readers: UnclaimedRecoveryReaders,
): Promise<UnclaimedRecoveryResult> {
  const actor = await requireAdmin(deps, auth);
  const req = parseRequest(data);

  if (req.mode === 'inspect') {
    const { snapshot, fingerprint } = await gatherSnapshot((p) => deps.getDoc(p), readers, req);
    const decision = decideUnclaimedRecovery({ request: req, snapshot, fingerprint });
    if (decision.action !== 'inspect') {
      throw new AdminCallError('internal', 'inspect_decision_mismatch');
    }
    return {
      mode: 'inspect',
      changed: false,
      recoverable: decision.recoverable,
      fingerprint: decision.fingerprint,
      reason: decision.recoverable ? undefined : decision.reason,
      evidence: redactedEvidence(snapshot),
    };
  }

  const outcome = await deps.runTransaction(async (tx: AdminTransaction) => {
    const { authority, originSnap, snapshot, fingerprint } = await gatherSnapshot(
      (p) => tx.get(p),
      readers,
      req,
    );
    const decision = decideUnclaimedRecovery({ request: req, snapshot, fingerprint });
    if (decision.action === 'already_recovered') {
      return { kind: 'already_recovered' as const, snapshot, fingerprint };
    }
    if (decision.action !== 'execute') {
      const reason = decision.action === 'refuse'
        ? decision.reason
        : decision.action === 'inspect' && decision.recoverable === false
          ? decision.reason
          : 'invalid_request';
      return { kind: 'refuse' as const, reason, snapshot, fingerprint };
    }
    if (!authority) {
      return { kind: 'refuse' as const, reason: 'authority_unreadable' as const, snapshot, fingerprint };
    }
    if (originSnap.exists) {
      return { kind: 'refuse' as const, reason: 'origin_day_conflict' as const, snapshot, fingerprint };
    }

    const originLocalDate = snapshot.originLocalDate;
    const recovered: ShiftAuthorityRecord = recordAfterClaim(
      authority,
      req.periodId,
      originLocalDate,
    );
    tx.update(shiftAuthorityPath(req.driverId), {
      driverId: recovered.driverId,
      companyId: recovered.companyId,
      initialized: recovered.initialized,
      openPeriodId: recovered.openPeriodId,
      originLocalDate: recovered.originLocalDate,
      lastClosedPeriodId: recovered.lastClosedPeriodId ?? null,
      version: recovered.version,
      updatedAt: deps.serverTimestamp(),
    });

    const recoveredIso = new Date(deps.nowMs()).toISOString();
    const recoveryEvent = buildAuthorityRecoveredEvent(req.periodId, recoveredIso);
    tx.create(shiftDayPath(req.driverId, originLocalDate), {
      currentShiftId: req.periodId,
      driverId: req.driverId,
      companyId: req.companyId,
      date: originLocalDate,
      updatedAt: deps.serverTimestamp(),
      events: [recoveryEvent],
    });

    const driverFp12 = sha256Hex(req.driverId).slice(0, 12);
    tx.create(
      `${ADMIN_AUDIT_COLLECTION}/${recoveryAuditDocId(req.periodId, driverFp12)}`,
      buildAuditRecord({
        operation: RECOVER_UNCLAIMED_OPERATION,
        targetType: 'driver_shift',
        targetId: req.periodId,
        actorUid: actor.actorUid,
        actorEmail: actor.actorEmail,
        reason: req.reason,
        changedFields: [
          'driver_shift_authority.openPeriodId',
          'driver_shifts.currentShiftId',
          `event:${AUTHORITY_RECOVERED_EVENT_TYPE}`,
        ],
      }, deps.serverTimestamp()),
    );

    return { kind: 'executed' as const, snapshot, fingerprint };
  });

  if (outcome.kind === 'refuse') {
    throw new AdminCallError('failed-precondition', `recover_unclaimed_refused:${outcome.reason}`);
  }
  if (outcome.kind === 'already_recovered') {
    return {
      mode: 'execute',
      changed: false,
      alreadyRecovered: true,
      fingerprint: outcome.fingerprint,
      evidence: redactedEvidence(outcome.snapshot),
    };
  }
  return {
    mode: 'execute',
    changed: true,
    fingerprint: outcome.fingerprint,
    evidence: redactedEvidence(outcome.snapshot),
  };
}

export function silentUnclaimedReaders(): UnclaimedRecoveryReaders {
  return {
    async findMintedDiagnostic() {
      return { found: false, reason: null, source: null };
    },
    async hasPostTripReceipt() {
      return false;
    },
  };
}
