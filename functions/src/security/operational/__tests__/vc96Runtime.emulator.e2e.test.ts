/**
 * Firestore + Auth emulator proof for createDriverDispatchIfAbsent tenancy
 * and idempotency. Skips unless FIRESTORE_EMULATOR_HOST is set.
 *
 * Run:
 *   firebase emulators:exec --only auth,firestore --project demo-vc96-runtime "npx jest vc96Runtime.emulator"
 */
import * as admin from 'firebase-admin';
import {
  evaluateDriverDispatchCreate,
  runCreateDriverDispatchIfAbsent,
} from '../driverDispatchCreateCore';

const FS = process.env.FIRESTORE_EMULATOR_HOST;
const describeE2E = FS ? describe : describe.skip;
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-vc96-runtime';
const UUID = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const COMPANY = 'liquid-gold';
const OTHER = 'acme-hauling';

function getApp(): admin.app.App {
  if (!admin.apps.length) {
    process.env.FIRESTORE_EMULATOR_HOST = FS!;
    if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
      // Auth emulator is optional; claims are simulated via the core caller.
    }
    return admin.initializeApp({ projectId: PROJECT });
  }
  return admin.app();
}

describeE2E('emulator: createDriverDispatchIfAbsent auth/tenancy/idempotency', () => {
  let db: admin.firestore.Firestore;

  beforeAll(() => {
    db = getApp().firestore();
  });

  afterAll(async () => {
    await Promise.all(admin.apps.filter((app): app is admin.app.App => app != null).map((app) => app.delete()));
  });

  const caller = { driverId: UUID, companyId: COMPANY };
  const record = { wellName: 'Gabriel 1', operator: 'WPX', jobType: 'Production Water', driverName: 'Mike' };

  it('unauthenticated / foreign company never writes; same-owner replay is already_exists', async () => {
    const id = `dplan_emu_${Date.now()}_01`;
    const ref = db.collection('dispatches').doc(id);
    await ref.delete().catch(() => undefined);

    const store = {
      get: async (docId: string) => {
        const snap = await db.collection('dispatches').doc(docId).get();
        return snap.exists ? (snap.data() as Record<string, unknown>) : null;
      },
      create: async (docId: string, fields: Record<string, unknown>) => {
        await db.collection('dispatches').doc(docId).create(fields);
      },
    };

    const unauth = evaluateDriverDispatchCreate({
      dispatchId: id, caller: null, existing: null, record,
    });
    expect(unauth.ok).toBe(false);
    if (!unauth.ok) expect(unauth.reason).toBe('unauthenticated_driver');

    const created = await runCreateDriverDispatchIfAbsent({ dispatchId: id, caller, record, ...store });
    expect(created.result).toBe('created');
    const first = (await ref.get()).data()!;
    expect(first.driverId).toBe(UUID);
    expect(first.companyId).toBe(COMPANY);
    expect(first.source).toBe('driver');
    expect(first.driverHash).toBe(UUID);

    const replay = await runCreateDriverDispatchIfAbsent({ dispatchId: id, caller, record, ...store });
    expect(replay.result).toBe('already_exists');
    expect((await ref.get()).data()?.status).toBe(first.status);

    await expect(runCreateDriverDispatchIfAbsent({
      dispatchId: id,
      caller: { driverId: 'other-driver', companyId: COMPANY },
      record,
      ...store,
    })).rejects.toThrow('conflict');
    expect((await ref.get()).data()?.driverId).toBe(UUID);

    await expect(runCreateDriverDispatchIfAbsent({
      dispatchId: id,
      caller: { driverId: UUID, companyId: OTHER },
      record,
      ...store,
    })).rejects.toThrow('conflict');
    expect((await ref.get()).data()?.companyId).toBe(COMPANY);

    await ref.delete();
  });
});
