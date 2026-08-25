/**
 * Firestore emulator concurrency for canonical paper reservations.
 * Requires FIRESTORE_EMULATOR_HOST (firebase emulators:exec --only firestore).
 * Never talks to production.
 */
import * as admin from 'firebase-admin';
import { createFirestorePaperStore } from '../firestoreStore';
import { getWaterTicketPaper, materializeWaterTicketPaper } from '../engine';
import { applyInvoicePaperLifecycle, applyTicketPaperLifecycle } from '../lifecycle';
import { applyTicketReviewAction, applyTicketReviewBatch } from '../ticketReview';
import { parseGovernedStorageUri } from '../storageUri';
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
  dispatchLg,
  driverOther,
  driverOwner,
  payrollLg,
  staffLg,
  staffOther,
  ticket20100,
} from './fixture20100';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
const describeE2E = EMULATOR ? describe : describe.skip;
jest.setTimeout(60000);

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
      if (uri.includes('a.jpg')) return { ok: true, bytes: PIXEL_A };
      if (uri.includes('b.jpg')) return { ok: true, bytes: PIXEL_B };
      if (uri.includes('jsa')) return { ok: true, bytes: JSA_BYTES };
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
      if (uri.includes('jsa')) return { ok: true, bytes: JSA_BYTES };
      return { ok: true, bytes: PIXEL_A };
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

describeE2E('firestore emulator: write-order, retry, tenant assets', () => {
  let app: admin.app.App;

  beforeAll(() => {
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR!;
    app = admin.initializeApp({ projectId: PROJECT }, `paper-life-${Date.now()}`);
  });

  afterAll(async () => {
    await app.delete();
  });

  function identityRtdb() {
    return {
      ref: (path: string) => ({
        once: async () => ({
          exists: () => path.includes(DRIVER_ZFOLD),
          val: () => ({ legalName: 'Mike ZFold7 Burger' }),
        }),
      }),
    } as unknown as admin.database.Database;
  }

  function storeFor(db: admin.firestore.Firestore, bucket = memBucket()) {
    const store = createFirestorePaperStore({ firestore: db, bucket, rtdb: identityRtdb() });
    store.readLiveAsset = async (uri: string, opts) => {
      const parsed = parseGovernedStorageUri(uri, {
        projectBucket: 'wellbuilt-sync.appspot.com',
        companyId: opts?.companyId,
        invoiceDocId: opts?.invoiceDocId,
        ticketDocId: opts?.ticketDocId,
      });
      if (/storage\.googleapis\.com|gs:\/\//.test(uri) && !parsed.ok) {
        return { ok: false, reason: parsed.reason, retry: false };
      }
      if (uri.includes('jsa')) return { ok: true, bytes: JSA_BYTES };
      if (uri.includes('a.jpg') || uri.includes('own.jpg')) return { ok: true, bytes: PIXEL_A };
      if (uri.includes('b.jpg')) return { ok: true, bytes: PIXEL_B };
      return { ok: true, bytes: PIXEL_A };
    };
    return store;
  }

  it('ticket first then invoice close, and the reverse, each yield one r1', async () => {
    const db = app.firestore();
    const ticketA = `${TICKET_20100_ID}-order-a`;
    const invA = `${INVOICE_20100_ID}-order-a`;
    await db.collection('tickets').doc(ticketA).set({ ...ticket20100, id: ticketA, invoiceDocId: invA });
    const storeA = storeFor(db);
    const beforeClose = await applyTicketPaperLifecycle({
      store: storeA, ticketId: ticketA, before: null, after: { ...ticket20100, id: ticketA, invoiceDocId: invA }, nowMs: CLOSED_AT_MS - 1,
    });
    expect(beforeClose.class).toBe('ignored');
    await db.collection('invoices').doc(invA).set({ ...invoice20100, id: invA, status: 'closed' });
    const closeA = await applyInvoicePaperLifecycle({
      store: storeA, invoiceId: invA, before: { status: 'open' }, after: { ...invoice20100, id: invA, status: 'closed', closedAtMs: CLOSED_AT_MS }, nowMs: CLOSED_AT_MS,
    });
    expect(closeA.class).toBe('success');
    expect((await storeA.getArtifact(waterTicketArtifactId(ticketA)))?.currentRevisionId).toBe('r1');

    const ticketB = `${TICKET_20100_ID}-order-b`;
    const invB = `${INVOICE_20100_ID}-order-b`;
    const storeB = storeFor(db);
    await db.collection('invoices').doc(invB).set({ ...invoice20100, id: invB, status: 'closed', closedAtMs: CLOSED_AT_MS });
    const closeB = await applyInvoicePaperLifecycle({
      store: storeB, invoiceId: invB, before: { status: 'open' }, after: { ...invoice20100, id: invB, status: 'closed', closedAtMs: CLOSED_AT_MS }, nowMs: CLOSED_AT_MS,
    });
    expect(closeB.class).toBe('pending_reconciliation');
    await db.collection('tickets').doc(ticketB).set({ ...ticket20100, id: ticketB, invoiceDocId: invB });
    const ticketArrive = await applyTicketPaperLifecycle({
      store: storeB, ticketId: ticketB, before: null, after: { ...ticket20100, id: ticketB, invoiceDocId: invB }, nowMs: CLOSED_AT_MS + 2,
    });
    expect(ticketArrive.class).toBe('success');
    expect((await storeB.getArtifact(waterTicketArtifactId(ticketB)))?.currentRevisionId).toBe('r1');
    expect(await storeB.getRevision(waterTicketArtifactId(ticketB), 'r2')).toBeNull();
  });

  it('concurrent and duplicated close deliveries create exactly one r1', async () => {
    const db = app.firestore();
    const ticketId = `${TICKET_20100_ID}-dup`;
    const invoiceId = `${INVOICE_20100_ID}-dup`;
    await db.collection('tickets').doc(ticketId).set({ ...ticket20100, id: ticketId, invoiceDocId: invoiceId });
    await db.collection('invoices').doc(invoiceId).set({ ...invoice20100, id: invoiceId, status: 'closed' });
    const store = storeFor(db);
    const after = { ...invoice20100, id: invoiceId, status: 'closed', closedAtMs: CLOSED_AT_MS };
    const [a, b, c] = await Promise.all([
      applyInvoicePaperLifecycle({ store, invoiceId, before: { status: 'open' }, after, nowMs: CLOSED_AT_MS }),
      applyTicketPaperLifecycle({ store, ticketId, before: null, after: { ...ticket20100, id: ticketId, invoiceDocId: invoiceId }, nowMs: CLOSED_AT_MS }),
      applyInvoicePaperLifecycle({ store, invoiceId, before: { status: 'open' }, after, nowMs: CLOSED_AT_MS + 1 }),
    ]);
    expect([a, b, c].filter((x) => x.class === 'success' || x.class === 'pending_reconciliation').length).toBe(3);
    expect((await store.getArtifact(waterTicketArtifactId(ticketId)))?.currentRevisionId).toBe('r1');
    expect(await store.getRevision(waterTicketArtifactId(ticketId), 'r2')).toBeNull();
  });

  it('partial persist failures retry into the same completed revision', async () => {
    const db = app.firestore();
    const ticketId = `${TICKET_20100_ID}-retry`;
    const invoiceId = `${INVOICE_20100_ID}-retry`;
    await db.collection('tickets').doc(ticketId).set({ ...ticket20100, id: ticketId, invoiceDocId: invoiceId });
    await db.collection('invoices').doc(invoiceId).set({ ...invoice20100, id: invoiceId, status: 'closed' });
    const bucket = memBucket();
    const store = storeFor(db, bucket);
    const origHtml = store.createHtmlBytes.bind(store);
    const origAsset = store.createAssetBytes.bind(store);
    const origFin = store.finalizeRevision.bind(store);
    const after = { ...invoice20100, id: invoiceId, status: 'closed', closedAtMs: CLOSED_AT_MS };

    store.createHtmlBytes = async () => { throw new Error('html_fail'); };
    expect((await applyInvoicePaperLifecycle({ store, invoiceId, before: { status: 'open' }, after, nowMs: CLOSED_AT_MS })).class).toBe('retriable');
    store.createHtmlBytes = origHtml;

    let assets = 0;
    store.createAssetBytes = async (path, bytes) => {
      assets += 1;
      if (assets === 1) throw new Error('asset_fail');
      return origAsset(path, bytes);
    };
    expect((await applyInvoicePaperLifecycle({ store, invoiceId, before: { status: 'open' }, after, nowMs: CLOSED_AT_MS })).class).toBe('retriable');
    store.createAssetBytes = origAsset;

    assets = 0;
    store.createAssetBytes = async (path, bytes) => {
      assets += 1;
      if (assets === 2) throw new Error('asset2_fail');
      return origAsset(path, bytes);
    };
    expect((await applyInvoicePaperLifecycle({ store, invoiceId, before: { status: 'open' }, after, nowMs: CLOSED_AT_MS })).class).toBe('retriable');
    store.createAssetBytes = origAsset;

    store.finalizeRevision = async () => { throw new Error('fin_fail'); };
    expect((await applyInvoicePaperLifecycle({ store, invoiceId, before: { status: 'open' }, after, nowMs: CLOSED_AT_MS })).class).toBe('retriable');
    store.finalizeRevision = origFin;

    const ok = await applyInvoicePaperLifecycle({ store, invoiceId, before: { status: 'open' }, after, nowMs: CLOSED_AT_MS });
    expect(ok.class).toBe('success');
    expect((await store.getArtifact(waterTicketArtifactId(ticketId)))?.currentRevisionId).toBe('r1');
    expect(await store.getRevision(waterTicketArtifactId(ticketId), 'r2')).toBeNull();
  });

  it('rejects the other company’s Storage object during materialize', async () => {
    const db = app.firestore();
    const ticketId = `${TICKET_20100_ID}-tenant`;
    const invoiceId = `${INVOICE_20100_ID}-tenant`;
    const otherUri = 'https://storage.googleapis.com/wellbuilt-sync.appspot.com/photos/other-co/inv-x/secret.jpg';
    const ownUri = `https://storage.googleapis.com/wellbuilt-sync.appspot.com/photos/${COMPANY_LG}/${invoiceId}/own.jpg`;
    await db.collection('tickets').doc(ticketId).set({ ...ticket20100, id: ticketId, invoiceDocId: invoiceId });
    await db.collection('invoices').doc(invoiceId).set({
      ...invoice20100,
      id: invoiceId,
      photos: [
        { uri: otherUri, type: 'pickup', location: 'X', takenAt: '2026-08-23T18:50:00.000Z' },
        { uri: ownUri, type: 'dropoff', location: 'Y', takenAt: '2026-08-23T19:50:00.000Z' },
      ],
    });
    const store = storeFor(db);
    const created = await materializeWaterTicketPaper({
      store, caller: staffLg, ticketDocId: ticketId, op: 'close', nowMs: CLOSED_AT_MS,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.revision.projection.photos).toHaveLength(1);
    expect(JSON.stringify(created.revision.projection.photos)).not.toContain('other-co');
    const cross = parseGovernedStorageUri(otherUri, {
      projectBucket: 'wellbuilt-sync.appspot.com',
      companyId: COMPANY_LG,
      invoiceDocId: invoiceId,
    });
    expect(cross).toMatchObject({ ok: false, reason: 'path_not_owned' });
  });

  it('retry of reserved edit A after live B still materializes A, then B as rN+1', async () => {
    const db = app.firestore();
    const ticketId = `${TICKET_20100_ID}-snap`;
    const invoiceId = `${INVOICE_20100_ID}-snap`;
    await db.collection('tickets').doc(ticketId).set({ ...ticket20100, id: ticketId, invoiceDocId: invoiceId });
    await db.collection('invoices').doc(invoiceId).set({ ...invoice20100, id: invoiceId, status: 'closed' });
    const store = storeFor(db);
    const close = await applyInvoicePaperLifecycle({
      store, invoiceId, before: { status: 'open' },
      after: { ...invoice20100, id: invoiceId, status: 'closed', closedAtMs: CLOSED_AT_MS },
      nowMs: CLOSED_AT_MS,
    });
    expect(close.class).toBe('success');

    const ticketA = { ...ticket20100, id: ticketId, invoiceDocId: invoiceId, pickupBbls: 80, dropoffBbls: 80, qty: '80', updatedAt: CLOSED_AT_MS + 5000 };
    await db.collection('tickets').doc(ticketId).set(ticketA);
    const origHtml = store.createHtmlBytes.bind(store);
    store.createHtmlBytes = async () => { throw new Error('html_fail'); };
    expect((await applyTicketPaperLifecycle({
      store, ticketId, before: { ...ticket20100, id: ticketId }, after: ticketA, nowMs: CLOSED_AT_MS + 5000,
    })).class).toBe('retriable');

    const ticketB = { ...ticketA, pickupBbls: 70, dropoffBbls: 70, qty: '70', updatedAt: CLOSED_AT_MS + 9000 };
    await db.collection('tickets').doc(ticketId).set(ticketB);
    store.createHtmlBytes = origHtml;
    const retryA = await applyTicketPaperLifecycle({
      store, ticketId, before: { ...ticket20100, id: ticketId }, after: ticketA, nowMs: CLOSED_AT_MS + 10000,
    });
    expect(retryA.class).toBe('success');
    const r2 = await store.getRevision(waterTicketArtifactId(ticketId), 'r2');
    expect(r2?.projection.pickupBbls).toBe('80');

    const doneB = await applyTicketPaperLifecycle({
      store, ticketId, before: ticketA, after: ticketB, nowMs: CLOSED_AT_MS + 11000,
    });
    expect(doneB.class).toBe('success');
    const art = await store.getArtifact(waterTicketArtifactId(ticketId));
    expect(art?.currentRevisionId).toBe('r3');
    const r3 = await store.getRevision(waterTicketArtifactId(ticketId), 'r3');
    expect(r3?.projection.pickupBbls).toBe('70');
    expect(await store.getRevision(waterTicketArtifactId(ticketId), 'r2')).toBeTruthy();
  });

  it('owned photo unavailable then readable yields one revision with the photo', async () => {
    const db = app.firestore();
    const ticketId = `${TICKET_20100_ID}-media`;
    const invoiceId = `${INVOICE_20100_ID}-media`;
    const ownUri = `https://storage.googleapis.com/wellbuilt-sync.appspot.com/photos/${COMPANY_LG}/${invoiceId}/own.jpg`;
    await db.collection('tickets').doc(ticketId).set({ ...ticket20100, id: ticketId, invoiceDocId: invoiceId });
    await db.collection('invoices').doc(invoiceId).set({
      ...invoice20100, id: invoiceId, photos: [{ uri: ownUri, type: 'pickup', location: 'X', takenAt: '2026-08-23T18:50:00.000Z' }],
    });
    const store = storeFor(db);
    const origRead = store.readLiveAsset.bind(store);
    store.readLiveAsset = async (uri, opts) => {
      if (uri === ownUri) return { ok: false, reason: 'asset_unavailable', retry: true };
      return origRead(uri, opts);
    };
    const first = await applyInvoicePaperLifecycle({
      store, invoiceId, before: { status: 'open' },
      after: { ...invoice20100, id: invoiceId, status: 'closed', closedAtMs: CLOSED_AT_MS, photos: [{ uri: ownUri, type: 'pickup', location: 'X', takenAt: '2026-08-23T18:50:00.000Z' }] },
      nowMs: CLOSED_AT_MS,
    });
    expect(first.class).toBe('retriable');
    expect(await store.getRevision(waterTicketArtifactId(ticketId), 'r1')).toBeNull();
    store.readLiveAsset = origRead;
    const retry = await applyInvoicePaperLifecycle({
      store, invoiceId, before: { status: 'open' },
      after: { ...invoice20100, id: invoiceId, status: 'closed', closedAtMs: CLOSED_AT_MS, photos: [{ uri: ownUri, type: 'pickup', location: 'X', takenAt: '2026-08-23T18:50:00.000Z' }] },
      nowMs: CLOSED_AT_MS + 1,
    });
    expect(retry.class).toBe('success');
    const rev = await store.getRevision(waterTicketArtifactId(ticketId), 'r1');
    expect(rev?.projection.photos).toHaveLength(1);
    expect(await store.getRevision(waterTicketArtifactId(ticketId), 'r2')).toBeNull();
  });

  it('one correction touching ticket and invoice creates exactly one new revision', async () => {
    const db = app.firestore();
    const ticketId = `${TICKET_20100_ID}-mut`;
    const invoiceId = `${INVOICE_20100_ID}-mut`;
    await db.collection('tickets').doc(ticketId).set({ ...ticket20100, id: ticketId, invoiceDocId: invoiceId });
    await db.collection('invoices').doc(invoiceId).set({ ...invoice20100, id: invoiceId, status: 'closed' });
    const store = storeFor(db);
    const close = await applyInvoicePaperLifecycle({
      store, invoiceId, before: { status: 'open' },
      after: { ...invoice20100, id: invoiceId, status: 'closed', closedAtMs: CLOSED_AT_MS },
      nowMs: CLOSED_AT_MS,
    });
    expect(close.class).toBe('success');
    const dispatchCap = { ...dispatchLg, caps: ['createDispatch'] };
    const review = await store.getWorkflow(ticketId);
    const corrected = await applyTicketReviewAction({
      store, caller: dispatchCap, ticketDocId: ticketId, action: 'correct', fields: { truck: '888' }, nowMs: CLOSED_AT_MS + 10, expectedVersion: review?.version ?? 1,
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    const ticketAfter = await store.getTicket(ticketId);
    const invoiceAfter = await store.getInvoice(invoiceId);
    const [tLife, iLife] = await Promise.all([
      applyTicketPaperLifecycle({
        store, ticketId, before: { ...ticket20100, id: ticketId }, after: { ...(ticketAfter as object) } as Record<string, unknown>, nowMs: CLOSED_AT_MS + 11,
      }),
      applyInvoicePaperLifecycle({
        store, invoiceId, before: { ...invoice20100, id: invoiceId, status: 'closed' }, after: { ...(invoiceAfter as object) } as Record<string, unknown>, nowMs: CLOSED_AT_MS + 11,
      }),
    ]);
    expect(tLife.class === 'success' || iLife.class === 'success').toBe(true);
    expect(await store.getRevision(waterTicketArtifactId(ticketId), 'r2')).toBeTruthy();
    expect(await store.getRevision(waterTicketArtifactId(ticketId), 'r3')).toBeNull();

    const mutationA = corrected.mutationId;
    const ticketEditMs = CLOSED_AT_MS + 20;
    const ticketBefore = { ...(ticketAfter as object) } as Record<string, unknown>;
    const ticketOrdinary = { ...ticketBefore, location: 'NEW WELL', paperMutationId: mutationA, updatedAt: ticketEditMs };
    await db.collection('tickets').doc(ticketId).set(ticketOrdinary);
    const t3 = await applyTicketPaperLifecycle({
      store, ticketId, before: ticketBefore, after: ticketOrdinary, nowMs: ticketEditMs,
    });
    expect(t3.class).toBe('success');
    expect(await store.getRevision(waterTicketArtifactId(ticketId), 'r3')).toBeTruthy();

    const invoiceEditMs = CLOSED_AT_MS + 30;
    const invoiceBefore = { ...(invoiceAfter as object) } as Record<string, unknown>;
    const invoiceOrdinary = { ...invoiceBefore, operator: 'Edited Operator', paperMutationId: mutationA, updatedAt: invoiceEditMs, editedAt: invoiceEditMs };
    await db.collection('invoices').doc(invoiceId).set(invoiceOrdinary);
    const i4 = await applyInvoicePaperLifecycle({
      store, invoiceId, before: invoiceBefore, after: invoiceOrdinary, nowMs: invoiceEditMs,
    });
    expect(i4.class).toBe('success');
    expect(await store.getRevision(waterTicketArtifactId(ticketId), 'r4')).toBeTruthy();
    expect(await store.getRevision(waterTicketArtifactId(ticketId), 'r5')).toBeNull();
  });

  it('concurrent corrections with the same expectedVersion produce one success and one version_conflict', async () => {
    const db = app.firestore();
    const ticketId = `${TICKET_20100_ID}-cas`;
    const invoiceId = `${INVOICE_20100_ID}-cas`;
    await db.collection('tickets').doc(ticketId).set({ ...ticket20100, id: ticketId, invoiceDocId: invoiceId });
    await db.collection('invoices').doc(invoiceId).set({ ...invoice20100, id: invoiceId, status: 'closed' });
    const store = storeFor(db);
    const close = await applyInvoicePaperLifecycle({
      store, invoiceId, before: { status: 'open' },
      after: { ...invoice20100, id: invoiceId, status: 'closed', closedAtMs: CLOSED_AT_MS },
      nowMs: CLOSED_AT_MS,
    });
    expect(close.class).toBe('success');
    const dispatchCap = { ...dispatchLg, caps: ['createDispatch'] };
    const review = await store.getWorkflow(ticketId);
    const version = review?.version ?? 1;
    const [a, b] = await Promise.all([
      applyTicketReviewAction({
        store, caller: dispatchCap, ticketDocId: ticketId, action: 'correct', fields: { truck: '111' }, nowMs: CLOSED_AT_MS + 10, expectedVersion: version,
      }),
      applyTicketReviewAction({
        store, caller: dispatchCap, ticketDocId: ticketId, action: 'correct', fields: { truck: '222' }, nowMs: CLOSED_AT_MS + 10, expectedVersion: version,
      }),
    ]);
    const ok = [a, b].filter((x) => x.ok);
    const fail = [a, b].filter((x) => !x.ok);
    expect(ok).toHaveLength(1);
    expect(fail).toHaveLength(1);
    expect(fail[0]).toMatchObject({ ok: false, reason: 'version_conflict' });
  });

  it('batch retry returns original results and rejects duplicate ids', async () => {
    const db = app.firestore();
    const ticketId = `${TICKET_20100_ID}-batch`;
    const invoiceId = `${INVOICE_20100_ID}-batch`;
    await db.collection('tickets').doc(ticketId).set({ ...ticket20100, id: ticketId, invoiceDocId: invoiceId });
    await db.collection('invoices').doc(invoiceId).set({ ...invoice20100, id: invoiceId, status: 'closed' });
    const store = storeFor(db);
    expect((await applyInvoicePaperLifecycle({
      store, invoiceId, before: { status: 'open' },
      after: { ...invoice20100, id: invoiceId, status: 'closed', closedAtMs: CLOSED_AT_MS },
      nowMs: CLOSED_AT_MS,
    })).class).toBe('success');
    const dispatchCap = { ...dispatchLg, caps: ['createDispatch'] };
    const review = await store.getWorkflow(ticketId);
    const items = [{ ticketDocId: ticketId, expectedVersion: review?.version ?? 1 }];
    const first = await applyTicketReviewBatch({
      store, caller: dispatchCap, action: 'hand_to_payroll', items, batchId: 'emu-batch-1', nowMs: CLOSED_AT_MS + 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const retry = await applyTicketReviewBatch({
      store, caller: dispatchCap, action: 'hand_to_payroll', items, batchId: 'emu-batch-1', nowMs: CLOSED_AT_MS + 2,
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.idempotent).toBe(true);
    expect(retry.results).toEqual(first.results);
    const clash = await applyTicketReviewBatch({
      store, caller: dispatchCap, action: 'finalize_to_billing', items, batchId: 'emu-batch-1', nowMs: CLOSED_AT_MS + 3,
    });
    expect(clash).toMatchObject({ ok: false, reason: 'batch_id_conflict' });
    const dup = await applyTicketReviewBatch({
      store,
      caller: dispatchCap,
      action: 'hand_to_payroll',
      batchId: 'emu-batch-dup',
      items: [
        { ticketDocId: ticketId, expectedVersion: 1 },
        { ticketDocId: ticketId, expectedVersion: 1 },
      ],
      nowMs: CLOSED_AT_MS + 4,
    });
    expect(dup).toMatchObject({ ok: false, reason: 'duplicate_ticket' });
  });

  it('deleted live sources remain stage-aware for paper bytes', async () => {
    const db = app.firestore();
    const ticketId = `${TICKET_20100_ID}-hist`;
    const invoiceId = `${INVOICE_20100_ID}-hist`;
    await db.collection('tickets').doc(ticketId).set({ ...ticket20100, id: ticketId, invoiceDocId: invoiceId });
    await db.collection('invoices').doc(invoiceId).set({ ...invoice20100, id: invoiceId, status: 'closed' });
    const store = storeFor(db);
    expect((await applyInvoicePaperLifecycle({
      store, invoiceId, before: { status: 'open' },
      after: { ...invoice20100, id: invoiceId, status: 'closed', closedAtMs: CLOSED_AT_MS },
      nowMs: CLOSED_AT_MS,
    })).class).toBe('success');
    const dispatchCap = { ...dispatchLg, caps: ['createDispatch', 'viewDispatch'] };
    const payrollCap = { ...payrollLg, caps: ['approvePayroll', 'viewPayroll'] };
    await db.collection('tickets').doc(ticketId).delete();
    await db.collection('invoices').doc(invoiceId).delete();
    expect((await getWaterTicketPaper({
      store, caller: dispatchCap, lookup: { ticketDocId: ticketId }, nowMs: CLOSED_AT_MS,
    })).ok).toBe(true);
    expect((await getWaterTicketPaper({
      store, caller: payrollCap, lookup: { ticketDocId: ticketId }, nowMs: CLOSED_AT_MS,
    })).ok).toBe(false);
    expect((await getWaterTicketPaper({
      store, caller: driverOwner, lookup: { ticketDocId: ticketId }, nowMs: CLOSED_AT_MS,
    })).ok).toBe(true);
    expect((await getWaterTicketPaper({
      store, caller: driverOther, lookup: { ticketDocId: ticketId }, nowMs: CLOSED_AT_MS,
    })).ok).toBe(false);
    expect((await getWaterTicketPaper({
      store, caller: staffOther, lookup: { ticketDocId: ticketId }, nowMs: CLOSED_AT_MS,
    })).ok).toBe(false);
  });

  it('mirrored stale invoice truck creates one correction revision', async () => {
    const db = app.firestore();
    const ticketId = `${TICKET_20100_ID}-mirror`;
    const invoiceId = `${INVOICE_20100_ID}-mirror`;
    await db.collection('tickets').doc(ticketId).set({ ...ticket20100, id: ticketId, invoiceDocId: invoiceId });
    await db.collection('invoices').doc(invoiceId).set({ ...invoice20100, id: invoiceId, status: 'closed', truckNumber: '000' });
    const store = storeFor(db);
    expect((await applyInvoicePaperLifecycle({
      store, invoiceId, before: { status: 'open' },
      after: { ...invoice20100, id: invoiceId, status: 'closed', closedAtMs: CLOSED_AT_MS, truckNumber: '000' },
      nowMs: CLOSED_AT_MS,
    })).class).toBe('success');
    const dispatchCap = { ...dispatchLg, caps: ['createDispatch'] };
    const review = await store.getWorkflow(ticketId);
    const corrected = await applyTicketReviewAction({
      store, caller: dispatchCap, ticketDocId: ticketId, action: 'correct',
      fields: { truck: '102' }, nowMs: CLOSED_AT_MS + 10, expectedVersion: review?.version ?? 1,
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    const ticketAfter = await store.getTicket(ticketId);
    const invoiceAfter = await store.getInvoice(invoiceId);
    await Promise.all([
      applyTicketPaperLifecycle({
        store, ticketId,
        before: { ...ticket20100, id: ticketId } as Record<string, unknown>,
        after: { ...(ticketAfter as object) } as Record<string, unknown>,
        nowMs: CLOSED_AT_MS + 11,
      }),
      applyInvoicePaperLifecycle({
        store, invoiceId,
        before: { ...invoice20100, id: invoiceId, status: 'closed', truckNumber: '000' } as Record<string, unknown>,
        after: { ...(invoiceAfter as object) } as Record<string, unknown>,
        nowMs: CLOSED_AT_MS + 11,
      }),
    ]);
    expect(await store.getRevision(waterTicketArtifactId(ticketId), 'r2')).toBeTruthy();
    expect(await store.getRevision(waterTicketArtifactId(ticketId), 'r3')).toBeNull();
  });
});
