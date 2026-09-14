/**
 * Governed transfer request callable.
 * Atomically creates a transfer_requests document and locks the source invoice
 * in a single Firestore transaction, preventing orphan locks and unlinked requests.
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
  fromDriverHash: string;
  fromDriverName: string;
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
    const data = (request.data || {}) as CreateDriverTransferRequestInput;
    const sourceInvoiceDocId = String(data.sourceInvoiceDocId || '').trim();
    if (!sourceInvoiceDocId) {
      throw new httpsV2.HttpsError('invalid-argument', 'sourceInvoiceDocId is required');
    }
    if (data.mode === 'direct' && !data.toDriverHash) {
      throw new httpsV2.HttpsError('invalid-argument', 'toDriverHash is required for direct mode');
    }

    const driver = await requireSecureDriver(request, {
      allowLegacyHash: true,
      legacyDriverHash: data.fromDriverHash,
    });

    const db = admin.firestore();
    const invoiceRef = db.collection('invoices').doc(sourceInvoiceDocId);
    const requestId = data.requestId?.trim() || db.collection('transfer_requests').doc().id;
    const requestRef = db.collection('transfer_requests').doc(requestId);

    const ttlHours = 4;
    const ttlExpiresAt = Timestamp.fromMillis(Date.now() + ttlHours * 60 * 60 * 1000);

    const result = await db.runTransaction(async (tx) => {
      const invSnap = await tx.get(invoiceRef);
      if (!invSnap.exists) {
        throw new httpsV2.HttpsError('not-found', `Source invoice ${sourceInvoiceDocId} not found`);
      }
      const invData = invSnap.data() || {};
      const owner =
        invData.driverId === driver.driverId ||
        invData.driverHash === data.fromDriverHash ||
        invData.driverHash === driver.driverId;
      if (!owner && invData.driverId) {
        throw new httpsV2.HttpsError('permission-denied', 'Invoice owned by another driver');
      }
      if (driver.companyId && invData.companyId && invData.companyId !== driver.companyId) {
        throw new httpsV2.HttpsError('permission-denied', 'Cross-company invoice transfer');
      }

      const status = String(invData.status || '').toLowerCase();
      if (TERMINAL_STATUSES.has(status)) {
        throw new httpsV2.HttpsError('failed-precondition', 'Cannot transfer terminal invoice');
      }
      if (invData.lockedForTransfer) {
        throw new httpsV2.HttpsError('failed-precondition', 'Invoice already locked for transfer');
      }

      // Check if request already exists (idempotency)
      const reqSnap = await tx.get(requestRef);
      if (reqSnap.exists) {
        return { ok: true, requestId, alreadyExisted: true };
      }

      // 1. Create transfer_requests doc
      const newRequestDoc: Record<string, any> = {
        id: requestId,
        sourceInvoiceDocId,
        sourceDispatchId: data.sourceDispatchId || invData.dispatchId || null,
        sourceMultiHaulId: data.sourceMultiHaulId || invData.haulGroupId || null,
        sourceTicketDocIds: data.sourceTicketDocIds || invData.tickets || [],
        fromDriverHash: data.fromDriverHash || driver.driverId,
        fromDriverName: data.fromDriverName || driver.driverId,
        fromGpsLat: data.fromGpsLat ?? null,
        fromGpsLng: data.fromGpsLng ?? null,
        fromGpsCapturedAt: new Date().toISOString(),
        toDriverHash: data.toDriverHash || null,
        toDriverName: data.toDriverName || null,
        mode: data.mode || 'direct',
        status: 'pending',
        reason: (data.reason || '').slice(0, 200),
        handoff: {
          destinationName: `${data.fromDriverName || 'Driver'} Location`,
          destinationLat: data.fromGpsLat ?? null,
          destinationLng: data.fromGpsLng ?? null,
          refreshedAt: null,
        },
        wellName: data.wellName || invData.wellName || '',
        operator: data.operator || invData.operator || '',
        totalBBL: data.totalBBL ?? invData.totalBBL ?? 0,
        companyId: driver.companyId || invData.companyId || null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        terminalAt: null,
        terminalBy: null,
        terminalReason: null,
        ttlExpiresAt,
        sourcePacketId: data.sourcePacketId || invData.packetId || null,
        canonicalJobId: data.canonicalJobId || invData.canonicalJobId || null,
        sourceInvoicingMode: data.sourceInvoicingMode || invData.invoicingMode || null,
        sourceTicketNumber: data.sourceTicketNumber || invData.ticketNumber || null,
      };

      tx.set(requestRef, newRequestDoc);

      // 2. Atomically lock source invoice
      tx.update(invoiceRef, {
        activeTransferRequestId: requestId,
        lockedForTransfer: true,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return { ok: true, requestId, alreadyExisted: false };
    });

    await writeSecurityAudit({
      action: 'createDriverTransferRequest',
      actorUid: driver.uid,
      driverId: driver.driverId,
      detail: { requestId, sourceInvoiceDocId },
    });

    return result;
  },
);
