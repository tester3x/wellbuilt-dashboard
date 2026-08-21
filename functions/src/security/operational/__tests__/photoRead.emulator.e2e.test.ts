/**
 * Callable photo round-trip against Auth/Firestore/Storage/Functions emulators.
 * Not Admin-SDK-only. Not part of default Jest (testPathIgnorePatterns).
 *
 * Required env (any missing → throw, never it.skip):
 *   FIREBASE_AUTH_EMULATOR_HOST
 *   FIRESTORE_EMULATOR_HOST
 *   FIREBASE_STORAGE_EMULATOR_HOST
 *   FUNCTIONS_EMULATOR_HOST
 */
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { driverAuthUid } from '../../tokenMint';

const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const FIRESTORE = process.env.FIRESTORE_EMULATOR_HOST;
const STORAGE = process.env.FIREBASE_STORAGE_EMULATOR_HOST || process.env.STORAGE_EMULATOR_HOST;
const FUNCTIONS = process.env.FUNCTIONS_EMULATOR_HOST || process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-wellbuilt-sync';
const REGION = process.env.FUNCTIONS_EMULATOR_REGION || 'us-central1';

function requireHosts(): { auth: string; firestore: string; storage: string; functions: string } {
  const missing = [
    !AUTH && 'FIREBASE_AUTH_EMULATOR_HOST',
    !FIRESTORE && 'FIRESTORE_EMULATOR_HOST',
    !STORAGE && 'FIREBASE_STORAGE_EMULATOR_HOST',
    !FUNCTIONS && 'FUNCTIONS_EMULATOR_HOST',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`emulator_hosts_unset:${missing.join(',')}; callable photo round-trip not proven`);
  }
  return { auth: AUTH!, firestore: FIRESTORE!, storage: STORAGE!, functions: FUNCTIONS! };
}

async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok || res.status === 404 || res.status === 400 || res.status === 401;
  } catch {
    return false;
  }
}

async function callFn(name: string, token: string, data: Record<string, unknown>) {
  const hosts = requireHosts();
  const url = `http://${hosts.functions}/${PROJECT}/${REGION}/${name}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ data }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${name}_http_${res.status}:${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.result || body.data || body;
}

describe('callable photo emulator round-trip', () => {
  it('request → PUT → finalize attach → issueStorageReadUrl → fetch', async () => {
    const hosts = requireHosts();
    const up = await Promise.all([
      probe(`http://${hosts.auth}/`),
      probe(`http://${hosts.firestore}/`),
      probe(`http://${hosts.storage}/`),
      probe(`http://${hosts.functions}/`),
    ]);
    if (up.some((v) => !v)) {
      throw new Error(
        `emulator_unreachable:auth=${up[0]} firestore=${up[1]} storage=${up[2]} functions=${up[3]}; callable photo round-trip not proven`,
      );
    }

    process.env.FIREBASE_AUTH_EMULATOR_HOST = hosts.auth;
    process.env.FIRESTORE_EMULATOR_HOST = hosts.firestore;
    process.env.FIREBASE_STORAGE_EMULATOR_HOST = hosts.storage;

    const driverId = 'drv-emu-16l';
    const uid = driverAuthUid(driverId);
    const companyId = 'liquid-gold';
    const invoiceId = 'inv-emu-16l';
    const photoId = 'ph_emu16ltest01';
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

    const app: App = initializeApp({
      projectId: PROJECT,
      storageBucket: `${PROJECT}.appspot.com`,
    }, `photo-e2e-${Date.now()}`);
    try {
      const auth = getAuth(app);
      const db = getFirestore(app);
      const bucket = getStorage(app).bucket();
      try {
        await auth.deleteUser(uid);
      } catch { /* first run */ }
      await auth.createUser({ uid, email: `${driverId}@emu.test` });
      await auth.setCustomUserClaims(uid, {
        kind: 'driver',
        driverId,
        companyId,
        roles: ['driver'],
      });
      await db.collection('drivers').doc(driverId).set({
        active: true,
        companyId,
        displayName: 'Emu Driver',
        roles: ['driver'],
      });
      await db.collection('invoices').doc(invoiceId).set({
        companyId,
        driverId,
        status: 'open',
        photos: [],
      });
      const token = await auth.createCustomToken(uid, {
        kind: 'driver',
        driverId,
        companyId,
      });
      const granted = await callFn('requestStorageUploadPath', token, {
        kind: 'ticket_photo',
        companyId,
        invoiceId,
        photoId,
        contentType: 'image/jpeg',
        byteSize: bytes.length,
      });
      expect(granted.photoId).toBe(photoId);
      expect(granted.grantId).toBeTruthy();
      expect(granted.uploadUrl).toMatch(/^https?:\/\//);
      const put = await fetch(granted.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'image/jpeg',
          'x-goog-if-generation-match': '0',
          ...(granted.requiredHeaders || {}),
        },
        body: bytes,
      });
      expect(put.ok).toBe(true);
      const finalized = await callFn('finalizeStorageUpload', token, {
        grantId: granted.grantId,
        path: granted.path,
      });
      expect(finalized.ok).toBe(true);
      expect(finalized.photoId).toBe(photoId);
      expect(finalized.path).toBe(granted.path);
      const inv = await db.collection('invoices').doc(invoiceId).get();
      const photos = inv.get('photos') as Array<{ photoId?: string; path?: string }>;
      expect(photos.some((p) => p.photoId === photoId && p.path === granted.path)).toBe(true);
      const issued = await callFn('issueStorageReadUrl', token, {
        invoiceId,
        photoId,
        bucket: finalized.bucket,
        path: finalized.path,
      });
      expect(issued.readUrl).toMatch(/^https?:\/\//);
      expect(issued.readUrl).toMatch(/[?&]/);
      const fetched = await fetch(issued.readUrl);
      expect(fetched.ok).toBe(true);
      const got = Buffer.from(await fetched.arrayBuffer());
      expect(Buffer.compare(got, bytes)).toBe(0);
      void bucket;
    } finally {
      await deleteApp(app);
    }
  }, 60_000);
});
