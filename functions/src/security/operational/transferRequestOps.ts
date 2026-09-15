/**
 * Governed transfer request operational callables.
 * - createDriverTransferRequest: Atomically creates a transfer_requests document and locks the source invoice.
 * - resolveTransferRequest: Governed cancellation/decline, atomically clearing invoice locks.
 * - acceptTransferRequest: Governed acceptance, atomically transferring invoice and dispatch ownership to Driver B.
 *
 * App Check: enforceAppCheck is set to false in accordance with the centralized
 * mobile driver migration plan (see functions/src/admin/APP-CHECK-READINESS.md and
 * ssoCallables.ts). Once App Check debug tokens and attestation are activated in
 * production, this is flipped centrally across all driver operational endpoints.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { requireSecureDriver } from '../requireDriverAuth';
import { writeSecurityAudit } from '../audit';

const TERMINAL_STATUSES = new Set([
  'closed',
  'complete',
  'completed',
  'cancelled',
  'canceled',
  'void',
]);

export interface CreateDriverTransferRequestInput {
  requestId?: string;
  sourceInvoiceDocId: string;
  sourceDispatchId?: string | null;
  sourceMultiHaulId?: string | null;
  sourceTicketDocIds?: string[];
  fromDriverHash?: string;
  fromDriverName?: string;
  fromGpsLat?: number;
  fromGpsLng?: number;
  toDriverHash?: string | null;
  toDriverName?: string | null;
  mode: 'direct' | 'approval';
  reason?: string;
  wellName?: string;
  operator?: string;
  totalBBL?: number;
  sourcePacketId?: string | null;
  canonicalJobId?: string | null;
  sourceInvoicingMode?: string | null;
  sourceTicketNumber?: number | string | null;
}

export const createDriverTransferRequest = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    // 1. Verified server authentication ONLY
    const driver = await requireSecureDriver(request, { allowLegacyHash: false });
    if (!driver.driverId) {
      throw new httpsV2.HttpsError('unauthenticated', 'Driver authentication required');
    }
    if (!driver.companyId) {
      throw new httpsV2.HttpsError('permission-denied', 'Driver company affiliation required');
    }

    const data = (request.data || {}) as CreateDriverTransferRequestInput;

    // 2. Verified identity: client fromDriverHash cannot establish ownership or forge identity
    if (data.fromDriverHash && String(data.fromDriverHash).trim() !== driver.driverId) {
      throw new httpsV2.HttpsError('permission-denied', 'Actor identity mismatch: forged fromDriverHash');
    }

    // 3. Validate sourceInvoiceDocId
    const sourceInvoiceDocId = String(data.sourceInvoiceDocId || '').trim();
    if (!sourceInvoiceDocId) {
      throw new httpsV2.HttpsError('invalid-argument', 'sourceInvoiceDocId is required');
    }

    // 4. Validate requestId (if supplied by caller)
    let requestId = '';
    if (data.requestId !== undefined && data.requestId !== null) {
      const rawReqId = String(data.requestId).trim();
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(rawReqId)) {
        throw new httpsV2.HttpsError('invalid-argument', 'Invalid requestId format');
      }
      requestId = rawReqId;
    }

    // 5. Runtime-validate mode
    const mode = String(data.mode || '').trim().toLowerCase();
    if (mode !== 'direct' && mode !== 'approval') {
      throw new httpsV2.HttpsError('invalid-argument', 'mode must be "direct" or "approval"');
    }

    // 6. Direct-transfer target resolved server-side: must be active and in same company
    let targetDriverId: string | null = null;
    let targetDriverName: string | null = null;
    const db = admin.firestore();
    const rtdb = admin.database();

    if (mode === 'direct') {
      const rawToHash = String(data.toDriverHash || '').trim();
      if (!rawToHash) {
        throw new httpsV2.HttpsError('invalid-argument', 'toDriverHash is required for direct mode');
      }
      if (rawToHash === driver.driverId) {
        throw new httpsV2.HttpsError('invalid-argument', 'Cannot transfer invoice to yourself');
      }

      // Resolve target driver server-side
      let targetProfile = await rtdb.ref(`drivers/profiles/${rawToHash}`).once('value');
      let targetVal = targetProfile.exists() ? targetProfile.val() : null;
      if (!targetVal) {
        const approvedSnap = await rtdb.ref(`drivers/approved/${rawToHash}`).once('value');
        if (approvedSnap.exists()) {
          targetVal = approvedSnap.val();
        }
      }

      if (!targetVal) {
        throw new httpsV2.HttpsError('not-found', 'Target driver not found');
      }
      if (targetVal.active === false) {
        throw new httpsV2.HttpsError('permission-denied', 'Target driver is inactive');
      }
      if (!targetVal.companyId || targetVal.companyId !== driver.companyId) {
        throw new httpsV2.HttpsError('permission-denied', 'Cross-company target driver');
      }

      targetDriverId = rawToHash;
      targetDriverName = targetVal.displayName || targetVal.driverName || rawToHash;
    }

    if (!requestId) {
      requestId = db.collection('transfer_requests').doc().id;
    }

    const invoiceRef = db.collection('invoices').doc(sourceInvoiceDocId);
    const requestRef = db.collection('transfer_requests').doc(requestId);

    const ttlHours = 4;
    const ttlExpiresAt = Timestamp.fromMillis(Date.now() + ttlHours * 60 * 60 * 1000);

    const result = await db.runTransaction(async (tx) => {
      // Check if request already exists (idempotency key)
      const reqSnap = await tx.get(requestRef);
      if (reqSnap.exists) {
        const existing = reqSnap.data() || {};
        const matches =
          existing.sourceInvoiceDocId === sourceInvoiceDocId &&
          existing.fromDriverHash === driver.driverId &&
          existing.companyId === driver.companyId &&
          existing.mode === mode &&
          (mode === 'approval' || existing.toDriverHash === targetDriverId);

        if (matches) {
          return { ok: true, requestId, alreadyExisted: true };
        } else {
          throw new httpsV2.HttpsError(
            'already-exists',
            'Transfer request already exists with conflicting parameters',
          );
        }
      }

      const invSnap = await tx.get(invoiceRef);
      if (!invSnap.exists) {
        throw new httpsV2.HttpsError('not-found', `Source invoice ${sourceInvoiceDocId} not found`);
      }
      const invData = invSnap.data() || {};

      // Positive source-invoice ownership required. Missing or ambiguous fails closed.
      const invDriverId = invData.driverId ? String(invData.driverId).trim() : null;
      const invDriverHash = invData.driverHash ? String(invData.driverHash).trim() : null;

      if (!invDriverId && !invDriverHash) {
        throw new httpsV2.HttpsError(
          'permission-denied',
          'Positive source-invoice ownership required (missing owner)',
        );
      }
      if (invDriverId && invDriverHash && invDriverId !== invDriverHash) {
        throw new httpsV2.HttpsError(
          'permission-denied',
          'Ambiguous source-invoice ownership',
        );
      }

      const invoiceOwner = invDriverId || invDriverHash;
      if (invoiceOwner !== driver.driverId) {
        throw new httpsV2.HttpsError('permission-denied', 'Invoice owned by another driver');
      }

      // Invoice company must positively match authenticated company
      if (!invData.companyId || invData.companyId !== driver.companyId) {
        throw new httpsV2.HttpsError('permission-denied', 'Cross-company invoice transfer');
      }

      // Terminal invoice check
      const status = String(invData.status || '').toLowerCase().trim();
      if (TERMINAL_STATUSES.has(status)) {
        throw new httpsV2.HttpsError('failed-precondition', 'Cannot transfer terminal invoice');
      }

      // Already locked check
      if (invData.lockedForTransfer || invData.activeTransferRequestId) {
        throw new httpsV2.HttpsError('failed-precondition', 'Invoice already locked for transfer');
      }

      // Server-derived canonical fields (caller cannot spoof)
      const newRequestDoc: Record<string, any> = {
        id: requestId,
        sourceInvoiceDocId,
        sourceDispatchId: invData.dispatchId || null,
        sourceMultiHaulId: invData.haulGroupId || null,
        sourceTicketDocIds: Array.isArray(invData.tickets) ? invData.tickets : [],
        fromDriverHash: driver.driverId,
        fromDriverName: driver.displayName || driver.driverId,
        fromGpsLat: typeof data.fromGpsLat === 'number' ? data.fromGpsLat : null,
        fromGpsLng: typeof data.fromGpsLng === 'number' ? data.fromGpsLng : null,
        fromGpsCapturedAt: new Date().toISOString(),
        toDriverHash: targetDriverId,
        toDriverName: targetDriverName,
        mode,
        status: 'pending',
        reason: String(data.reason || '').slice(0, 200),
        handoff: {
          destinationName: `${driver.displayName || 'Driver'} Location`,
          destinationLat: typeof data.fromGpsLat === 'number' ? data.fromGpsLat : null,
          destinationLng: typeof data.fromGpsLng === 'number' ? data.fromGpsLng : null,
          refreshedAt: null,
        },
        wellName: invData.wellName || '',
        operator: invData.operator || '',
        totalBBL: typeof invData.totalBBL === 'number' ? invData.totalBBL : (invData.bbls ?? 0),
        companyId: driver.companyId,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        terminalAt: null,
        terminalBy: null,
        terminalReason: null,
        ttlExpiresAt,
        sourcePacketId: invData.packetId || null,
        canonicalJobId: invData.canonicalJobId || null,
        sourceInvoicingMode: invData.invoicingMode || null,
        sourceTicketNumber: invData.ticketNumber || null,
      };

      tx.set(requestRef, newRequestDoc);

      tx.update(invoiceRef, {
        activeTransferRequestId: requestId,
        lockedForTransfer: true,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return { ok: true, requestId, alreadyExisted: false };
    });

    try {
      await writeSecurityAudit({
        action: 'createDriverTransferRequest',
        actorUid: driver.uid,
        driverId: driver.driverId,
        detail: { requestId, sourceInvoiceDocId },
      });
    } catch (auditErr) {
      console.warn('[transferRequestOps] Audit write failed (non-fatal):', auditErr);
    }

    return result;
  },
);

export interface ResolveTransferRequestInput {
  requestId: string;
  action: 'cancel' | 'decline' | 'expire';
  actorHash?: string;
  reason?: string;
}

export const resolveTransferRequest = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const driver = await requireSecureDriver(request, { allowLegacyHash: false });
    const data = (request.data || {}) as ResolveTransferRequestInput;
    const requestId = String(data.requestId || '').trim();
    const action = String(data.action || '').trim().toLowerCase() as 'cancel' | 'decline' | 'expire';
    const reason = String(data.reason || '').slice(0, 200);

    if (!requestId) {
      throw new httpsV2.HttpsError('invalid-argument', 'requestId is required');
    }
    if (!['cancel', 'decline', 'expire'].includes(action)) {
      throw new httpsV2.HttpsError('invalid-argument', `action must be cancel, decline, or expire (got: ${action})`);
    }

    const db = admin.firestore();
    const requestRef = db.collection('transfer_requests').doc(requestId);

    const result = await db.runTransaction(async (tx) => {
      // 1. ALL READS FIRST
      const reqSnap = await tx.get(requestRef);
      if (!reqSnap.exists) {
        throw new httpsV2.HttpsError('not-found', `Transfer request ${requestId} not found`);
      }
      const reqData = reqSnap.data() || {};

      const invRef = reqData.sourceInvoiceDocId ? db.collection('invoices').doc(reqData.sourceInvoiceDocId) : null;
      const invSnap = invRef ? await tx.get(invRef) : null;

      const terminalStatus = action === 'decline' ? 'declined' : action === 'cancel' ? 'cancelled' : 'expired';

      // Idempotent: if already terminal, ensure source invoice lock is cleared
      if (reqData.status !== 'pending') {
        if (invRef && invSnap && invSnap.exists && invSnap.data()?.activeTransferRequestId === requestId) {
          tx.update(invRef, {
            activeTransferRequestId: FieldValue.delete(),
            lockedForTransfer: false,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        return { ok: true, alreadyTerminal: true, status: reqData.status };
      }

      // Authorization gates:
      // cancel: must be sender
      if (action === 'cancel' && reqData.fromDriverHash !== driver.driverId) {
        throw new httpsV2.HttpsError('permission-denied', 'Only sender can cancel this transfer request');
      }
      // decline: must be recipient (for direct mode)
      if (action === 'decline' && reqData.mode === 'direct' && reqData.toDriverHash !== driver.driverId) {
        throw new httpsV2.HttpsError('permission-denied', 'Only requested recipient can decline this transfer');
      }

      // 2. WRITES
      tx.update(requestRef, {
        status: terminalStatus,
        terminalAt: FieldValue.serverTimestamp(),
        terminalBy: driver.driverId,
        terminalReason: reason || null,
        updatedAt: FieldValue.serverTimestamp(),
      });

      if (invRef && invSnap && invSnap.exists) {
        tx.update(invRef, {
          activeTransferRequestId: FieldValue.delete(),
          lockedForTransfer: false,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      return { ok: true, status: terminalStatus, sourceInvoiceDocId: reqData.sourceInvoiceDocId };
    });

    try {
      await writeSecurityAudit({
        action: `resolveTransferRequest_${action}`,
        actorUid: driver.uid,
        driverId: driver.driverId,
        detail: { requestId, action, status: result.status },
      });
    } catch (auditErr) {
      console.warn('[transferRequestOps] Audit write failed (non-fatal):', auditErr);
    }

    return result;
  },
);

export interface AcceptTransferRequestInput {
  requestId: string;
  acceptGpsLat?: number;
  acceptGpsLng?: number;
  truckNumber?: string;
  trailer?: string;
}

export const acceptTransferRequest = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const driver = await requireSecureDriver(request, { allowLegacyHash: false });
    const data = (request.data || {}) as AcceptTransferRequestInput;
    const requestId = String(data.requestId || '').trim();

    if (!requestId) {
      throw new httpsV2.HttpsError('invalid-argument', 'requestId is required');
    }

    const db = admin.firestore();
    const requestRef = db.collection('transfer_requests').doc(requestId);

    const result = await db.runTransaction(async (tx) => {
      // 1. ALL READS FIRST (Firestore requires all reads before any writes)
      const reqSnap = await tx.get(requestRef);
      if (!reqSnap.exists) {
        throw new httpsV2.HttpsError('not-found', `Transfer request ${requestId} not found`);
      }
      const reqData = reqSnap.data() || {};

      const invRef = db.collection('invoices').doc(reqData.sourceInvoiceDocId);
      const invSnap = await tx.get(invRef);
      if (!invSnap.exists) {
        throw new httpsV2.HttpsError('not-found', `Source invoice ${reqData.sourceInvoiceDocId} not found`);
      }
      const invData = invSnap.data() || {};

      const dispRef = reqData.sourceDispatchId ? db.collection('dispatches').doc(reqData.sourceDispatchId) : null;
      const dispSnap = dispRef ? await tx.get(dispRef) : null;

      // 2. VALIDATION
      if (reqData.status !== 'pending') {
        throw new httpsV2.HttpsError('failed-precondition', `Transfer request is not pending (status: ${reqData.status})`);
      }

      // Direct mode: receiver must match toDriverHash
      if (reqData.mode === 'direct' && reqData.toDriverHash !== driver.driverId) {
        throw new httpsV2.HttpsError('permission-denied', 'Only requested recipient can accept this transfer');
      }
      // Company match
      if (reqData.companyId && reqData.companyId !== driver.companyId) {
        throw new httpsV2.HttpsError('permission-denied', 'Cross-company transfer accept denied');
      }

      if (!invData.lockedForTransfer || invData.activeTransferRequestId !== requestId) {
        throw new httpsV2.HttpsError('failed-precondition', 'Invoice is not locked for this transfer request');
      }

      const receiverName = driver.displayName || driver.driverId;
      const handoffStartEvent = {
        type: 'handoff_pickup_start',
        timestamp: new Date().toISOString(),
        lat: typeof data.acceptGpsLat === 'number' ? data.acceptGpsLat : null,
        lng: typeof data.acceptGpsLng === 'number' ? data.acceptGpsLng : null,
        source: 'cf',
        locationName: reqData.handoff?.destinationName || `${reqData.fromDriverName} Location`,
        leg: invData.currentLeg || 1,
        notes: `Transfer accepted; receiver heading to handoff with ${reqData.fromDriverName}`,
      };

      const updatedTimeline = [...(invData.timeline || []), handoffStartEvent];

      // 3. WRITES (Only after all reads have completed)
      // 3a. Reassign source invoice to receiver
      tx.update(invRef, {
        driver: receiverName,
        driverId: driver.driverId,
        driverHash: driver.driverId,
        driverLoginName: receiverName,
        ...(data.truckNumber ? { truckNumber: data.truckNumber } : {}),
        ...(data.trailer ? { trailer: data.trailer } : {}),
        timeline: updatedTimeline,
        driverState: 'en_route_handoff',
        enRouteDestName: reqData.handoff?.destinationName || `${reqData.fromDriverName} Location`,
        enRouteDestLat: reqData.handoff?.destinationLat ?? null,
        enRouteDestLng: reqData.handoff?.destinationLng ?? null,
        activeTransferRequestId: FieldValue.delete(),
        lockedForTransfer: false,
        transferAcceptedAt: FieldValue.serverTimestamp(),
        transferAcceptedBy: driver.driverId,
        transferSourceDocId: reqData.sourceInvoiceDocId,
        updatedAt: FieldValue.serverTimestamp(),
      });

      // 3b. Transfer dispatch or create target dispatch
      if (dispRef && dispSnap) {
        if (dispSnap.exists) {
          tx.update(dispRef, {
            driverId: driver.driverId,
            driverHash: driver.driverId,
            driverName: receiverName,
            transferredFromHash: reqData.fromDriverHash,
            transferredFrom: reqData.fromDriverName,
            transferAcceptedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        } else {
          tx.set(dispRef, {
            id: reqData.sourceDispatchId,
            driverId: driver.driverId,
            driverHash: driver.driverId,
            driverName: receiverName,
            status: 'assigned',
            wellName: reqData.wellName,
            operator: reqData.operator,
            companyId: driver.companyId,
            transferredFromHash: reqData.fromDriverHash,
            transferredFrom: reqData.fromDriverName,
            transferAcceptedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      } else {
        const newDispRef = db.collection('dispatches').doc();
        tx.set(newDispRef, {
          id: newDispRef.id,
          driverId: driver.driverId,
          driverHash: driver.driverId,
          driverName: receiverName,
          status: 'assigned',
          wellName: reqData.wellName,
          operator: reqData.operator,
          companyId: driver.companyId,
          transferredFromHash: reqData.fromDriverHash,
          transferredFrom: reqData.fromDriverName,
          transferRequestId: requestId,
          sourceInvoiceDocId: reqData.sourceInvoiceDocId,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      // 3c. Mark transfer request accepted
      tx.update(requestRef, {
        status: 'accepted',
        terminalAt: FieldValue.serverTimestamp(),
        terminalBy: driver.driverId,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        ok: true,
        requestId,
        sourceInvoiceDocId: reqData.sourceInvoiceDocId,
        handoffName: reqData.handoff?.destinationName,
        handoffLat: reqData.handoff?.destinationLat,
        handoffLng: reqData.handoff?.destinationLng,
      };
    });

    try {
      await writeSecurityAudit({
        action: 'acceptTransferRequest',
        actorUid: driver.uid,
        driverId: driver.driverId,
        detail: { requestId, sourceInvoiceDocId: result.sourceInvoiceDocId },
      });
    } catch (auditErr) {
      console.warn('[transferRequestOps] Audit write failed (non-fatal):', auditErr);
    }

    return result;
  },
);
