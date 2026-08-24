/**
 * adminRecoverUnclaimedDriverShift — incident-bound inspect / execute.
 *
 * Authorizing wellbuilt-sync evidence (authority, origin-day, diagnostics)
 * is re-read inside the execute transaction via getQuery (diagnostics)
 * and tx.get (docs).
 *
 * WB-E Post-Trip, if a server store existed, would live at
 * organizations/{orgId}/dvirReports on wellbuilt-equipment-prod
 * (named app "dvir"), schema summary.inspectionType + report.shiftId.
 * That project cannot join a wellbuilt-sync transaction.
 *
 * Production WB-E cloud writes are hard-disabled at writer SHA
 * 994ddcee146194874bd8fa1b97b4990eb3193831. There is no
 * server-authoritative Post-Trip store. Device-local completion is not
 * a server store. wellbuilt-sync organizations/{id}/dvirReports is not
 * queried and is not proof. Execute refuses
 * no_authoritative_server_completion_store. This is not atomic
 * completion exclusion — it is refusal because exclusion cannot be proven.
 */
import { createHash } from 'crypto';
import { AdminCallError, type AdminDeps, type AdminDocSnapshot } from '../../admin/adminDeps.js';
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
  INCIDENT,
  RECOVER_UNCLAIMED_OPERATION,
  WB_E_COMPLETION_AUTHORITY,
  buildAuthorityRecoveredEvent,
  classifyDiagnosticDocs,
  computeInspectFingerprint,
  credentialsPath,
  decideUnclaimedRecovery,
  nameIndexPath,
  recoveryAuditDocId,
  redactedDiagnosticTuples,
  snapshotFromEvidence,
  type RecoverMode,
  type RecoveryQueryResult,
  type RecoveryQuerySpec,
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

export interface RecoveryTx {
  get(path: string): Promise<AdminDocSnapshot>;
  getQuery(spec: RecoveryQuerySpec): Promise<RecoveryQueryResult>;
  update(path: string, fields: Record<string, unknown>): void;
  create(path: string, data: Record<string, unknown>): void;
}

export interface UnclaimedRecoveryDeps extends AdminDeps {
  getQuery(spec: RecoveryQuerySpec): Promise<RecoveryQueryResult>;
  runRecoveryTransaction<T>(fn: (tx: RecoveryTx) => Promise<T>): Promise<T>;
  resolveApprovedHash(driverHash: string): Promise<string | null>;
}

export interface UnclaimedRecoveryResult {
  mode: RecoverMode;
  changed: boolean;
  recoverable?: boolean;
  alreadyRecovered?: boolean;
  fingerprint?: string;
  reason?: string;
  evidence?: Record<string, unknown>;
  completionStores?: Record<string, unknown>;
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
  return {
    driverId: requireString(d, 'driverId', 128),
    companyId: requireString(d, 'companyId', 128),
    periodId: requireString(d, 'periodId', 32),
    expectedAuthorityVersion,
    mode,
    reason: requireString(d, 'reason', AUDIT_REASON_MAX),
    inspectStateFingerprint: fingerprint,
  };
}

function toOriginDay(snap: AdminDocSnapshot) {
  if (!snap.exists) return { readable: true, present: false as const };
  const current = snap.data?.currentShiftId;
  return {
    readable: true,
    present: true as const,
    currentShiftId: typeof current === 'string' ? current : null,
  };
}

async function gather(
  get: (path: string) => Promise<AdminDocSnapshot>,
  getQuery: (spec: RecoveryQuerySpec) => Promise<RecoveryQueryResult>,
  resolveHash: (hash: string) => Promise<string | null>,
  req: UnclaimedRecoveryRequest,
) {
  const originLocalDate = req.periodId.slice(0, 10);
  const nameSnap = await get(nameIndexPath(INCIDENT.displayNameNorm));
  const credSnap = await get(credentialsPath(req.driverId));
  const authoritySnap = await get(shiftAuthorityPath(req.driverId));
  const originSnap = await get(shiftDayPath(req.driverId, originLocalDate));
  const diagQ = await getQuery({ kind: 'minted_diagnostics', periodId: req.periodId });

  const hashCache = new Map<string, string | null>();
  const resolve = (hash: string) => {
    if (hashCache.has(hash)) return hashCache.get(hash) ?? null;
    return null;
  };
  if (diagQ.readable) {
    for (const d of diagQ.docs) {
      const h = d.data.driverHash;
      if (typeof h === 'string' && h && !hashCache.has(h)) {
        hashCache.set(h, await resolveHash(h));
      }
    }
  }
  const diagnosticBound = classifyDiagnosticDocs(
    { ...diagQ, matchingCount: diagQ.docs.length },
    req.periodId,
    req.driverId,
    resolve,
  );
  const diagnosticTuples = diagQ.readable
    ? redactedDiagnosticTuples(diagQ.docs || [], req.periodId)
    : [];

  const nameIndexDriverId = typeof nameSnap.data?.driverId === 'string' ? nameSnap.data.driverId : null;
  const credentialsActive = credSnap.exists && credSnap.data?.active !== false;

  const authority = readAuthorityRecord(authoritySnap);
  const snapshot = snapshotFromEvidence({
    request: req,
    authority,
    originDay: toOriginDay(originSnap),
    nameIndexDriverId,
    credentialsActive,
    diagnosticBound,
    diagnosticTuples,
  });
  const fingerprint = computeInspectFingerprint(snapshot, sha256Hex);
  return { authority, originSnap, snapshot, fingerprint };
}

function redactedEvidence(snapshot: ReturnType<typeof snapshotFromEvidence>) {
  return {
    initialized: snapshot.initialized,
    authorityState: snapshot.authorityState,
    openPeriodId: snapshot.openPeriodId,
    authorityOriginLocalDate: snapshot.authorityOriginLocalDate,
    lastClosedPeriodId: snapshot.lastClosedPeriodId,
    authorityVersion: snapshot.authorityVersion,
    originDayPresent: snapshot.originDayPresent,
    originDayCurrentShiftId: snapshot.originDayCurrentShiftId,
    identityMatch: snapshot.identityMatch,
    nameIndexMatch: snapshot.nameIndexMatch,
    credentialsActive: snapshot.credentialsActive,
    diagnosticBound: snapshot.diagnosticBound,
    diagnosticMatchingCount: snapshot.diagnosticMatchingCount,
    diagnosticArea: snapshot.diagnosticArea,
    diagnosticEvent: snapshot.diagnosticEvent,
    diagnosticShiftId: snapshot.diagnosticShiftId,
    diagnosticClientTimestamp: snapshot.diagnosticClientTimestamp,
    completionStoreKind: snapshot.completionStoreKind,
    writerSha: snapshot.writerSha,
    dedicatedProjectProd: snapshot.dedicatedProjectProd,
    productionCloudWritesEnabled: snapshot.productionCloudWritesEnabled,
    productionAuthoritativeServerStore: snapshot.productionAuthoritativeServerStore,
    productionCompletion: snapshot.productionCompletion,
    crossProjectAtomicExclusion: snapshot.crossProjectAtomicExclusion,
  };
}

export const COMPLETION_STORE_NOTES = Object.freeze({
  writerSha: WB_E_COMPLETION_AUTHORITY.writerSha,
  writerTransport: WB_E_COMPLETION_AUTHORITY.writerTransport,
  namedApp: WB_E_COMPLETION_AUTHORITY.namedApp,
  dedicatedProjectProd: WB_E_COMPLETION_AUTHORITY.dedicatedProject.prod,
  dedicatedProjectDev: WB_E_COMPLETION_AUTHORITY.dedicatedProject.dev,
  forbiddenProject: WB_E_COMPLETION_AUTHORITY.forbiddenHostProject,
  schema: 'DvirCloudDocument.summary.inspectionType + DvirCloudDocument.report.shiftId at organizations/{orgId}/dvirReports',
  productionCloudWritesEnabled: WB_E_COMPLETION_AUTHORITY.productionCloudWritesEnabled,
  productionAuthoritativeServerStore: WB_E_COMPLETION_AUTHORITY.productionAuthoritativeServerStore,
  productionCompletion: WB_E_COMPLETION_AUTHORITY.productionCompletion,
  crossProjectAtomicExclusion: WB_E_COMPLETION_AUTHORITY.crossProjectAtomicExclusion,
  wellbuiltSyncOrganizationsDvirReports:
    'NOT the WB-E store. Not queried. An empty same-named collection on wellbuilt-sync is not proof.',
  dashboardInspections:
    'wellbuilt-sync companies/{companyId}/dvir_inspections is dvir.submitPreTrip, inspectionType pre_trip only — not a Post-Trip completion store',
  suiteReceipt: 'device AsyncStorage @wb/suite-dvir-gate/v1/receipt/{shiftId}/post_trip — not a server store',
  execute: 'refuses no_authoritative_server_completion_store because production has no authoritative server completion store and cross-project atomic exclusion does not exist',
});

export async function recoverUnclaimedDriverShiftHandler(
  deps: UnclaimedRecoveryDeps,
  auth: VerifiedCallerAuth | null,
  data: unknown,
): Promise<UnclaimedRecoveryResult> {
  const actor = await requireAdmin(deps, auth);
  const req = parseRequest(data);

  if (req.mode === 'inspect') {
    const { snapshot, fingerprint } = await gather(
      (p) => deps.getDoc(p),
      (s) => deps.getQuery(s),
      (h) => deps.resolveApprovedHash(h),
      req,
    );
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
      completionStores: COMPLETION_STORE_NOTES,
    };
  }

  const outcome = await deps.runRecoveryTransaction(async (tx) => {
    const { authority, originSnap, snapshot, fingerprint } = await gather(
      (p) => tx.get(p),
      (s) => tx.getQuery(s),
      (h) => deps.resolveApprovedHash(h),
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
    const recovered: ShiftAuthorityRecord = recordAfterClaim(authority, req.periodId, originLocalDate);
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
    tx.create(shiftDayPath(req.driverId, originLocalDate), {
      currentShiftId: req.periodId,
      driverId: req.driverId,
      companyId: req.companyId,
      date: originLocalDate,
      updatedAt: deps.serverTimestamp(),
      events: [buildAuthorityRecoveredEvent(req.periodId, recoveredIso)],
    });
    tx.create(
      `${ADMIN_AUDIT_COLLECTION}/${recoveryAuditDocId(req.periodId, sha256Hex(req.driverId).slice(0, 12))}`,
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
