/**
 * Governed transfer request operational callables.
 * - createDriverTransferRequest: Atomically creates a transfer_requests document and locks the source invoice.
 * - resolveTransferRequest: Governed cancellation/decline/expiry, atomically clearing invoice locks.
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
import { BINDING_BY_DRIVER, BINDING_BY_APPROVED } from './identityBinding';

const TERMINAL_STATUSES = new Set([
  'closed',
  'complete',
  'completed',
  'cancelled',
  'canceled',
  'void',
]);

/**
 * Resolves all known alias identifiers for a driver (UUID and approved key).
 */
async function resolveDriverAliases(id: string, rtdb: admin.database.Database): Promise<Set<string>> {
  const aliases = new Set<string>();
  if (!id) return aliases;
  const cleanId = String(id).trim();
  if (!cleanId) return aliases;
  aliases.add(cleanId);

  try {
    const [byDriverSnap, byApprovedSnap, approvedSnap] = await Promise.all([
      rtdb.ref(BINDING_BY_DRIVER(cleanId)).once('value'),
      rtdb.ref(BINDING_BY_APPROVED(cleanId)).once('value'),
      rtdb.ref(`drivers/approved/${cleanId}`).once('value'),
    ]);

    const byDriverVal = byDriverSnap.val();
    if (byDriverVal?.approvedKey) aliases.add(String(byDriverVal.approvedKey).trim());

    const byApprovedVal = byApprovedSnap.val();
    if (byApprovedVal?.driverId) aliases.add(String(byApprovedVal.driverId).trim());

    const approvedVal = approvedSnap.val();
    if (approvedVal?.migratedToDriverId) aliases.add(String(approvedVal.migratedToDriverId).trim());

    // Recursively resolve any newly discovered aliases
    for (const alias of Array.from(aliases)) {
      if (alias !== cleanId) {
        const [subByDriver, subByApproved, subApproved] = await Promise.all([
          rtdb.ref(BINDING_BY_DRIVER(alias)).once('value'),
          rtdb.ref(BINDING_BY_APPROVED(alias)).once('value'),
          rtdb.ref(`drivers/approved/${alias}`).once('value'),
        ]);
        if (subByDriver.val()?.approvedKey) aliases.add(String(subByDriver.val().approvedKey).trim());
        if (subByApproved.val()?.driverId) aliases.add(String(subByApproved.val().driverId).trim());
        if (subApproved.val()?.migratedToDriverId) aliases.add(String(subApproved.val().migratedToDriverId).trim());
      }
    }
  } catch (err) {
    console.warn('[transferRequestOps] Error resolving driver aliases:', err);
  }

  return aliases;
}

/**
 * Positive source-invoice ownership verification supporting legitimate legacy aliases.
 */
function verifySourceInvoiceOwnership(
  invData: Record<string, any>,
  callerAliases: Set<string>,
): void {
  const invDriverId = invData.driverId ? String(invData.driverId).trim() : null;
  const invDriverHash = invData.driverHash ? String(invData.driverHash).trim() : null;

  if (!invDriverId && !invDriverHash) {
    throw new httpsV2.HttpsError(
      'permission-denied',
      'Positive source-invoice ownership required (missing owner)',
    );
  }

  if (invDriverId && invDriverHash && invDriverId !== invDriverHash) {
    const idMatchesCaller = callerAliases.has(invDriverId);
    const hashMatchesCaller = callerAliases.has(invDriverHash);

    if (!idMatchesCaller && !hashMatchesCaller) {
      throw new httpsV2.HttpsError('permission-denied', 'Invoice owned by another driver');
    }

    if (!idMatchesCaller || !hashMatchesCaller) {
      throw new httpsV2.HttpsError(
        'permission-denied',
        'Ambiguous source-invoice ownership',
      );
    }
  } else {
    const owner = invDriverId || invDriverHash;
    if (!owner || !callerAliases.has(owner)) {
      throw new httpsV2.HttpsError('permission-denied', 'Invoice owned by another driver');
    }
  }
}

/**
 * Resolves target driver server-side to canonical identity.
 */
async function resolveTargetDriver(
  rawTarget: string,
  callerCompanyId: string,
  callerAliases: Set<string>,
  rtdb: admin.database.Database,
): Promise<{ driverId: string; driverHash: string; displayName: string }> {
  const targetAliases = await resolveDriverAliases(rawTarget, rtdb);

  for (const alias of Array.from(callerAliases)) {
    if (targetAliases.has(alias)) {
      throw new httpsV2.HttpsError('invalid-argument', 'Cannot transfer invoice to yourself');
    }
  }

  let targetVal: any = null;
  let canonicalDriverId = rawTarget;
  let canonicalDriverHash = rawTarget;

  const profileSnap = await rtdb.ref(`drivers/profiles/${rawTarget}`).once('value');
  if (profileSnap.exists()) {
    targetVal = profileSnap.val();
  }

  const approvedSnap = await rtdb.ref(`drivers/approved/${rawTarget}`).once('value');
  if (approvedSnap.exists()) {
    const appVal = approvedSnap.val();
    if (!targetVal) targetVal = appVal;
    if (appVal.migratedToDriverId) {
      canonicalDriverId = String(appVal.migratedToDriverId).trim();
    }
  }

  const [byDriverSnap, byApprovedSnap] = await Promise.all([
    rtdb.ref(BINDING_BY_DRIVER(rawTarget)).once('value'),
    rtdb.ref(BINDING_BY_APPROVED(rawTarget)).once('value'),
  ]);

  if (byDriverSnap.exists()) {
    const bd = byDriverSnap.val();
    if (bd?.approvedKey) canonicalDriverHash = String(bd.approvedKey).trim();
  }
  if (byApprovedSnap.exists()) {
    const ba = byApprovedSnap.val();
    if (ba?.driverId) canonicalDriverId = String(ba.driverId).trim();
  }

  if (!targetVal) {
    for (const alias of Array.from(targetAliases)) {
      if (alias !== rawTarget) {
        const prof = await rtdb.ref(`drivers/profiles/${alias}`).once('value');
        if (prof.exists()) {
          targetVal = prof.val();
          break;
        }
        const app = await rtdb.ref(`drivers/approved/${alias}`).once('value');
        if (app.exists()) {
          targetVal = app.val();
          break;
        }
      }
    }
  }

  if (!targetVal) {
    throw new httpsV2.HttpsError('not-found', 'Target driver not found');
  }
  if (targetVal.active === false) {
    throw new httpsV2.HttpsError('permission-denied', 'Target driver is inactive');
  }
  if (!targetVal.companyId || targetVal.companyId !== callerCompanyId) {
    throw new httpsV2.HttpsError('permission-denied', 'Cross-company target driver');
  }

  const displayName = targetVal.displayName || targetVal.driverName || rawTarget;

  return {
    driverId: canonicalDriverId,
    driverHash: canonicalDriverHash,
    displayName,
  };
}

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
    const db = admin.firestore();
    const rtdb = admin.database();

    const callerAliases = await resolveDriverAliases(driver.driverId, rtdb);

    // 2. Verified identity: client fromDriverHash cannot establish ownership or forge identity
    if (data.fromDriverHash) {
      const trimmedFrom = String(data.fromDriverHash).trim();
      if (trimmedFrom !== driver.driverId && !callerAliases.has(trimmedFrom)) {
        throw new httpsV2.HttpsError('permission-denied', 'Actor identity mismatch: forged fromDriverHash');
      }
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

    // 6. Validate GPS (finite, bounded -90..90, -180..180, labeled client_reported)
    let fromGpsLat: number | null = null;
    let fromGpsLng: number | null = null;
    const hasLat = data.fromGpsLat !== undefined && data.fromGpsLat !== null;
    const hasLng = data.fromGpsLng !== undefined && data.fromGpsLng !== null;
    if (hasLat || hasLng) {
      if (!hasLat || !hasLng) {
        throw new httpsV2.HttpsError('invalid-argument', 'Both GPS latitude and longitude must be provided together');
      }
      const lat = Number(data.fromGpsLat);
      const lng = Number(data.fromGpsLng);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        throw new httpsV2.HttpsError('invalid-argument', 'Invalid GPS latitude (must be finite between -90 and 90)');
      }
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
        throw new httpsV2.HttpsError('invalid-argument', 'Invalid GPS longitude (must be finite between -180 and 180)');
      }
      fromGpsLat = lat;
      fromGpsLng = lng;
    }

    // 7. Direct-transfer target resolved server-side: must be active and in same company
    let targetDriver: { driverId: string; driverHash: string; displayName: string } | null = null;
    let targetDriverAliases = new Set<string>();

    if (mode === 'direct') {
      const rawToHash = String(data.toDriverHash || '').trim();
      if (!rawToHash) {
        throw new httpsV2.HttpsError('invalid-argument', 'toDriverHash is required for direct mode');
      }
      targetDriver = await resolveTargetDriver(rawToHash, driver.companyId, callerAliases, rtdb);
      targetDriverAliases = await resolveDriverAliases(targetDriver.driverId, rtdb);
    }

    if (!requestId) {
      requestId = db.collection('transfer_requests').doc().id;
    }

    const invoiceRef = db.collection('invoices').doc(sourceInvoiceDocId);
    const requestRef = db.collection('transfer_requests').doc(requestId);

    const ttlHours = 4;
    const ttlExpiresAt = Timestamp.fromMillis(Date.now() + ttlHours * 60 * 60 * 1000);

    const result = await db.runTransaction(async (tx) => {
      // 1. ALL READS FIRST (Strict Firestore transaction compliance)
      const reqSnap = await tx.get(requestRef);
      const invSnap = await tx.get(invoiceRef);

      if (!invSnap.exists) {
        throw new httpsV2.HttpsError('not-found', `Source invoice ${sourceInvoiceDocId} not found`);
      }
      const invData = invSnap.data() || {};

      // Check if request already exists (idempotency key)
      if (reqSnap.exists) {
        const existing = reqSnap.data() || {};
        const matches =
          existing.sourceInvoiceDocId === sourceInvoiceDocId &&
          (callerAliases.has(existing.fromDriverHash) || existing.fromDriverHash === driver.driverId) &&
          existing.companyId === driver.companyId &&
          existing.mode === mode &&
          (mode === 'approval' ||
            existing.toDriverHash === targetDriver?.driverHash ||
            existing.toDriverId === targetDriver?.driverId ||
            (targetDriver && targetDriverAliases.has(existing.toDriverHash)));

        if (!matches) {
          throw new httpsV2.HttpsError(
            'already-exists',
            'Transfer request already exists with conflicting parameters',
          );
        }

        // Re-read invoice on existing request ID match and prove invoice is still locked by that exact request
        if (invData.activeTransferRequestId !== requestId || invData.lockedForTransfer !== true) {
          throw new httpsV2.HttpsError(
            'failed-precondition',
            'Invoice is not locked for this transfer request',
          );
        }

        return { ok: true, requestId, alreadyExisted: true };
      }

      // 2. VALIDATE SOURCE INVOICE FOR NEW REQUEST
      verifySourceInvoiceOwnership(invData, callerAliases);

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

      // Missing BBL must remain null, not 0
      let totalBBL: number | null = null;
      if (typeof invData.totalBBL === 'number' && Number.isFinite(invData.totalBBL)) {
        totalBBL = invData.totalBBL;
      } else if (typeof invData.bbls === 'number' && Number.isFinite(invData.bbls)) {
        totalBBL = invData.bbls;
      } else {
        totalBBL = null;
      }

      // Server-derived canonical fields (caller cannot spoof)
      const newRequestDoc: Record<string, any> = {
        id: requestId,
        sourceInvoiceDocId,
        sourceDispatchId: invData.dispatchId || null,
        sourceMultiHaulId: invData.haulGroupId || null,
        sourceTicketDocIds: Array.isArray(invData.tickets) ? invData.tickets : [],
        fromDriverId: driver.driverId,
        fromDriverHash: driver.driverId,
        fromDriverName: driver.displayName || driver.driverId,
        fromGpsLat,
        fromGpsLng,
        fromGpsSource: fromGpsLat !== null ? 'client_reported' : null,
        fromGpsCapturedAt: fromGpsLat !== null ? new Date().toISOString() : null,
        toDriverId: targetDriver?.driverId || null,
        toDriverHash: targetDriver?.driverHash || null,
        toDriverName: targetDriver?.displayName || null,
        mode,
        status: 'pending',
        reason: String(data.reason || '').slice(0, 200),
        handoff: {
          destinationName: `${driver.displayName || 'Driver'} Location`,
          destinationLat: fromGpsLat,
          destinationLng: fromGpsLng,
          gpsSource: fromGpsLat !== null ? 'client_reported' : null,
          refreshedAt: null,
        },
        wellName: invData.wellName || '',
        operator: invData.operator || '',
        totalBBL,
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

      // 3. WRITES
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
    if (!driver.driverId) {
      throw new httpsV2.HttpsError('unauthenticated', 'Driver authentication required');
    }
    if (!driver.companyId) {
      throw new httpsV2.HttpsError('permission-denied', 'Driver company affiliation required');
    }

    const data = (request.data || {}) as ResolveTransferRequestInput;
    const rawReqId = String(data.requestId || '').trim();
    if (!rawReqId || !/^[a-zA-Z0-9_-]{1,128}$/.test(rawReqId)) {
      throw new httpsV2.HttpsError('invalid-argument', 'Invalid requestId format');
    }
    const requestId = rawReqId;

    const action = String(data.action || '').trim().toLowerCase() as 'cancel' | 'decline' | 'expire';
    if (!['cancel', 'decline', 'expire'].includes(action)) {
      throw new httpsV2.HttpsError('invalid-argument', `action must be cancel, decline, or expire (got: ${action})`);
    }
    const reason = String(data.reason || '').slice(0, 200);

    const db = admin.firestore();
    const rtdb = admin.database();
    const requestRef = db.collection('transfer_requests').doc(requestId);
    const callerAliases = await resolveDriverAliases(driver.driverId, rtdb);

    const result = await db.runTransaction(async (tx) => {
      // 1. ALL READS FIRST (Strict Firestore transaction compliance)
      const reqSnap = await tx.get(requestRef);
      if (!reqSnap.exists) {
        throw new httpsV2.HttpsError('not-found', `Transfer request ${requestId} not found`);
      }
      const reqData = reqSnap.data() || {};

      const invRef = reqData.sourceInvoiceDocId ? db.collection('invoices').doc(reqData.sourceInvoiceDocId) : null;
      const invSnap = invRef ? await tx.get(invRef) : null;
      const invData = invSnap?.exists ? invSnap.data() : null;

      // 2. AUTHORIZATION FIRST (BEFORE any terminal / idempotent cleanup)
      // Positive companyId required on transfer request and must match authenticated driver
      if (!reqData.companyId || reqData.companyId !== driver.companyId) {
        throw new httpsV2.HttpsError('permission-denied', 'Cross-company transfer resolution denied');
      }

      // Action authorization
      if (action === 'cancel') {
        // cancel: sender only
        const isSender =
          (reqData.fromDriverHash && callerAliases.has(reqData.fromDriverHash)) ||
          (reqData.fromDriverId && callerAliases.has(reqData.fromDriverId)) ||
          reqData.fromDriverHash === driver.driverId;
        if (!isSender) {
          throw new httpsV2.HttpsError('permission-denied', 'Only sender can cancel this transfer request');
        }
      } else if (action === 'decline') {
        // decline: direct recipient only. For approval mode: trace and enforce authorization contract
        if (reqData.mode === 'direct') {
          const isDirectRecipient =
            (reqData.toDriverHash && callerAliases.has(reqData.toDriverHash)) ||
            (reqData.toDriverId && callerAliases.has(reqData.toDriverId)) ||
            reqData.toDriverHash === driver.driverId;
          if (!isDirectRecipient) {
            throw new httpsV2.HttpsError('permission-denied', 'Only requested recipient can decline this transfer');
          }
        } else if (reqData.mode === 'approval') {
          const isPrivileged = (driver.roles || []).some((r) => ['admin', 'dispatcher', 'manager', 'staff'].includes(r));
          const isTarget =
            (reqData.toDriverHash && callerAliases.has(reqData.toDriverHash)) ||
            (reqData.toDriverId && callerAliases.has(reqData.toDriverId)) ||
            reqData.toDriverHash === driver.driverId;
          if (!isPrivileged && !isTarget) {
            throw new httpsV2.HttpsError('permission-denied', 'Unauthorized to decline approval-mode transfer request');
          }
        }
      } else if (action === 'expire') {
        // expire: must not be a general driver action. Privileged staff or verified TTL expiry
        const isPrivileged = (driver.roles || []).some((r) => ['admin', 'dispatcher', 'manager', 'staff'].includes(r));
        if (!isPrivileged) {
          const nowMillis = Date.now();
          let ttlMillis = 0;
          if (reqData.ttlExpiresAt?.toMillis) {
            ttlMillis = reqData.ttlExpiresAt.toMillis();
          } else if (typeof reqData.ttlExpiresAt === 'number') {
            ttlMillis = reqData.ttlExpiresAt;
          } else if (reqData.ttlExpiresAt) {
            ttlMillis = new Date(reqData.ttlExpiresAt).getTime();
          }
          if (!ttlMillis || nowMillis < ttlMillis) {
            throw new httpsV2.HttpsError('permission-denied', 'Unauthorized or premature transfer request expiration');
          }
        }
      }

      // 3. IDEMPOTENT / TERMINAL CHECK (Caller is verified authorized)
      if (reqData.status !== 'pending') {
        // Clear lock ONLY if source invoice is still locked by this exact request
        if (invRef && invSnap && invSnap.exists && invData?.activeTransferRequestId === requestId) {
          tx.update(invRef, {
            activeTransferRequestId: FieldValue.delete(),
            lockedForTransfer: false,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        return { ok: true, alreadyTerminal: true, status: reqData.status };
      }

      // 4. WRITES
      const terminalStatus = action === 'decline' ? 'declined' : action === 'cancel' ? 'cancelled' : 'expired';
      tx.update(requestRef, {
        status: terminalStatus,
        terminalAt: FieldValue.serverTimestamp(),
        terminalBy: driver.driverId,
        terminalReason: reason || null,
        updatedAt: FieldValue.serverTimestamp(),
      });

      // Clear source invoice lock ONLY if activeTransferRequestId === requestId
      if (invRef && invSnap && invSnap.exists && invData?.activeTransferRequestId === requestId) {
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
    if (!driver.driverId) {
      throw new httpsV2.HttpsError('unauthenticated', 'Driver authentication required');
    }
    if (!driver.companyId) {
      throw new httpsV2.HttpsError('permission-denied', 'Driver company affiliation required');
    }

    const data = (request.data || {}) as AcceptTransferRequestInput;
    const rawReqId = String(data.requestId || '').trim();
    if (!rawReqId || !/^[a-zA-Z0-9_-]{1,128}$/.test(rawReqId)) {
      throw new httpsV2.HttpsError('invalid-argument', 'Invalid requestId format');
    }
    const requestId = rawReqId;

    // Validate GPS inputs (finite, bounded -90..90, -180..180, labeled client_reported)
    let acceptGpsLat: number | null = null;
    let acceptGpsLng: number | null = null;
    const hasLat = data.acceptGpsLat !== undefined && data.acceptGpsLat !== null;
    const hasLng = data.acceptGpsLng !== undefined && data.acceptGpsLng !== null;
    if (hasLat || hasLng) {
      if (!hasLat || !hasLng) {
        throw new httpsV2.HttpsError('invalid-argument', 'Both accept GPS latitude and longitude must be provided together');
      }
      const lat = Number(data.acceptGpsLat);
      const lng = Number(data.acceptGpsLng);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        throw new httpsV2.HttpsError('invalid-argument', 'Invalid accept GPS latitude (must be finite between -90 and 90)');
      }
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
        throw new httpsV2.HttpsError('invalid-argument', 'Invalid accept GPS longitude (must be finite between -180 and 180)');
      }
      acceptGpsLat = lat;
      acceptGpsLng = lng;
    }

    // Validate truck and trailer inputs
    let truckNumber: string | null = null;
    if (data.truckNumber !== undefined && data.truckNumber !== null) {
      const t = String(data.truckNumber).trim();
      if (t.length > 64) {
        throw new httpsV2.HttpsError('invalid-argument', 'truckNumber exceeds 64 characters');
      }
      if (t) truckNumber = t;
    }

    let trailer: string | null = null;
    if (data.trailer !== undefined && data.trailer !== null) {
      const tr = String(data.trailer).trim();
      if (tr.length > 64) {
        throw new httpsV2.HttpsError('invalid-argument', 'trailer exceeds 64 characters');
      }
      if (tr) trailer = tr;
    }

    const db = admin.firestore();
    const rtdb = admin.database();
    const requestRef = db.collection('transfer_requests').doc(requestId);
    const callerAliases = await resolveDriverAliases(driver.driverId, rtdb);

    const result = await db.runTransaction(async (tx) => {
      // 1. ALL READS FIRST (Strict Firestore transaction compliance)
      const reqSnap = await tx.get(requestRef);
      if (!reqSnap.exists) {
        throw new httpsV2.HttpsError('not-found', `Transfer request ${requestId} not found`);
      }
      const reqData = reqSnap.data() || {};

      const sourceInvoiceDocId = reqData.sourceInvoiceDocId;
      if (!sourceInvoiceDocId) {
        throw new httpsV2.HttpsError('failed-precondition', 'Transfer request missing sourceInvoiceDocId');
      }
      const invRef = db.collection('invoices').doc(sourceInvoiceDocId);
      const invSnap = await tx.get(invRef);
      if (!invSnap.exists) {
        throw new httpsV2.HttpsError('not-found', `Source invoice ${sourceInvoiceDocId} not found`);
      }
      const invData = invSnap.data() || {};

      // Determine dispatch reference
      const dispatchId = reqData.sourceDispatchId || invData.dispatchId || null;
      const dispRef = dispatchId ? db.collection('dispatches').doc(dispatchId) : null;
      const dispSnap = dispRef ? await tx.get(dispRef) : null;
      const dispData = dispSnap?.exists ? dispSnap.data() : null;

      // ALL READS FINISHED. Now validations and decisions.

      // 2. COMPANY MATCH
      if (!reqData.companyId || reqData.companyId !== driver.companyId) {
        throw new httpsV2.HttpsError('permission-denied', 'Cross-company transfer accept denied');
      }

      // 3. IDEMPOTENCY / RETRY HANDLING
      if (reqData.status === 'accepted') {
        const isSameRecipient =
          (reqData.terminalBy && callerAliases.has(reqData.terminalBy)) ||
          (reqData.toDriverHash && callerAliases.has(reqData.toDriverHash)) ||
          (reqData.toDriverId && callerAliases.has(reqData.toDriverId)) ||
          reqData.terminalBy === driver.driverId ||
          reqData.toDriverHash === driver.driverId;

        if (isSameRecipient) {
          // Same-recipient retry returns already-completed canonical result without mutation
          return {
            ok: true,
            alreadyAccepted: true,
            requestId,
            sourceInvoiceDocId,
            targetDispatchId: reqData.targetDispatchId || dispatchId || null,
            handoffName: reqData.handoff?.destinationName,
            handoffLat: reqData.handoff?.destinationLat,
            handoffLng: reqData.handoff?.destinationLng,
          };
        } else {
          // Conflicting retry by different driver
          throw new httpsV2.HttpsError(
            'failed-precondition',
            'Transfer request already accepted by another driver',
          );
        }
      }

      if (reqData.status !== 'pending') {
        throw new httpsV2.HttpsError(
          'failed-precondition',
          `Transfer request is not pending (status: ${reqData.status})`,
        );
      }

      // 4. RECIPIENT AUTHORIZATION
      if (reqData.mode === 'direct') {
        const isTarget =
          (reqData.toDriverHash && callerAliases.has(reqData.toDriverHash)) ||
          (reqData.toDriverId && callerAliases.has(reqData.toDriverId)) ||
          reqData.toDriverHash === driver.driverId;
        if (!isTarget) {
          throw new httpsV2.HttpsError('permission-denied', 'Only requested recipient can accept this transfer');
        }
      } else if (reqData.mode === 'approval') {
        const isPrivileged = (driver.roles || []).some((r) => ['admin', 'dispatcher', 'manager', 'staff'].includes(r));
        const isTarget =
          (reqData.toDriverHash && callerAliases.has(reqData.toDriverHash)) ||
          (reqData.toDriverId && callerAliases.has(reqData.toDriverId)) ||
          reqData.toDriverHash === driver.driverId;
        const isAssignedOnDisp =
          dispData &&
          ((dispData.driverId && callerAliases.has(dispData.driverId)) ||
            (dispData.driverHash && callerAliases.has(dispData.driverHash)) ||
            dispData.driverId === driver.driverId);

        if (!isPrivileged && !isTarget && !isAssignedOnDisp) {
          throw new httpsV2.HttpsError('permission-denied', 'Unauthorized to accept approval-mode transfer request');
        }

        if (dispData && dispData.status === 'pending_approval' && !isPrivileged) {
          throw new httpsV2.HttpsError('failed-precondition', 'Approval-mode transfer is awaiting dispatcher approval');
        }
      }

      // 5. INVOICE VERIFICATION
      // Company match
      if (!invData.companyId || invData.companyId !== driver.companyId) {
        throw new httpsV2.HttpsError('permission-denied', 'Cross-company source invoice');
      }

      // Non-terminal check
      const invStatus = String(invData.status || '').toLowerCase().trim();
      if (TERMINAL_STATUSES.has(invStatus)) {
        throw new httpsV2.HttpsError('failed-precondition', 'Cannot accept transfer for terminal invoice');
      }

      // Lock verification: must be locked for this exact transfer request
      if (!invData.lockedForTransfer || invData.activeTransferRequestId !== requestId) {
        throw new httpsV2.HttpsError('failed-precondition', 'Invoice is not locked for this transfer request');
      }

      // Owner verification: invoice owner must match transfer sender
      const invDriverId = invData.driverId ? String(invData.driverId).trim() : null;
      const invDriverHash = invData.driverHash ? String(invData.driverHash).trim() : null;
      const senderHash = reqData.fromDriverHash ? String(reqData.fromDriverHash).trim() : null;
      const senderId = reqData.fromDriverId ? String(reqData.fromDriverId).trim() : null;

      const senderAliases = await resolveDriverAliases(senderHash || senderId || '', rtdb);
      const ownerMatchesSender =
        (invDriverId && senderAliases.has(invDriverId)) ||
        (invDriverHash && senderAliases.has(invDriverHash)) ||
        invDriverId === senderHash ||
        invDriverHash === senderHash;

      if (!ownerMatchesSender) {
        throw new httpsV2.HttpsError('failed-precondition', 'Source invoice owner does not match transfer sender');
      }

      // 6. DISPATCH VERIFICATION (if dispatch exists)
      if (dispRef && dispSnap && dispSnap.exists && dispData) {
        if (!dispData.companyId || dispData.companyId !== driver.companyId) {
          throw new httpsV2.HttpsError('permission-denied', 'Cross-company source dispatch');
        }
        if (dispData.sourceInvoiceDocId && dispData.sourceInvoiceDocId !== sourceInvoiceDocId) {
          throw new httpsV2.HttpsError('failed-precondition', 'Dispatch sourceInvoiceDocId mismatch');
        }
        const dispDriver = dispData.driverId || dispData.driverHash;
        if (dispDriver && !senderAliases.has(dispDriver) && dispDriver !== senderHash) {
          throw new httpsV2.HttpsError('failed-precondition', 'Dispatch driver does not match transfer sender');
        }
      }

      // 7. WRITES (Only after all reads have completed)
      const receiverName = driver.displayName || driver.driverId;
      const handoffStartEvent = {
        type: 'handoff_pickup_start',
        timestamp: new Date().toISOString(),
        lat: acceptGpsLat,
        lng: acceptGpsLng,
        gpsSource: acceptGpsLat !== null ? 'client_reported' : null,
        source: 'cf',
        locationName: reqData.handoff?.destinationName || `${reqData.fromDriverName || 'Driver'} Location`,
        leg: invData.currentLeg || 1,
        notes: `Transfer accepted; receiver heading to handoff with ${reqData.fromDriverName || 'Driver'}`,
      };

      const updatedTimeline = [...(invData.timeline || []), handoffStartEvent];

      // 7a. Reassign source invoice to receiver
      tx.update(invRef, {
        driver: receiverName,
        driverId: driver.driverId,
        driverHash: driver.driverId,
        driverLoginName: receiverName,
        ...(truckNumber ? { truckNumber } : {}),
        ...(trailer ? { trailer } : {}),
        timeline: updatedTimeline,
        driverState: 'en_route_handoff',
        enRouteDestName: reqData.handoff?.destinationName || `${reqData.fromDriverName || 'Driver'} Location`,
        enRouteDestLat: reqData.handoff?.destinationLat ?? null,
        enRouteDestLng: reqData.handoff?.destinationLng ?? null,
        activeTransferRequestId: FieldValue.delete(),
        lockedForTransfer: false,
        transferAcceptedAt: FieldValue.serverTimestamp(),
        transferAcceptedBy: driver.driverId,
        transferSourceDocId: sourceInvoiceDocId,
        updatedAt: FieldValue.serverTimestamp(),
      });

      // 7b. Transfer dispatch or create target dispatch via governed dispatch factory
      let targetDispatchId: string;
      if (dispRef && dispSnap && dispSnap.exists) {
        targetDispatchId = dispRef.id;
        tx.update(dispRef, {
          driverId: driver.driverId,
          driverHash: driver.driverId,
          driverName: receiverName,
          status: 'assigned',
          transferredFromHash: reqData.fromDriverHash,
          transferredFrom: reqData.fromDriverName,
          transferAcceptedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        // Governed dispatch creation preserving canonical identity
        const newDispRef = db.collection('dispatches').doc();
        targetDispatchId = newDispRef.id;
        tx.set(newDispRef, {
          id: newDispRef.id,
          driverId: driver.driverId,
          driverHash: driver.driverId,
          driverName: receiverName,
          status: 'assigned',
          wellName: reqData.wellName || invData.wellName || '',
          operator: reqData.operator || invData.operator || '',
          companyId: driver.companyId,
          sourceInvoiceDocId,
          transferRequestId: requestId,
          canonicalJobId: reqData.canonicalJobId || invData.canonicalJobId || null,
          sourceMultiHaulId: reqData.sourceMultiHaulId || invData.haulGroupId || null,
          sourcePacketId: reqData.sourcePacketId || invData.packetId || null,
          ticketDocIds: reqData.sourceTicketDocIds || invData.tickets || [],
          ticketNumber: reqData.sourceTicketNumber || invData.ticketNumber || null,
          invoicingMode: reqData.sourceInvoicingMode || invData.invoicingMode || null,
          transferredFromHash: reqData.fromDriverHash,
          transferredFrom: reqData.fromDriverName,
          transferAcceptedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      // 7c. Mark transfer request accepted
      tx.update(requestRef, {
        status: 'accepted',
        targetDispatchId,
        terminalAt: FieldValue.serverTimestamp(),
        terminalBy: driver.driverId,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        ok: true,
        requestId,
        sourceInvoiceDocId,
        targetDispatchId,
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
