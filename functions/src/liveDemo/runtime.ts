/** Demo tenant access and optional read-only WB T phone feed.
 * The former scheduled job simulator is retired. This module never creates
 * dispatches, tickets, invoices, pull packets, or driver profiles.
 */
import * as admin from 'firebase-admin';
import * as httpsV2 from 'firebase-functions/v2/https';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { defineSecret } from 'firebase-functions/params';

export const DEMO_COMPANY_ID = 'wellbuilt-demo';
export const DEMO_COMPANY_NAME = 'WellBuilt Demo Hauling';
const root = 'live_demo';
const rt = () => admin.database();
const DEMO_VIEWER_UID = 'wellbuilt-demo-shared-viewer';
const DEMO_PHONE_UPLOAD_KEY = defineSecret('DEMO_PHONE_UPLOAD_KEY');
const DEMO_PHONE_PATH = `${root}/phone/frame`;

/** One shared, company-scoped viewer identity for public demo visitors. */
export const demoViewerSession = httpsV2.onCall(
  { memory: '256MiB', timeoutSeconds: 30, enforceAppCheck: false },
  async () => {
    const company = await admin.firestore().collection('companies').doc(DEMO_COMPANY_ID).get();
    if (!company.exists || company.get('companyId') !== DEMO_COMPANY_ID || company.get('isDemo') !== true) {
      throw new httpsV2.HttpsError('failed-precondition', 'demo_company_missing');
    }
    try {
      await admin.auth().getUser(DEMO_VIEWER_UID);
    } catch (error) {
      if ((error as { code?: string }).code !== 'auth/user-not-found') throw error;
      try {
        await admin.auth().createUser({ uid: DEMO_VIEWER_UID, displayName: 'WellBuilt Demo Viewer' });
      } catch (createError) {
        if ((createError as { code?: string }).code !== 'auth/uid-already-exists') throw createError;
      }
    }
    const profileRef = rt().ref(`users/${DEMO_VIEWER_UID}`);
    const profile = await profileRef.transaction(current => {
      if (current !== null) {
        if (current.companyId !== DEMO_COMPANY_ID
          || !['viewer', 'demo_viewer'].includes(current.role)
          || current.isDemo !== true) return;
        if (current.role === 'demo_viewer') return;
        return { ...current, role: 'demo_viewer', roles: ['demo_viewer'] };
      }
      return {
        companyId: DEMO_COMPANY_ID, companyName: DEMO_COMPANY_NAME,
        role: 'demo_viewer', roles: ['demo_viewer'], displayName: 'WellBuilt Demo Viewer',
        status: 'active', isDemo: true,
      };
    }, undefined, false);
    const saved = profile.snapshot.val();
    if (!saved || saved.companyId !== DEMO_COMPANY_ID || saved.role !== 'demo_viewer' || saved.isDemo !== true) {
      throw new Error('demo_viewer_identity_conflict');
    }
    const customToken = await admin.auth().createCustomToken(DEMO_VIEWER_UID, {
      staffCompanyId: DEMO_COMPANY_ID, staffRole: 'demo_viewer', isDemo: true,
    });
    return { customToken, companyId: DEMO_COMPANY_ID, role: 'demo_viewer' as const };
  },
);

/** Read-only frame from the dedicated WB T device; no browser device controls. */
export const liveDemoPhoneFrame = httpsV2.onCall(
  { memory: '256MiB', timeoutSeconds: 15, enforceAppCheck: false },
  async request => {
    if (request.auth?.uid !== DEMO_VIEWER_UID
      || request.auth.token.staffCompanyId !== DEMO_COMPANY_ID
      || request.auth.token.staffRole !== 'demo_viewer'
      || request.auth.token.isDemo !== true) {
      throw new httpsV2.HttpsError('permission-denied', 'demo_viewer_required');
    }
    const frame = (await rt().ref(DEMO_PHONE_PATH).once('value')).val();
    const capturedAt = Number(frame?.capturedAt || 0);
    if (frame?.companyId !== DEMO_COMPANY_ID || frame?.source !== 'wbt-android'
      || !Number.isFinite(capturedAt) || Date.now() - capturedAt > 15_000
      || typeof frame?.pngBase64 !== 'string') {
      return { available: false as const };
    }
    return { available: true as const, url: `data:image/png;base64,${frame.pngBase64}`, capturedAt };
  },
);

/** Private emulator-host upload. A keyed frame cannot be forged by a public viewer. */
export const uploadLiveDemoPhoneFrame = httpsV2.onCall(
  { memory: '256MiB', timeoutSeconds: 15, enforceAppCheck: false, secrets: [DEMO_PHONE_UPLOAD_KEY] },
  async request => {
    const input = request.data || {};
    const capturedAt = Number(input.capturedAt);
    const nonce = String(input.nonce || '');
    const pngBase64 = String(input.pngBase64 || '');
    const signature = String(input.signature || '');
    if (!Number.isSafeInteger(capturedAt) || Math.abs(Date.now() - capturedAt) > 10_000
      || !/^[0-9a-f-]{36}$/i.test(nonce) || pngBase64.length > 600_000
      || !/^[0-9a-f]{64}$/i.test(signature)) {
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_demo_frame');
    }
    const png = Buffer.from(pngBase64, 'base64');
    if (png.length < 100 || png.length > 450_000
      || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_demo_png');
    }
    const digest = createHash('sha256').update(png).digest('hex');
    const expected = createHmac('sha256', DEMO_PHONE_UPLOAD_KEY.value())
      .update(`${capturedAt}.${nonce}.${digest}`).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
      throw new httpsV2.HttpsError('permission-denied', 'invalid_demo_frame_signature');
    }
    await rt().ref(DEMO_PHONE_PATH).set({
      companyId: DEMO_COMPANY_ID, source: 'wbt-android', capturedAt, pngBase64,
    });
    return { accepted: true as const };
  },
);

/** Compatibility response for already-open browser tabs. No heartbeat writes. */
export const liveDemoSnapshot = httpsV2.onCall(
  { memory: '256MiB', timeoutSeconds: 15, enforceAppCheck: false },
  async request => {
    if (request.auth?.uid !== DEMO_VIEWER_UID
      || request.auth.token.staffCompanyId !== DEMO_COMPANY_ID
      || request.auth.token.staffRole !== 'demo_viewer'
      || request.auth.token.isDemo !== true) {
      throw new httpsV2.HttpsError('permission-denied', 'demo_viewer_required');
    }
    return { companyId: DEMO_COMPANY_ID, synthetic: false, enabled: false, active: null, retired: true };
  },
);
