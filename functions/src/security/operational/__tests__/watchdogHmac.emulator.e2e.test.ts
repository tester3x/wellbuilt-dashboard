import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as admin from 'firebase-admin';
import {
  ingestWatchdogPull,
  getWatchdogPullReceipt,
} from '../../watchdogHmacEndpoints';
import {
  computeBodySha256,
  buildStringToSign,
  WATCHDOG_PRINCIPAL_ID,
  WATCHDOG_COMPANY_ID,
} from '../watchdogHmac';
const projectId = 'demo-watchdog-canonical';
process.env.GCLOUD_PROJECT = projectId;
if (!process.env.FIREBASE_CONFIG) {
  process.env.FIREBASE_CONFIG = JSON.stringify({ projectId, databaseURL: `https://${projectId}-default-rtdb.firebaseio.com` });
}

const hasEmulator = Boolean(process.env.FIREBASE_DATABASE_EMULATOR_HOST && process.env.FIRESTORE_EMULATOR_HOST);
const describeE2E = hasEmulator ? describe : describe.skip;

const secret = 'demo-watchdog-hmac-secret-key-32chars!';

function sign(endpointName: string, method: string, rawBody: string, timestamp: number, nonce: string, keyId = 'v1') {
  const bodySha = computeBodySha256(rawBody);
  const stringToSign = buildStringToSign({
    endpointName,
    method,
    timestamp,
    nonce,
    bodySha256: bodySha,
  });
  const signature = crypto.createHmac('sha256', secret).update(stringToSign).digest('hex');
  return {
    'x-watchdog-key-id': keyId,
    'x-watchdog-timestamp': String(timestamp),
    'x-watchdog-nonce': nonce,
    'x-watchdog-signature': signature,
    'content-type': 'application/json',
  };
}

class MockResponse extends EventEmitter {
  statusCode = 200;
  body: any = null;
  headers: Record<string, string> = {};

  status(code: number) {
    this.statusCode = code;
    return this;
  }
  json(data: any) {
    this.body = data;
    this.emit('finish');
    return this;
  }
  send(data: any) {
    this.body = data;
    this.emit('finish');
    return this;
  }
  setHeader(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  }
  getHeader(k: string) {
    return this.headers[k.toLowerCase()];
  }
}

function mockReqRes(method: string, headers: Record<string, string>, body: any) {
  const rawBody = Buffer.from(typeof body === 'object' ? JSON.stringify(body) : String(body || ''), 'utf8');
  const req: any = {
    method,
    headers,
    body,
    rawBody,
    query: {},
  };
  const res = new MockResponse();

  return {
    req,
    res,
    getResponse: () => ({ status: res.statusCode, body: res.body }),
  };
}

describeE2E('WATCHDOG BRIDGE: End-to-End HMAC Emulator Acceptance', () => {
  let db: admin.database.Database;
  let processIncomingPull: any;
  const wellName = 'Kahuna 5';

  beforeAll(async () => {
    processIncomingPull = require('../../../index').processIncomingPull;
    db = admin.database();
    await db.ref('well_config/Kahuna 5').set({
      wellName: 'Kahuna 5',
      companyId: 'liquid-gold',
      route: 'Kahuna 381',
      tanks: 10,
      bottomLevel: 3,
      pullBbls: 140,
      tankHeight: 20,
      bblPerFoot: 20,
    });
  });

  afterAll(async () => {
    if (db) {
      db.goOffline();
    }
    await Promise.all(admin.apps.map((app) => app?.delete()));
  });

  beforeEach(async () => {
    await db.ref('packets/incoming').remove();
    await db.ref('packets/processed').remove();
    await db.ref('packets/outgoing').remove();
    await db.ref('wells/Kahuna 5/status').remove();
    await db.ref('integration_ledgers/watchdog').remove();
  });

  test('Denials: rejects invalid HMAC, replayed nonces, cross-endpoint signatures, and forbidden company/driver fields', async () => {
    const now = Date.now();
    const packetId = '20260912_165700_Kahuna5_1ab68c';
    const payload = {
      packetId,
      wellName,
      top: 7.5,
      bottom: 6.7,
      explicitBbl: 150,
      dateTimeUTC: '2026-09-12T21:57:00.000Z',
    };

    // 1. Bad signature
    const badHeaders = sign('ingestWatchdogPull', 'POST', JSON.stringify(payload), now, 'nonce_test_bad_sig');
    badHeaders['x-watchdog-signature'] = '0000000000000000000000000000000000000000000000000000000000000000';
    const badMock = mockReqRes('POST', badHeaders, payload);
    await (ingestWatchdogPull as any)(badMock.req, badMock.res);
    expect(badMock.getResponse().status).toBe(401);
    expect(badMock.getResponse().body.error).toBe('signature_mismatch');

    // 2. Cross-endpoint signature reuse
    const crossHeaders = sign('getWatchdogPullReceipt', 'POST', JSON.stringify(payload), now, 'nonce_test_cross');
    const crossMock = mockReqRes('POST', crossHeaders, payload);
    await (ingestWatchdogPull as any)(crossMock.req, crossMock.res);
    expect(crossMock.getResponse().status).toBe(401);
    expect(crossMock.getResponse().body.error).toBe('signature_mismatch');

    // 3. Client companyId override forbidden
    const companyOverridePayload = { ...payload, companyId: 'other-co' };
    const coHeaders = sign('ingestWatchdogPull', 'POST', JSON.stringify(companyOverridePayload), now, 'nonce_test_co_override');
    const coMock = mockReqRes('POST', coHeaders, companyOverridePayload);
    await (ingestWatchdogPull as any)(coMock.req, coMock.res);
    expect(coMock.getResponse().status).toBe(400);
    expect(coMock.getResponse().body.error).toBe('forbidden_field:companyId');

    // 4. Client driverId forbidden
    const driverPayload = { ...payload, driverId: 'fake-driver' };
    const drvHeaders = sign('ingestWatchdogPull', 'POST', JSON.stringify(driverPayload), now, 'nonce_test_driver');
    const drvMock = mockReqRes('POST', drvHeaders, driverPayload);
    await (ingestWatchdogPull as any)(drvMock.req, drvMock.res);
    expect(drvMock.getResponse().status).toBe(400);
    expect(drvMock.getResponse().body.error).toBe('forbidden_field:driverId');
  });

  test('Acceptance: Event A (7.5->6.7) and Event B (6.7->6.0) sequential completion + receipt verification', async () => {
    const now = Date.now();

    // -------------------------------------------------------------------------
    // EVENT A: 4:57 PM — Kahuna 5 — 7.5 / 6.7 — 150 BBL
    // -------------------------------------------------------------------------
    const packetIdA = '20260912_165700_Kahuna5_1ab68c';
    const payloadA = {
      packetId: packetIdA,
      wellName,
      top: 7.5,
      bottom: 6.7,
      explicitBbl: 150,
      dateTimeUTC: '2026-09-12T21:57:00.000Z',
      chat: 'WhatsApp Water Group',
      sender: '+17015551234',
    };

    const headersA = sign('ingestWatchdogPull', 'POST', JSON.stringify(payloadA), now, 'nonce_evt_a');
    const mockA = mockReqRes('POST', headersA, payloadA);
    await (ingestWatchdogPull as any)(mockA.req, mockA.res);

    expect(mockA.getResponse().status).toBe(200);
    expect(mockA.getResponse().body).toEqual({
      ok: true,
      packetId: packetIdA,
      duplicate: false,
      status: 'queued',
      submitted: true,
    });

    // Replay with same nonce -> 401 replay_detected
    const replayMock = mockReqRes('POST', headersA, payloadA);
    await (ingestWatchdogPull as any)(replayMock.req, replayMock.res);
    expect(replayMock.getResponse().status).toBe(401);
    expect(replayMock.getResponse().body.error).toBe('replay_detected');

    // Run real processIncomingPull for Event A
    const incomingRefA = db.ref(`packets/incoming/${packetIdA}`);
    const snapA = await incomingRefA.once('value');
    expect(snapA.exists()).toBe(true);

    await processIncomingPull.run(snapA as any, {
      params: { packetId: packetIdA },
      eventId: 'test-' + packetIdA,
    });

    // Verify Event A processed state
    const processedA = (await db.ref(`packets/processed/${packetIdA}`).once('value')).val();
    expect(processedA).toBeTruthy();
    expect(processedA.canonicalProcessingComplete).toBe(true);
    expect(processedA.tankAfterInches).toBe(80.4); // 6.7 ft preserved!
    expect(processedA.companyId).toBe('liquid-gold');
    expect(processedA.driverId).toBeUndefined();

    // Verify well status
    const statusA = (await db.ref(`wells/${wellName}/status`).once('value')).val();
    expect(statusA.current.levelInches).toBe(80.4);
    expect(statusA.lastPull.packetId).toBe(packetIdA);

    // Verify receipt endpoint for Event A
    const receiptReqA = { packetId: packetIdA };
    const receiptHeadersA = sign('getWatchdogPullReceipt', 'POST', JSON.stringify(receiptReqA), now, 'nonce_rcpt_a');
    const receiptMockA = mockReqRes('POST', receiptHeadersA, receiptReqA);
    await (getWatchdogPullReceipt as any)(receiptMockA.req, receiptMockA.res);

    expect(receiptMockA.getResponse().status).toBe(200);
    expect(receiptMockA.getResponse().body).toMatchObject({
      ok: true,
      found: true,
      status: 'processed',
      canonicalProcessingComplete: true,
      wellName: 'Kahuna 5',
      wellStatus: {
        levelInches: 80.4,
      },
      outgoingExists: true,
    });

    // -------------------------------------------------------------------------
    // EVENT B: 5:48 PM — Kahuna 5 — 6.7 / 6.0 — 140 BBL
    // -------------------------------------------------------------------------
    const packetIdB = '20260912_174800_Kahuna5_aef41b';
    const payloadB = {
      packetId: packetIdB,
      wellName,
      top: 6.7,
      bottom: 6.0,
      explicitBbl: 140,
      dateTimeUTC: '2026-09-12T22:48:00.000Z',
    };

    const headersB = sign('ingestWatchdogPull', 'POST', JSON.stringify(payloadB), now, 'nonce_evt_b');
    const mockB = mockReqRes('POST', headersB, payloadB);
    await (ingestWatchdogPull as any)(mockB.req, mockB.res);

    expect(mockB.getResponse().status).toBe(200);
    expect(mockB.getResponse().body.status).toBe('queued');

    const snapB = await db.ref(`packets/incoming/${packetIdB}`).once('value');
    await processIncomingPull.run(snapB as any, {
      params: { packetId: packetIdB },
      eventId: 'test-' + packetIdB,
    });

    // Verify Event B processed state
    const processedB = (await db.ref(`packets/processed/${packetIdB}`).once('value')).val();
    expect(processedB.canonicalProcessingComplete).toBe(true);
    expect(processedB.tankAfterInches).toBe(72); // 6.0 ft preserved!

    const statusB = (await db.ref(`wells/${wellName}/status`).once('value')).val();
    expect(statusB.current.levelInches).toBe(72);
    expect(statusB.current.level).toBe("6'0\"");
    expect(statusB.lastPull.packetId).toBe(packetIdB);

    // Duplicate submission with new nonce returns already_processed
    const dupHeaders = sign('ingestWatchdogPull', 'POST', JSON.stringify(payloadB), now, 'nonce_evt_b_dup');
    const dupMock = mockReqRes('POST', dupHeaders, payloadB);
    await (ingestWatchdogPull as any)(dupMock.req, dupMock.res);
    expect(dupMock.getResponse().status).toBe(200);
    expect(dupMock.getResponse().body).toEqual({
      ok: true,
      packetId: packetIdB,
      duplicate: true,
      status: 'already_processed',
      submitted: false,
    });

    // Conflict test: same packet ID with different payload -> 409
    const conflictPayload = { ...payloadB, explicitBbl: 200 };
    const conflictHeaders = sign('ingestWatchdogPull', 'POST', JSON.stringify(conflictPayload), now, 'nonce_evt_b_conflict');
    const conflictMock = mockReqRes('POST', conflictHeaders, conflictPayload);
    await (ingestWatchdogPull as any)(conflictMock.req, conflictMock.res);
    expect(conflictMock.getResponse().status).toBe(409);
    expect(conflictMock.getResponse().body.error).toBe('packet_payload_conflict');

    // Verify Commercial and JSA Isolation
    const fs = admin.firestore();
    for (const coll of ['tickets', 'invoices', 'payroll', 'billing', 'billing_invoices', 'dispatches', 'jsa_day_status']) {
      const snap = await fs.collection(coll).get();
      expect(snap.size).toBe(0);
    }
  });
});
