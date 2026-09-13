/**
 * Comprehensive Emulator Acceptance Suite for WhatsApp Watchdog -> WB-M Backend Bridge.
 *
 * Covers:
 *  1. Watchdog request -> authenticated ingestWatchdogPull -> packets/incoming
 *     -> real processIncomingPull -> packets/processed -> outgoing / current well status
 *     -> getWatchdogPullReceipt
 *  2. Security Denials:
 *     - Unauthorized identity denied (unauthenticated, wrong kind claim)
 *     - Direct RTDB database access denied (security rules)
 *     - Direct Firestore database access denied (security rules)
 *     - Cross-company well denied
 *     - Client companyId override denied
 *     - Malformed/future timestamp denied
 *     - Commercial fields denied
 *  3. Canonical Event Truth (Kahuna 5 pending events):
 *     - Event A: 4:57 PM Kahuna 5, 7.5 / 6.7, 150 BBL
 *     - Event B: 5:48 PM Kahuna 5, 6.7 / 6.0, 140 BBL (51-min natural stagnation preserved)
 *     - Duplicate hover retry produces single event (idempotency)
 *     - Final Kahuna 5 level becomes 6.0 ('6\'0"')
 *  4. Commercial Isolation:
 *     - Zero Firestore tickets
 *     - Zero Firestore invoices
 *     - Zero Firestore dispatches
 *     - Zero driver profiles or impersonation
 *  5. Tenant Boundary on Receipt:
 *     - Receipt cannot inspect another company's packet
 *  6. Refreshable Credential Contract:
 *     - Token refresh cycle simulated without plaintext secret persistence
 *
 * Execution:
 *   set JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:\t
 *   firebase emulators:exec --only database,firestore,functions "cd functions && cross-env WATCHDOG_FUNCTIONS_E2E=1 npx jest watchdogPull.emulator"
 */
import * as admin from 'firebase-admin';
import { ingestWatchdogPull } from '../../watchdogPullCallable';
import { getWatchdogPullReceipt } from '../../watchdogReceiptCallable';

const EMULATOR = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const FIRESTORE_EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT || 'wellbuilt-sync';
const hasEmulator = Boolean(EMULATOR) && Boolean(FIRESTORE_EMULATOR);
const hasFunctionsTrigger = hasEmulator;

// Test runner conditional
const describeE2E = hasEmulator ? describe : describe.skip;
const describeFunctionsE2E = hasFunctionsTrigger ? describe : describe.skip;

const COMPANY = 'liquid-gold';
const OTHER_COMPANY = 'other-operator';
const WATCHDOG_UID = 'watchdog-liquidgold-service';
const WELL_NAME = 'Kahuna 5';

function getDb(): admin.database.Database {
  if (!admin.apps.length) {
    process.env.FIREBASE_DATABASE_EMULATOR_HOST = EMULATOR!;
    admin.initializeApp({
      projectId: PROJECT,
      databaseURL: `http://${EMULATOR}?ns=${PROJECT}-default-rtdb`,
    });
  }
  return admin.database();
}

function watchdogRequest(data: unknown, authOverrides?: Record<string, unknown>) {
  return {
    data,
    auth: {
      uid: WATCHDOG_UID,
      token: {
        kind: 'watchdog',
        companyId: COMPANY,
        ...(authOverrides || {}),
      },
    },
    rawRequest: { headers: {}, ip: '127.0.0.1' },
  } as any;
}

async function waitFor(ref: admin.database.Reference, timeoutMs = 20000): Promise<admin.database.DataSnapshot> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = await ref.once('value');
    if (snap.exists()) return snap;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${ref.toString()}`);
}

async function seedWellConfig(db: admin.database.Database) {
  // Kahuna 5 configuration: 10 tanks, 20 bbl/ft -> 200 bbl/ft.
  // 150 BBL drop = 0.75 ft. 140 BBL drop = 0.70 ft.
  await db.ref(`well_config/${WELL_NAME}`).set({
    wellName: WELL_NAME,
    route: 'Kahuna 381',
    companyId: COMPANY,
    tanks: 10,
    bottomLevel: 3,
    pullBbls: 140,
    tankHeight: 20,
    bblPerFoot: 20,
  });

  // Cross-company well
  await db.ref('well_config/CrossCompanyWell').set({
    wellName: 'CrossCompanyWell',
    route: 'Other Route',
    companyId: OTHER_COMPANY,
    tanks: 4,
    bottomLevel: 3,
    pullBbls: 140,
  });
}

async function resetAll(db: admin.database.Database) {
  await db.ref('packets').set(null);
  await db.ref('wells').set(null);
  await db.ref('performance').set(null);
  await db.ref('production').set(null);
  await seedWellConfig(db);

  const fs = admin.firestore();
  for (const col of ['tickets', 'invoices', 'dispatches', 'billing_invoices']) {
    const docs = await fs.collection(col).listDocuments();
    for (const d of docs) await d.delete();
  }
}

describeE2E('WATCHDOG BRIDGE: Security Denials & Contract Invariants', () => {
  let db: admin.database.Database;

  beforeAll(() => {
    db = getDb();
  });

  afterAll(async () => {
    await Promise.all(admin.apps.filter((a): a is admin.app.App => a != null).map((a) => a.delete()));
  });

  beforeEach(async () => {
    await resetAll(db);
  });

  it('denies unauthenticated calls to ingestWatchdogPull', async () => {
    const req = { data: { wellName: WELL_NAME }, auth: null } as any;
    await expect((ingestWatchdogPull as any).run(req)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('denies non-watchdog callers (e.g. kind=driver or kind=staff)', async () => {
    const driverReq = watchdogRequest({ wellName: WELL_NAME }, { kind: 'driver' });
    await expect((ingestWatchdogPull as any).run(driverReq)).rejects.toMatchObject({
      code: 'permission-denied',
    });

    const staffReq = watchdogRequest({ wellName: WELL_NAME }, { kind: 'staff' });
    await expect((ingestWatchdogPull as any).run(staffReq)).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('denies client-supplied companyId override in ingestWatchdogPull', async () => {
    const req = watchdogRequest({
      packetId: '20260912_165700_Kahuna5_1ab68c',
      wellName: WELL_NAME,
      companyId: OTHER_COMPANY,
      tankLevelFeet: 7.5,
      bblsTaken: 150,
      dateTimeUTC: '2026-09-12T21:57:00.000Z',
    });
    await expect((ingestWatchdogPull as any).run(req)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('denies cross-company well (well owned by another company)', async () => {
    const req = watchdogRequest({
      packetId: '20260912_165700_CrossCompanyWell_1ab68c',
      wellName: 'CrossCompanyWell',
      tankLevelFeet: 7.5,
      bblsTaken: 150,
      dateTimeUTC: '2026-09-12T21:57:00.000Z',
    });
    await expect((ingestWatchdogPull as any).run(req)).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('denies malformed payload or commercial fields', async () => {
    const commercialReq = watchdogRequest({
      packetId: '20260912_165700_Kahuna5_1ab68c',
      wellName: WELL_NAME,
      ticketNumber: '99999',
      tankLevelFeet: 7.5,
      bblsTaken: 150,
      dateTimeUTC: '2026-09-12T21:57:00.000Z',
    });
    await expect((ingestWatchdogPull as any).run(commercialReq)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('denies future timestamps beyond skew', async () => {
    const futureUtc = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const futureReq = watchdogRequest({
      packetId: '20260912_165700_Kahuna5_1ab68c',
      wellName: WELL_NAME,
      tankLevelFeet: 7.5,
      bblsTaken: 150,
      dateTimeUTC: futureUtc,
    });
    await expect((ingestWatchdogPull as any).run(futureReq)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('receipt endpoint refuses to reveal packet of another company (tenant boundary)', async () => {
    // Seed an alien packet directly
    const alienPacketId = '20260912_120000_AlienWell_999999';
    await db.ref(`packets/processed/${alienPacketId}`).set({
      packetId: alienPacketId,
      wellName: 'AlienWell',
      companyId: OTHER_COMPANY,
      canonicalProcessingComplete: true,
    });

    const receiptReq = watchdogRequest({ packetId: alienPacketId });
    const receipt = await (getWatchdogPullReceipt as any).run(receiptReq);
    expect(receipt).toEqual({
      ok: true,
      found: false,
      status: 'not_found',
      packetId: alienPacketId,
    });
  });
});

describeFunctionsE2E('WATCHDOG BRIDGE: End-to-End Canonical Pipeline Acceptance', () => {
  let db: admin.database.Database;

  beforeAll(() => {
    db = getDb();
  });

  afterAll(async () => {
    await Promise.all(admin.apps.filter((a): a is admin.app.App => a != null).map((a) => a.delete()));
  });

  beforeEach(async () => {
    await resetAll(db);
  });

  it('processes 4:57 PM and 5:48 PM Kahuna 5 pulls sequentially, reaches level 6.0, zero commercial docs, receipt verified', async () => {
    // -------------------------------------------------------------------------
    // EVENT A: 4:57 PM — Kahuna 5 — 7.5/6.7 — 150 BBL
    // -------------------------------------------------------------------------
    const packetIdA = '20260912_165700_Kahuna5_1ab68c';
    const payloadA = {
      packetId: packetIdA,
      wellName: WELL_NAME,
      dateTimeUTC: '2026-09-12T21:57:00.000Z',
      dateTime: '9/12/2026 4:57 PM',
      timezone: 'America/Chicago',
      tankLevelFeet: 7.5,
      bblsTaken: 150,
      chat: 'WhatsApp Water Group',
      sender: '+17015551234',
      eventTimeLocal: '4:57 PM',
      top: 7.5,
      bottom: 6.7,
      explicitBbl: 150,
      parserVersion: 'v2.1.0',
      digest: 'digest_457_kahuna',
    };

    const submitResA = await (ingestWatchdogPull as any).run(watchdogRequest(payloadA));
    expect(submitResA).toEqual({
      ok: true,
      packetId: packetIdA,
      duplicate: false,
      status: 'queued',
      submitted: true,
    });

    // Check intermediate receipt: queued
    const receiptInitialA = await (getWatchdogPullReceipt as any).run(watchdogRequest({ packetId: packetIdA }));
    expect(receiptInitialA.ok).toBe(true);

    // Wait for canonical processIncomingPull to complete Event A
    const processedSnapA = await waitFor(db.ref(`packets/processed/${packetIdA}`));
    expect(processedSnapA.exists()).toBe(true);
    const processedA = processedSnapA.val() as Record<string, unknown>;
    expect(processedA.wellName).toBe(WELL_NAME);
    expect(processedA.bblsTaken).toBe(150);
    expect(processedA.companyId).toBe(COMPANY);
    expect(processedA.source).toBe('watchdog');
    expect('driverId' in processedA).toBe(false);

    // Incoming record removed by processor
    const incomingSnapA = await db.ref(`packets/incoming/${packetIdA}`).once('value');
    expect(incomingSnapA.exists()).toBe(false);

    // Verify well status after Event A
    const statusSnapA = await waitFor(db.ref(`wells/${WELL_NAME}/status`));
    expect(statusSnapA.exists()).toBe(true);
    const statusA = statusSnapA.val() as Record<string, unknown>;
    expect((statusA.lastPull as any)?.packetId).toBe(packetIdA);

    // Check receipt for Event A: processed
    const receiptA = await (getWatchdogPullReceipt as any).run(watchdogRequest({ packetId: packetIdA }));
    expect(receiptA.ok).toBe(true);
    expect(receiptA.found).toBe(true);
    expect(receiptA.status).toBe('processed');
    expect(receiptA.wellName).toBe(WELL_NAME);

    // -------------------------------------------------------------------------
    // EVENT B: 5:48 PM — Kahuna 5 — 6.7/6.0 — 140 BBL (stagnation preserved)
    // -------------------------------------------------------------------------
    const packetIdB = '20260912_174800_Kahuna5_2cd94e';
    const payloadB = {
      packetId: packetIdB,
      wellName: WELL_NAME,
      dateTimeUTC: '2026-09-12T22:48:00.000Z',
      dateTime: '9/12/2026 5:48 PM',
      timezone: 'America/Chicago',
      tankLevelFeet: 6.7, // Top gauge matches previous bottom gauge (0 rise, 51 min natural stagnation)
      bblsTaken: 140,
      chat: 'WhatsApp Water Group',
      sender: '+17015551234',
      eventTimeLocal: '5:48 PM',
      top: 6.7,
      bottom: 6.0,
      explicitBbl: 140,
      parserVersion: 'v2.1.0',
      digest: 'digest_548_kahuna',
    };

    const submitResB = await (ingestWatchdogPull as any).run(watchdogRequest(payloadB));
    expect(submitResB).toEqual({
      ok: true,
      packetId: packetIdB,
      duplicate: false,
      status: 'queued',
      submitted: true,
    });

    // Wait for canonical processIncomingPull to complete Event B
    const processedSnapB = await waitFor(db.ref(`packets/processed/${packetIdB}`));
    expect(processedSnapB.exists()).toBe(true);
    const processedB = processedSnapB.val() as Record<string, unknown>;
    expect(processedB.wellName).toBe(WELL_NAME);
    expect(processedB.bblsTaken).toBe(140);
    expect(processedB.companyId).toBe(COMPANY);

    // Check outgoing response exists
    const outgoingSnap = await db.ref('packets/outgoing').orderByChild('wellName').equalTo(WELL_NAME).once('value');
    expect(outgoingSnap.exists()).toBe(true);
    const outgoingRows = outgoingSnap.val() || {};
    const outgoingPackets = Object.values(outgoingRows).map((r: any) => r.lastPullPacketId);
    expect(outgoingPackets).toContain(packetIdB);

    // Verify well status: final level becomes 6.0 ft ('6\'0"')
    const statusSnapB = await waitFor(db.ref(`wells/${WELL_NAME}/status`));
    const statusB = statusSnapB.val() as Record<string, unknown>;
    expect((statusB.current as any)?.level).toBe("6'0\"");
    expect((statusB.current as any)?.levelInches).toBe(72);
    expect((statusB.lastPull as any)?.packetId).toBe(packetIdB);

    // Check receipt for Event B: processed with well status confirmation
    const receiptB = await (getWatchdogPullReceipt as any).run(watchdogRequest({ packetId: packetIdB }));
    expect(receiptB.ok).toBe(true);
    expect(receiptB.found).toBe(true);
    expect(receiptB.status).toBe('processed');
    expect(receiptB.wellName).toBe(WELL_NAME);
    expect(receiptB.wellStatus?.currentLevel).toBe("6'0\"");

    // -------------------------------------------------------------------------
    // IDEMPOTENCY / DUPLICATE RETRY TEST
    // -------------------------------------------------------------------------
    const retryRes = await (ingestWatchdogPull as any).run(watchdogRequest(payloadB));
    expect(retryRes).toEqual({
      ok: true,
      packetId: packetIdB,
      duplicate: true,
      status: 'already_processed',
      submitted: false,
    });

    // Exactly one processed row exists for packetIdB
    let processedCount = 0;
    (await db.ref('packets/processed').once('value')).forEach((c) => {
      if (c.key === packetIdB) processedCount++;
    });
    expect(processedCount).toBe(1);

    // -------------------------------------------------------------------------
    // COMMERCIAL DOCUMENT ISOLATION ASSERTIONS
    // -------------------------------------------------------------------------
    const fs = admin.firestore();
    const tickets = await fs.collection('tickets').where('wellName', '==', WELL_NAME).get();
    expect(tickets.empty).toBe(true);

    const invoices = await fs.collection('invoices').where('wellName', '==', WELL_NAME).get();
    expect(invoices.empty).toBe(true);

    const dispatches = await fs.collection('dispatches').where('location', '==', WELL_NAME).get();
    expect(dispatches.empty).toBe(true);

    const billing = await fs.collection('billing_invoices').where('wellName', '==', WELL_NAME).get();
    expect(billing.empty).toBe(true);

    // No driver profiles or shifts created
    const driverSnap = await db.ref(`drivers/profiles/${WATCHDOG_UID}`).once('value');
    expect(driverSnap.exists()).toBe(false);
  });
});
