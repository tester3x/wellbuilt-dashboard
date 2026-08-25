/**
 * Firestore emulator concurrency for canonical paper reservations.
 * Requires FIRESTORE_EMULATOR_HOST (firebase emulators:exec --only firestore).
 * Never talks to production.
 */
import * as admin from 'firebase-admin';
import { createFirestorePaperStore } from '../firestoreStore';
import { materializeWaterTicketPaper } from '../engine';
import { waterTicketArtifactId } from '../types';
import {
  CLOSED_AT_MS,
  COMPANY_LG,
  DRIVER_ZFOLD,
  INVOICE_20100_ID,
  JSA_BYTES,
  PIXEL_A,
  PIXEL_B,
  TICKET_20100_ID,
  invoice20100,
  staffLg,
  ticket20100,
} from './fixture20100';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
const describeE2E = EMULATOR ? describe : describe.skip;

function memBucket() {
  const files = new Map<string, Buffer>();
  return {
    file(path: string) {
      return {
        async save(d: Buffer | string, opts: { precondition?: { ifGenerationMatch?: number } }) {
          const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
          if (opts?.precondition?.ifGenerationMatch === 0 && files.has(path)) {
            const err = new Error('condition not met') as Error & { code?: number };
            err.code = 412;
            throw err;
          }
          files.set(path, buf);
        },
        async download() {
          const buf = files.get(path);
          if (!buf) throw new Error('not found');
          return [buf];
        },
      };
    },
  };
}

describeE2E('firestore emulator: concurrent paper revisions', () => {
  let app: admin.app.App;

  beforeAll(() => {
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR!;
    app = admin.initializeApp({ projectId: PROJECT }, `paper-emu-${Date.now()}`);
  });

  afterAll(async () => {
    await app.delete();
  });

  it('two concurrent distinct events receive different revision ids', async () => {
    const db = app.firestore();
    const ticketId = `${TICKET_20100_ID}-emu`;
    const invoiceId = `${INVOICE_20100_ID}-emu`;
    await db.collection('tickets').doc(ticketId).set({
      ...ticket20100,
      id: ticketId,
      invoiceDocId: invoiceId,
      updatedAtMs: CLOSED_AT_MS + 50,
    });
    await db.collection('invoices').doc(invoiceId).set({
      ...invoice20100,
      id: invoiceId,
    });
    const identities: Record<string, { legalName: string }> = {
      [DRIVER_ZFOLD]: { legalName: 'Mike ZFold7 Burger' },
    };
    const store = createFirestorePaperStore({
      firestore: db,
      bucket: memBucket(),
      rtdb: {
        ref: (path: string) => ({
          once: async () => {
            const id = path.replace('drivers/profiles/', '');
            const row = identities[id];
            return { exists: () => !!row, val: () => row || null };
          },
        }),
      } as unknown as admin.database.Database,
    });
    const origRead = store.readLiveAsset.bind(store);
    store.readLiveAsset = async (uri: string) => {
      if (uri.includes('a.jpg')) return PIXEL_A;
      if (uri.includes('b.jpg')) return PIXEL_B;
      if (uri.includes('jsa')) return JSA_BYTES;
      return origRead(uri);
    };

    const sequential = await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: ticketId, op: 'close', nowMs: CLOSED_AT_MS,
    });
    if (!sequential.ok) {
      throw new Error(`materialize failed: ${sequential.reason}:${sequential.message}`);
    }

    const ticketId2 = `${ticketId}-b`;
    const invoiceId2 = `${invoiceId}-b`;
    await db.collection('tickets').doc(ticketId2).set({
      ...ticket20100,
      id: ticketId2,
      invoiceDocId: invoiceId2,
      updatedAtMs: CLOSED_AT_MS + 50,
    });
    await db.collection('invoices').doc(invoiceId2).set({
      ...invoice20100,
      id: invoiceId2,
    });
    const [close, edit] = await Promise.all([
      materializeWaterTicketPaper({
        store, caller: staffLg, ticketDocId: ticketId2, op: 'close', nowMs: CLOSED_AT_MS,
      }),
      materializeWaterTicketPaper({
        store, caller: staffLg, ticketDocId: ticketId2, op: 'edit', nowMs: CLOSED_AT_MS + 50,
      }),
    ]);
    expect({ close, edit }).toEqual(expect.objectContaining({
      close: expect.objectContaining({ ok: true }),
      edit: expect.objectContaining({ ok: true }),
    }));
    if (!close.ok || !edit.ok) return;
    expect(close.revision.revisionId).not.toBe(edit.revision.revisionId);
    const artifact = await store.getArtifact(waterTicketArtifactId(ticketId2));
    expect(artifact?.currentRevisionId).toBe(edit.revision.revisionId);
    const older = await store.getRevision(waterTicketArtifactId(ticketId2), close.revision.revisionId);
    const newer = await store.getRevision(waterTicketArtifactId(ticketId2), edit.revision.revisionId);
    expect(older && newer).toBeTruthy();
  });

  it('later-finishing older close cannot replace a newer current edit', async () => {
    const db = app.firestore();
    const ticketId = `${TICKET_20100_ID}-order`;
    const invoiceId = `${INVOICE_20100_ID}-order`;
    await db.collection('tickets').doc(ticketId).set({
      ...ticket20100,
      id: ticketId,
      invoiceDocId: invoiceId,
      updatedAt: { seconds: Math.floor((CLOSED_AT_MS + 80) / 1000), nanoseconds: 0 },
    });
    await db.collection('invoices').doc(invoiceId).set({ ...invoice20100, id: invoiceId });
    const store = createFirestorePaperStore({
      firestore: db,
      bucket: memBucket(),
      rtdb: {
        ref: (path: string) => ({
          once: async () => ({
            exists: () => path.includes(DRIVER_ZFOLD),
            val: () => ({ legalName: 'Mike ZFold7 Burger' }),
          }),
        }),
      } as unknown as admin.database.Database,
    });
    store.readLiveAsset = async (uri: string) => {
      if (uri.includes('jsa')) return JSA_BYTES;
      return PIXEL_A;
    };
    const editFirst = await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: ticketId, op: 'edit', nowMs: CLOSED_AT_MS + 80,
    });
    const closeLate = await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: ticketId, op: 'close', nowMs: CLOSED_AT_MS,
    });
    expect(editFirst.ok && closeLate.ok).toBe(true);
    if (!editFirst.ok || !closeLate.ok) return;
    const artifact = await store.getArtifact(waterTicketArtifactId(ticketId));
    expect(artifact?.currentRevisionId).toBe(editFirst.revision.revisionId);
    expect(await store.getRevision(waterTicketArtifactId(ticketId), closeLate.revision.revisionId)).toBeTruthy();
  });
});
