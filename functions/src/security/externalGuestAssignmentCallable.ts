import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireTrustedCompanyCapability, TRUSTED_CAPABILITY_MANAGE_DRIVERS } from './trustedStaffAuthority';
import { externalDriverAccessMode, OUTSIDE_DRIVER_ACCESS_COLLECTION } from './operational/outsideDriverAccess';
import {
  createGuestToken, decideGuestAction, guestLinkIsValid, matchesGuestToken,
  parseGuestBearer, GUEST_LINK_MAX_AGE_MS, type GuestAction, type GuestStep,
} from './operational/guestAssignmentCore';

const LINKS = 'external_assignment_guest_links';
const DELIVERIES = 'external_assignment_deliveries';
const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const VALID_JOB_STATUSES = new Set(['pending', 'pending_approval', 'accepted', 'in_progress', 'paused']);
const ACTIONS = new Set<GuestAction>(['accepted', 'declined', 'arrived', 'completed']);

function badToken(): never {
  throw new httpsV2.HttpsError('permission-denied', 'link_invalid_or_expired');
}
function invalidRequest(): never {
  throw new httpsV2.HttpsError('invalid-argument', 'invalid_guest_request');
}
function isSimpleObject(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}
async function requireOperationalAccess(db: FirebaseFirestore.Firestore, companyId: string) {
  const [company, settings] = await Promise.all([
    db.collection('companies').doc(companyId).get(),
    db.collection(OUTSIDE_DRIVER_ACCESS_COLLECTION).doc(companyId).get(),
  ]);
  const mode = externalDriverAccessMode(company.data(), settings.data());
  if (!mode) throw new httpsV2.HttpsError('permission-denied', 'external_driver_access_inactive');
  return mode;
}

/**
 * Dispatcher mints a short-lived bearer link, one job at a time.
 * Returns the secret exactly once. Does NOT send any text or mutate WB-M tickets.
 */
export const staffCreateExternalGuestLink = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async request => {
    const authority = await requireTrustedCompanyCapability(request.auth?.uid, TRUSTED_CAPABILITY_MANAGE_DRIVERS);
    const raw = request.data;
    if (!isSimpleObject(raw) || Object.keys(raw).length !== 1 || !ID_RE.test(String(raw.deliveryId))) invalidRequest();
    const deliveryId = String(raw.deliveryId);
    const db = admin.firestore();
    await requireOperationalAccess(db, authority.companyId);
    const created = createGuestToken();
    const now = Date.now();
    const linkRef = db.collection(LINKS).doc(created.linkId);
    const rootRef = db.collection(DELIVERIES).doc(deliveryId);
    await db.runTransaction(async tx => {
      const rootSnap = await tx.get(rootRef);
      const root = rootSnap.data();
      if (!root || root.companyId !== authority.companyId || root.assignmentState !== 'active'
        || !Number.isSafeInteger(root.currentRevision) || typeof root.dispatchId !== 'string'
        || typeof root.externalDriverId !== 'string') {
        throw new httpsV2.HttpsError('failed-precondition', 'delivery_unavailable');
      }
      const dispatchRef = db.collection('dispatches').doc(root.dispatchId);
      const driverRef = db.collection('companies').doc(authority.companyId)
        .collection('external_drivers').doc(root.externalDriverId);
      const [dispatch, driver] = await Promise.all([tx.get(dispatchRef), tx.get(driverRef)]);
      if (!dispatch.exists || dispatch.data()?.companyId !== authority.companyId
        || !VALID_JOB_STATUSES.has(dispatch.data()?.status)) {
        throw new httpsV2.HttpsError('failed-precondition', 'job_not_active');
      }
      if (!driver.exists || driver.data()?.companyId !== authority.companyId
        || driver.data()?.active !== true) {
        throw new httpsV2.HttpsError('failed-precondition', 'external_driver_inactive');
      }
      if (root.guestProgress === 'declined' || root.guestProgress === 'completed') {
        throw new httpsV2.HttpsError('failed-precondition', 'assignment_already_final');
      }
      const link = {
        schemaVersion: 1, linkId: created.linkId, deliveryId,
        companyId: authority.companyId, dispatchId: root.dispatchId,
        externalDriverId: root.externalDriverId, revision: root.currentRevision,
        tokenHash: created.tokenHash, createdAtMs: now,
        expiresAtMs: now + GUEST_LINK_MAX_AGE_MS, createdBy: authority.uid,
      };
      tx.create(linkRef, link);
      tx.update(rootRef, {
        guestLinkId: created.linkId,
        guestProgress: root.guestProgress || 'pending',
        guestProgressUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    return { ok: true, token: created.linkId + '.' + created.secret,
      expiresAtMs: now + GUEST_LINK_MAX_AGE_MS };
  },
);

/**
 * No-login page: an unguessable 256-bit token grants only job-bound,
 * narrowly selected assignment acknowledgements. No WB-M/ticket writes.
 */
export const externalGuestAssignment = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async request => {
    const raw = request.data;
    if (!isSimpleObject(raw) || Object.keys(raw).some(k => !['token', 'action'].includes(k))) invalidRequest();
    const parsed = parseGuestBearer(raw.token);
    if (!parsed) badToken();
    const action = raw.action ?? 'view';
    if (action !== 'view' && !ACTIONS.has(action as GuestAction)) invalidRequest();
    const db = admin.firestore();
    const linkRef = db.collection(LINKS).doc(parsed.linkId);

    // The bearer is NOT a WB account. Every call revalidates the current
    // delivery revision, protected company access, driver state and job state.
    const linkSnap = await linkRef.get();
    const link = linkSnap.data();
    if (!link || !matchesGuestToken(link.tokenHash, parsed)) badToken();
    await requireOperationalAccess(db, String(link.companyId));
    const rootRef = db.collection(DELIVERIES).doc(String(link.deliveryId));
    const dispatchRef = db.collection('dispatches').doc(String(link.dispatchId));
    const driverRef = db.collection('companies').doc(String(link.companyId))
      .collection('external_drivers').doc(String(link.externalDriverId));

    if (action === 'view') {
      const [rootSnap, jobSnap, driverSnap] = await Promise.all([
        rootRef.get(), dispatchRef.get(), driverRef.get(),
      ]);
      const root = rootSnap.data(), job = jobSnap.data(), driver = driverSnap.data();
      if (!guestLinkIsValid(link, root, Date.now())
        || job?.companyId !== link.companyId || !VALID_JOB_STATUSES.has(job?.status)
        || driver?.companyId !== link.companyId || driver?.active !== true) badToken();
      const status: GuestStep = root?.guestProgress || 'pending';
      return { ok: true, job: {
        name: typeof job?.wellName === 'string' ? job.wellName.slice(0, 180) : 'Assigned job',
        status: job?.status,
      }, status, expiresAtMs: link.expiresAtMs };
    }
    const next = action as GuestAction;
    const result = await db.runTransaction(async tx => {
      const [freshLinkSnap, rootSnap, jobSnap, driverSnap] = await Promise.all([
        tx.get(linkRef), tx.get(rootRef), tx.get(dispatchRef), tx.get(driverRef),
      ]);
      const fresh = freshLinkSnap.data(), root = rootSnap.data(), job = jobSnap.data(), driver = driverSnap.data();
      if (!fresh || !matchesGuestToken(fresh.tokenHash, parsed)
        || !guestLinkIsValid(fresh, root, Date.now())
        || job?.companyId !== fresh.companyId || !VALID_JOB_STATUSES.has(job?.status)
        || driver?.companyId !== fresh.companyId || driver?.active !== true) badToken();

      const current: GuestStep = root?.guestProgress || 'pending';
      const verdict = decideGuestAction(current, next);
      if (verdict === 'deny') throw new httpsV2.HttpsError('failed-precondition', 'invalid_guest_transition');
      if (verdict === 'repeat') return { ok: true, status: current, idempotent: true };
      const at = admin.firestore.FieldValue.serverTimestamp();
      tx.update(rootRef, { guestProgress: next, guestProgressUpdatedAt: at, guestProgressSource: 'external_guest_link' });
      // An auditable record only; NEVER sets dispatch completion or fabricates a ticket.
      const eventRef = rootRef.collection('guest_events').doc();
      tx.create(eventRef, {
        schemaVersion: 1, companyId: fresh.companyId, linkId: fresh.linkId,
        externalDriverId: fresh.externalDriverId, revision: fresh.revision,
        from: current, to: next, at,
      });
      return { ok: true, status: next, idempotent: false };
    });
    return result;
  },
);
