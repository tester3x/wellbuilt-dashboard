// handoff-recovery.ts
//
// 2026-05-12 — Admin recovery tooling for mid-handoff orphan invoices.
//
// Why this exists:
//   A receiver-side transferred invoice can reach driverState in
//   ('en_route_handoff', 'on_site_handoff') and stall there indefinitely
//   if the receiver never completes the disposal leg — app crashes,
//   phone dies, shift ends without close, driver forgets, etc.
//   Currently the only path to clean up is a manual Firestore script
//   (per 9955167 commit message, 18449 was exactly this scenario:
//   "abandoned mid-handoff, not closed. Recovery is a separate admin
//   path (Phase E, deferred).").
//
//   This callable closes the gap with a minimal but authoritative
//   recovery surface: void the job, or restore ownership to the
//   original sender. Either path is fully audited and never relies on
//   the driver's local AsyncStorage state.
//
// What this is NOT:
//   - A driver-side cancel bypass. Cancel-on-loaded is intentionally
//     blocked client-side (6c0f832); this callable is admin-only.
//   - A way to delete invoices. Audit history is preserved; status
//     transitions are observable.
//   - A scheduled job. Detection of "stuck handoffs" is a separate
//     query the dashboard surfaces; recovery is an explicit human
//     action.
//
// Auth: signed-in dashboard user with manageDrivers capability.
// (manageDrivers is held by admin / it / manager roles by default;
// per-company role override applies.)

import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { logCanonicalDiag } from './canonical-jobs/diag';

type RecoveryAction = 'report' | 'void' | 'restore_to_sender';

interface RecoveryInput {
  invoiceDocId?: string;
  action?: RecoveryAction;
  reason?: string;
}

interface InvoiceSnapshot {
  invoiceDocId: string;
  status: string;
  driverState: string;
  driverHash: string | null;
  driver: string | null;
  transferSourceDocId: string | null;
  activeTransferRequestId: string | null;
  lockedForTransfer: boolean;
  transferredFrom: string | null;
  transferredFromHash: string | null;
  transferredTo: string | null;
  transferredToHash: string | null;
  transferredAt: string | null;
  pendingTicketNumber: string | null;
  wellName: string | null;
  hauledTo: string | null;
  totalBBL: number | null;
  packetId: string | null;
  enRouteDestName: string | null;
  enRouteDestLat: number | null;
  enRouteDestLng: number | null;
  updatedAt: string | null;
  qualifiesForRecovery: boolean;
  reasonNotQualified: string | null;
}

interface RecoveryResponse {
  action: RecoveryAction;
  invoiceDocId: string;
  performed: boolean;
  snapshot: InvoiceSnapshot;
  changes: string[];
  auditLogId: string | null;
  cancelledTransferRequestId: string | null;
}

// Capability constants — mirror DEFAULT_ROLE_CAPABILITIES_SERVER from index.ts
// to avoid a circular import. Keep in sync (low-churn list).
const REQUIRED_CAPABILITY = 'manageDrivers';

const HANDOFF_DRIVER_STATES = new Set(['en_route_handoff', 'on_site_handoff']);

/**
 * Read the caller's role + companyId from RTDB users/{uid}, then their
 * effective capabilities (with per-company override applied). Returns
 * true if the caller has manageDrivers.
 */
async function callerHasCapability(
  uid: string,
  capability: string,
): Promise<{ ok: boolean; reason?: string; callerRole?: string }> {
  const userSnap = await admin.database().ref(`users/${uid}`).get();
  if (!userSnap.exists()) return { ok: false, reason: 'not_a_dashboard_user' };
  const userData = userSnap.val();
  const role = userData?.role as string | undefined;
  if (!role) return { ok: false, reason: 'no_role' };

  // Load per-company role overrides (if any) for capability resolution.
  let overrides: Record<string, string[]> = {};
  const companyId = userData?.companyId as string | undefined;
  if (companyId) {
    try {
      const compSnap = await admin.firestore().collection('companies').doc(companyId).get();
      overrides = (compSnap.data()?.roleCapabilities || {}) as Record<string, string[]>;
    } catch {
      // best-effort
    }
  }

  const DEFAULT_ROLE_CAPABILITIES_SERVER: Record<string, string[]> = {
    it: [
      'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewBilling',
      'viewPayroll', 'viewDriverLogs', 'viewSettings', 'viewAdmin', 'viewChat',
      'createDispatch', 'manageDrivers', 'manageCompany', 'editBilling',
      'approvePayroll', 'manageWells', 'manageRoutes', 'manageEquipment',
      'manageEquipmentAssignments',
      'sendChat', 'manageRolesAndCapabilities', 'viewAllCompanies', 'viewTruthDebug',
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
  const effective = overrides[role] ?? DEFAULT_ROLE_CAPABILITIES_SERVER[role] ?? [];
  return effective.includes(capability)
    ? { ok: true, callerRole: role }
    : { ok: false, reason: `missing_${capability}`, callerRole: role };
}

/**
 * Build a read-only snapshot of the invoice + qualification check.
 * Used by all three actions (report does just this; void/restore use
 * it as the pre-check).
 */
function buildSnapshot(
  invoiceDocId: string,
  data: admin.firestore.DocumentData,
): InvoiceSnapshot {
  const status = (data.status as string) || '';
  const driverState = (data.driverState as string) || '';
  const transferSourceDocId = (data.transferSourceDocId as string | null) || null;

  let qualifies = false;
  let notQualifiedReason: string | null = null;
  if (status !== 'open') {
    notQualifiedReason = `status_must_be_open (got ${status})`;
  } else if (!transferSourceDocId) {
    notQualifiedReason = 'not_a_transfer_receiver_invoice';
  } else if (!HANDOFF_DRIVER_STATES.has(driverState)) {
    notQualifiedReason = `driverState_not_in_handoff (got ${driverState})`;
  } else {
    qualifies = true;
  }

  const updatedAtTs = data.updatedAt as admin.firestore.Timestamp | null;
  const transferredAtTs = data.transferredAt as admin.firestore.Timestamp | string | null;
  let transferredAtIso: string | null = null;
  if (transferredAtTs && typeof transferredAtTs === 'object' && 'toDate' in transferredAtTs) {
    transferredAtIso = (transferredAtTs as admin.firestore.Timestamp).toDate().toISOString();
  } else if (typeof transferredAtTs === 'string') {
    transferredAtIso = transferredAtTs;
  }

  return {
    invoiceDocId,
    status,
    driverState,
    driverHash: (data.driverHash as string | null) || null,
    driver: (data.driver as string | null) || null,
    transferSourceDocId,
    activeTransferRequestId: (data.activeTransferRequestId as string | null) || null,
    lockedForTransfer: !!data.lockedForTransfer,
    transferredFrom: (data.transferredFrom as string | null) || null,
    transferredFromHash: (data.transferredFromHash as string | null) || null,
    transferredTo: (data.transferredTo as string | null) || null,
    transferredToHash: (data.transferredToHash as string | null) || null,
    transferredAt: transferredAtIso,
    pendingTicketNumber:
      data.pendingTicketNumber !== undefined && data.pendingTicketNumber !== null
        ? String(data.pendingTicketNumber)
        : null,
    wellName: (data.wellName as string | null) || null,
    hauledTo: (data.hauledTo as string | null) || null,
    totalBBL: (data.totalBBL as number | undefined) ?? null,
    packetId: (data.packetId as string | null) || (data.canonicalJobId as string | null) || null,
    enRouteDestName: (data.enRouteDestName as string | null) || null,
    enRouteDestLat: (data.enRouteDestLat as number | undefined) ?? null,
    enRouteDestLng: (data.enRouteDestLng as number | undefined) ?? null,
    updatedAt: updatedAtTs?.toDate?.()?.toISOString() || null,
    qualifiesForRecovery: qualifies,
    reasonNotQualified: notQualifiedReason,
  };
}

/**
 * Append an admin_recovery_log entry. Returns the new doc id.
 *
 * Audit doc shape carries: who, when, what action, why, the invoice
 * snapshot taken at the moment of recovery, the changes performed.
 * Append-only. Read via the Firestore console / future admin UI.
 */
async function writeAuditLog(
  callerUid: string,
  callerRole: string,
  action: RecoveryAction,
  reason: string,
  snapshot: InvoiceSnapshot,
  changes: string[],
  cancelledTransferRequestId: string | null,
): Promise<string> {
  const ref = await admin.firestore().collection('admin_recovery_log').add({
    callerUid,
    callerRole,
    action,
    reason,
    invoiceDocId: snapshot.invoiceDocId,
    snapshotBefore: snapshot,
    changes,
    cancelledTransferRequestId,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
}

/**
 * Find the active transfer_request linked to a stuck handoff invoice.
 * Used for both void and restore_to_sender — both terminate the request.
 * Prefers activeTransferRequestId from the invoice; falls back to a
 * query by sourceInvoiceDocId + status=pending/accepted.
 */
async function findActiveTransferRequest(
  invoiceDocId: string,
  invoiceData: admin.firestore.DocumentData,
): Promise<admin.firestore.QueryDocumentSnapshot | null> {
  const db = admin.firestore();
  const activeId = invoiceData.activeTransferRequestId as string | null;
  if (activeId) {
    const snap = await db.collection('transfer_requests').doc(activeId).get();
    if (snap.exists) {
      return snap as unknown as admin.firestore.QueryDocumentSnapshot;
    }
  }
  // Fallback: query for any non-terminal request pointing at this invoice.
  // For handoff orphans the request is typically 'accepted' (transition
  // was already made), so status filter is broad here.
  const q = await db
    .collection('transfer_requests')
    .where('sourceInvoiceDocId', '==', invoiceDocId)
    .where('status', 'in', ['pending', 'accepted'])
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  return q.empty ? null : q.docs[0];
}

/**
 * Recovery action — void the handoff. Invoice becomes status=cancelled.
 *
 * Effect:
 *   - invoices/{id}: status='cancelled', driverState='cancelled',
 *     cancelledAt=now, cancelledBy={uid, role, action}, cancelReason
 *     = 'admin_handoff_orphan_voided', cancelReasonNotes=reason,
 *     timeline append 'admin_void_handoff' event.
 *   - linked transfer_request (if active): status='cancelled',
 *     terminalBy='admin_recovery', terminalReason='handoff_orphan_voided'.
 *   - canonical_jobs (if packetId): append 'closed' event with notes
 *     marking admin void.
 *
 * Does NOT free pendingTicketNumber back to driver block (would
 * conflict with materializer + audit). The slot remains consumed —
 * intentional, matches normal cancel-after-allocation semantics.
 */
async function performVoid(
  invoiceDocId: string,
  callerUid: string,
  callerRole: string,
  reason: string,
  snapshot: InvoiceSnapshot,
): Promise<{ changes: string[]; cancelledTransferRequestId: string | null }> {
  const db = admin.firestore();
  const changes: string[] = [];
  let cancelledRequestId: string | null = null;

  await db.runTransaction(async (tx) => {
    const invRef = db.collection('invoices').doc(invoiceDocId);
    const invSnap = await tx.get(invRef);
    if (!invSnap.exists) {
      throw new httpsV2.HttpsError('not-found', `invoice ${invoiceDocId} disappeared mid-tx`);
    }
    const cur = invSnap.data() as admin.firestore.DocumentData;
    // Re-validate gates under tx — status / driverState may have flipped.
    if (cur.status !== 'open') {
      throw new httpsV2.HttpsError(
        'failed-precondition',
        `invoice status changed to ${cur.status} mid-tx; aborting void`,
      );
    }
    if (!HANDOFF_DRIVER_STATES.has(cur.driverState)) {
      throw new httpsV2.HttpsError(
        'failed-precondition',
        `invoice driverState changed to ${cur.driverState} mid-tx; aborting void`,
      );
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const nowMs = Date.now();
    const timelineEntry = {
      type: 'admin_void_handoff',
      timestamp: nowMs,
      phaseBefore: cur.driverState,
      phaseAfter: 'cancelled',
      adminUid: callerUid,
      adminRole: callerRole,
      reason,
      driver: snapshot.driver,
      driverHash: snapshot.driverHash,
    };

    tx.update(invRef, {
      status: 'cancelled',
      driverState: 'cancelled',
      cancelledAt: now,
      cancelledBy: {
        uid: callerUid,
        role: callerRole,
        action: 'admin_handoff_orphan_voided',
      },
      cancelReason: 'admin_handoff_orphan_voided',
      cancelReasonNotes: reason,
      timeline: admin.firestore.FieldValue.arrayUnion(timelineEntry),
      activeTransferRequestId: null,
      lockedForTransfer: false,
      updatedAt: now,
    });
    changes.push(
      'invoice.status=cancelled',
      'invoice.driverState=cancelled',
      'invoice.cancelReason=admin_handoff_orphan_voided',
      'invoice.timeline+=admin_void_handoff',
    );
  });

  // Linked transfer_request — terminate. Done OUTSIDE the invoice
  // transaction to avoid cross-doc tx complexity; the request is
  // independently transactional.
  const reqDoc = await findActiveTransferRequest(invoiceDocId, snapshot as unknown as admin.firestore.DocumentData);
  if (reqDoc) {
    cancelledRequestId = reqDoc.id;
    try {
      await reqDoc.ref.update({
        status: 'cancelled',
        terminalAt: admin.firestore.FieldValue.serverTimestamp(),
        terminalBy: 'admin_recovery',
        terminalReason: 'handoff_orphan_voided',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      changes.push(`transfer_request.${reqDoc.id}.status=cancelled`);
    } catch (err: unknown) {
      console.warn(
        `[handoff-recovery] failed to cancel transfer_request ${reqDoc.id} (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Canonical event (best-effort)
  if (snapshot.packetId) {
    try {
      await admin
        .firestore()
        .collection('canonical_jobs')
        .doc(snapshot.packetId)
        .update({
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          events: admin.firestore.FieldValue.arrayUnion({
            type: 'closed',
            timestamp: Date.now(),
            actorDriverHash: null,
            actorSource: 'cf',
            notes: 'admin_handoff_orphan_voided',
            extra: {
              invoiceDocId,
              adminUid: callerUid,
              adminRole: callerRole,
              reason: reason.slice(0, 200),
            },
          }),
        });
      changes.push('canonical_jobs.events+=closed (admin_handoff_orphan_voided)');
    } catch (err: unknown) {
      console.warn(
        `[handoff-recovery] canonical patch failed (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { changes, cancelledTransferRequestId: cancelledRequestId };
}

/**
 * Recovery action — restore ownership to the original sender.
 *
 * Effect:
 *   - invoices/{id}: driver=transferredFrom, driverHash=transferredFromHash,
 *     driverState='on_site' (back at pickup; sender chooses how to proceed),
 *     transferSourceDocId=null (no longer a transfer receiver), audit fields
 *     transferredTo/transferredToHash/transferredAt cleared, enRouteDest*
 *     cleared, timeline append 'admin_restore_to_sender'.
 *   - linked transfer_request: status='cancelled', terminalBy='admin_recovery',
 *     terminalReason='handoff_orphan_restored_to_sender'.
 *   - canonical_jobs: append 'transfer_cancelled' event with notes
 *     'admin_restore_to_sender' and ownership rolled back marker.
 *
 * Sender's local AsyncStorage may not know about this immediately.
 * The next HomeScreen focus on the sender's device will surface the
 * invoice via the Firestore-status purge path (b1410e4 logic).
 */
async function performRestoreToSender(
  invoiceDocId: string,
  callerUid: string,
  callerRole: string,
  reason: string,
  snapshot: InvoiceSnapshot,
): Promise<{ changes: string[]; cancelledTransferRequestId: string | null }> {
  if (!snapshot.transferredFrom || !snapshot.transferredFromHash) {
    throw new httpsV2.HttpsError(
      'failed-precondition',
      'invoice missing transferredFrom/transferredFromHash — cannot restore',
    );
  }

  const db = admin.firestore();
  const changes: string[] = [];
  let cancelledRequestId: string | null = null;

  await db.runTransaction(async (tx) => {
    const invRef = db.collection('invoices').doc(invoiceDocId);
    const invSnap = await tx.get(invRef);
    if (!invSnap.exists) {
      throw new httpsV2.HttpsError('not-found', `invoice ${invoiceDocId} disappeared mid-tx`);
    }
    const cur = invSnap.data() as admin.firestore.DocumentData;
    if (cur.status !== 'open') {
      throw new httpsV2.HttpsError(
        'failed-precondition',
        `invoice status changed to ${cur.status} mid-tx; aborting restore`,
      );
    }
    if (!HANDOFF_DRIVER_STATES.has(cur.driverState)) {
      throw new httpsV2.HttpsError(
        'failed-precondition',
        `invoice driverState changed to ${cur.driverState} mid-tx; aborting restore`,
      );
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const nowMs = Date.now();
    const timelineEntry = {
      type: 'admin_restore_to_sender',
      timestamp: nowMs,
      phaseBefore: cur.driverState,
      phaseAfter: 'on_site',
      adminUid: callerUid,
      adminRole: callerRole,
      reason,
      restoredFromDriver: snapshot.driver,
      restoredFromDriverHash: snapshot.driverHash,
      restoredToDriver: snapshot.transferredFrom,
      restoredToDriverHash: snapshot.transferredFromHash,
    };

    tx.update(invRef, {
      driver: snapshot.transferredFrom,
      driverHash: snapshot.transferredFromHash,
      driverState: 'on_site',
      transferSourceDocId: null,
      transferredTo: null,
      transferredToHash: null,
      transferredAt: null,
      // transferredFrom + transferredFromHash retained as historical
      // audit. These are no longer authoritative for current ownership
      // (driver/driverHash above is), but they record that this invoice
      // was once a transfer destination.
      activeTransferRequestId: null,
      lockedForTransfer: false,
      enRouteDestName: null,
      enRouteDestLat: null,
      enRouteDestLng: null,
      timeline: admin.firestore.FieldValue.arrayUnion(timelineEntry),
      updatedAt: now,
    });
    const fromHashPrefix = (snapshot.transferredFromHash || '').slice(0, 8);
    changes.push(
      `invoice.driver=${snapshot.transferredFrom}`,
      `invoice.driverHash=${fromHashPrefix}...`,
      'invoice.driverState=on_site',
      'invoice.transferSourceDocId=null',
      'invoice.enRouteDest*=null',
      'invoice.timeline+=admin_restore_to_sender',
    );
  });

  // Linked transfer_request — terminate.
  const reqDoc = await findActiveTransferRequest(invoiceDocId, snapshot as unknown as admin.firestore.DocumentData);
  if (reqDoc) {
    cancelledRequestId = reqDoc.id;
    try {
      await reqDoc.ref.update({
        status: 'cancelled',
        terminalAt: admin.firestore.FieldValue.serverTimestamp(),
        terminalBy: 'admin_recovery',
        terminalReason: 'handoff_orphan_restored_to_sender',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      changes.push(`transfer_request.${reqDoc.id}.status=cancelled`);
    } catch (err: unknown) {
      console.warn(
        `[handoff-recovery] failed to cancel transfer_request ${reqDoc.id} (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Canonical event
  if (snapshot.packetId) {
    try {
      await admin
        .firestore()
        .collection('canonical_jobs')
        .doc(snapshot.packetId)
        .update({
          driverHash: snapshot.transferredFromHash,
          driverName: snapshot.transferredFrom,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          events: admin.firestore.FieldValue.arrayUnion({
            type: 'transfer_cancelled',
            timestamp: Date.now(),
            actorDriverHash: null,
            actorSource: 'cf',
            notes: 'admin_restore_to_sender',
            extra: {
              invoiceDocId,
              adminUid: callerUid,
              adminRole: callerRole,
              reason: reason.slice(0, 200),
              restoredToDriverHash: snapshot.transferredFromHash,
            },
          }),
        });
      changes.push('canonical_jobs.events+=transfer_cancelled (admin_restore_to_sender)');
    } catch (err: unknown) {
      console.warn(
        `[handoff-recovery] canonical patch failed (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { changes, cancelledTransferRequestId: cancelledRequestId };
}

/**
 * Admin recovery callable.
 *
 * Input:
 *   { invoiceDocId: string, action: 'report'|'void'|'restore_to_sender', reason: string }
 *
 * - action='report' returns a snapshot only. No writes. reason ignored.
 * - action='void' marks the invoice as cancelled. reason required (non-empty,
 *   capped 500 chars).
 * - action='restore_to_sender' rolls ownership back to the original sender.
 *   reason required.
 *
 * Auth: signed-in dashboard user with manageDrivers capability.
 *
 * Returns RecoveryResponse with the pre-change snapshot, the changes
 * performed, and the audit log doc id.
 */
export const recoverHandoffOrphan = httpsV2.onCall(
  { timeoutSeconds: 60, memory: '256MiB' },
  async (request): Promise<RecoveryResponse> => {
    const auth = request.auth;
    if (!auth?.uid) {
      throw new httpsV2.HttpsError('unauthenticated', 'Must be signed in');
    }

    const { invoiceDocId, action, reason } = (request.data || {}) as RecoveryInput;
    if (!invoiceDocId || typeof invoiceDocId !== 'string') {
      throw new httpsV2.HttpsError('invalid-argument', 'invoiceDocId required');
    }
    if (!action || !['report', 'void', 'restore_to_sender'].includes(action)) {
      throw new httpsV2.HttpsError(
        'invalid-argument',
        "action must be one of: 'report', 'void', 'restore_to_sender'",
      );
    }
    if ((action === 'void' || action === 'restore_to_sender')) {
      if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
        throw new httpsV2.HttpsError(
          'invalid-argument',
          'reason required for void / restore_to_sender (audit trail)',
        );
      }
      if (reason.length > 500) {
        throw new httpsV2.HttpsError('invalid-argument', 'reason must be <= 500 chars');
      }
    }
    const cleanReason = (reason || '').trim().slice(0, 500);

    // Capability check
    const { requireAdminAuthority } = await import('./security/adminAuth');
    const { authorizeTargetCompany } = await import('./security/canonicalAdminAuthority');
    const authority = await requireAdminAuthority(
      auth.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const cap = await callerHasCapability(auth.uid, REQUIRED_CAPABILITY);
    if (!cap.ok) {
      throw new httpsV2.HttpsError(
        'permission-denied',
        `caller missing ${REQUIRED_CAPABILITY} (reason=${cap.reason})`,
      );
    }
    const callerRole = cap.callerRole || 'unknown';

    // Load invoice + snapshot
    const invSnap = await admin.firestore().collection('invoices').doc(invoiceDocId).get();
    if (!invSnap.exists) {
      throw new httpsV2.HttpsError('not-found', `invoice ${invoiceDocId} not found`);
    }
    const data = invSnap.data() as admin.firestore.DocumentData;
    const invCompany = typeof data.companyId === 'string' ? data.companyId : null;
    const own = authorizeTargetCompany({
      authority,
      targetCompanyId: invCompany,
    });
    if (!own.ok) {
      throw new httpsV2.HttpsError('permission-denied', own.reason);
    }
    const snapshot = buildSnapshot(invoiceDocId, data);

    if (action === 'report') {
      // Read-only — no writes, no audit log
      return {
        action: 'report',
        invoiceDocId,
        performed: false,
        snapshot,
        changes: [],
        auditLogId: null,
        cancelledTransferRequestId: null,
      };
    }

    if (!snapshot.qualifiesForRecovery) {
      throw new httpsV2.HttpsError(
        'failed-precondition',
        `invoice does not qualify for recovery: ${snapshot.reasonNotQualified}`,
      );
    }

    let changes: string[] = [];
    let cancelledTransferRequestId: string | null = null;

    if (action === 'void') {
      const r = await performVoid(invoiceDocId, auth.uid, callerRole, cleanReason, snapshot);
      changes = r.changes;
      cancelledTransferRequestId = r.cancelledTransferRequestId;
    } else if (action === 'restore_to_sender') {
      const r = await performRestoreToSender(
        invoiceDocId,
        auth.uid,
        callerRole,
        cleanReason,
        snapshot,
      );
      changes = r.changes;
      cancelledTransferRequestId = r.cancelledTransferRequestId;
    }

    const auditLogId = await writeAuditLog(
      auth.uid,
      callerRole,
      action,
      cleanReason,
      snapshot,
      changes,
      cancelledTransferRequestId,
    );

    // Observability — surface in /admin/diagnostics
    await logCanonicalDiag({
      level: 'info',
      event: `handoff_recovery.${action}`,
      source: 'cf',
      reason: cleanReason.slice(0, 200) || null,
      payload: {
        invoiceDocId,
        callerUid: auth.uid,
        callerRole,
        changes: changes.join('; '),
        cancelledTransferRequestId,
        auditLogId,
        priorDriverState: snapshot.driverState,
        priorDriver: snapshot.driver,
        priorDriverHashPrefix: (snapshot.driverHash || '').slice(0, 8),
      },
    });

    console.log(
      `[handoff-recovery] ${action} by ${auth.uid} (${callerRole}) on invoice=${invoiceDocId} ` +
      `audit=${auditLogId} request=${cancelledTransferRequestId || 'none'}`,
    );

    return {
      action,
      invoiceDocId,
      performed: true,
      snapshot,
      changes,
      auditLogId,
      cancelledTransferRequestId,
    };
  },
);

/**
 * Companion list-callable — returns stuck handoff candidates for a
 * dashboard UI to show in a "Stuck Handoffs" panel. Read-only, no
 * recovery actions. Caller must have viewAdmin capability.
 *
 * "Stuck" = invoice with status='open' AND driverState in handoff set
 * AND updatedAt < now - thresholdMinutes (default 30 min).
 */
export const listStuckHandoffs = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    const auth = request.auth;
    if (!auth?.uid) {
      throw new httpsV2.HttpsError('unauthenticated', 'Must be signed in');
    }
    const { requireAdminAuthority } = await import('./security/adminAuth');
    const authority = await requireAdminAuthority(
      auth.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const cap = await callerHasCapability(auth.uid, 'viewAdmin');
    if (!cap.ok) {
      throw new httpsV2.HttpsError('permission-denied', `caller missing viewAdmin`);
    }

    const { thresholdMinutes = 30, limit = 50 } = (request.data || {}) as {
      thresholdMinutes?: number;
      limit?: number;
    };
    const cutoffMs = Date.now() - thresholdMinutes * 60 * 1000;
    const cutoffTs = admin.firestore.Timestamp.fromMillis(cutoffMs);

    // Query single-inequality on updatedAt; filter handoff states client-side.
    const snap = await admin
      .firestore()
      .collection('invoices')
      .where('status', '==', 'open')
      .where('updatedAt', '<=', cutoffTs)
      .orderBy('updatedAt', 'asc')
      .limit(Math.min(limit, 200))
      .get();

    const candidates: InvoiceSnapshot[] = [];
    for (const doc of snap.docs) {
      const data = doc.data();
      if (authority.class === 'company_staff') {
        if (data.companyId !== authority.companyId) continue;
      }
      const driverState = (data.driverState as string) || '';
      if (!HANDOFF_DRIVER_STATES.has(driverState)) continue;
      candidates.push(buildSnapshot(doc.id, data));
    }
    return {
      thresholdMinutes,
      generatedAt: new Date().toISOString(),
      candidates,
    };
  },
);
