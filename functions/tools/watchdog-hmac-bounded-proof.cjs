#!/usr/bin/env node
/**
 * Bounded HMAC + canonical proof. Always exits.
 * Does NOT use quarantined 4:57 / 5:48 packet ids.
 * Transport: emulator only. Zero production writes.
 */
'use strict';

const HARD_EXIT_MS = 45000;
const PROCESSOR_MS = 12000;
const projectId = 'demo-watchdog-canonical';

function die(code, msg, extra) {
  const row = { ok: code === 0, blockingOperation: extra && extra.blockingOperation || null, message: msg, extra: extra || null };
  try { console.log(JSON.stringify(row, null, 2)); } catch (_) { console.log(msg); }
  process.exit(code);
}

const hardTimer = setTimeout(() => {
  die(3, 'hard_timeout_45000ms', { blockingOperation: 'watchdog-hmac-bounded-proof wall clock' });
}, HARD_EXIT_MS);
hardTimer.unref?.();

if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
  die(2, 'emulator_required', { blockingOperation: 'FIREBASE_DATABASE_EMULATOR_HOST missing' });
}

process.env.GCLOUD_PROJECT = projectId;
process.env.FUNCTIONS_EMULATOR = 'true';
process.env.NODE_ENV = 'test';
if (!process.env.FIREBASE_CONFIG) {
  process.env.FIREBASE_CONFIG = JSON.stringify({
    projectId,
    databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`,
  });
}

function withTimeout(promise, ms, name) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error('timeout:' + name + ':' + ms + 'ms')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

(async () => {
  const crypto = require('crypto');
  const admin = require('firebase-admin');
  const {
    ingestWatchdogPull,
    getWatchdogPullReceipt,
  } = require('../lib/security/watchdogHmacEndpoints');
  const { processIncomingPull } = require('../lib/index');
  const { computeBodySha256, buildStringToSign, evaluateWatchdogReceipt } = require('../lib/security/operational/watchdogHmac');
  const { projectWellStatus } = require('../lib/security/dashboardCatalogProjection');

  const secret = 'demo-watchdog-hmac-secret-key-32chars!';
  const wellName = 'Kahuna 5';
  // Fresh synthetic ids — not the quarantined 4:57 / 5:48 packets.
  const packetA = '20260914_060100_Kahuna5_c0ffee';
  const packetB = '20260914_061500_Kahuna5_d11ecd';

  function sign(endpointName, method, rawBody, timestamp, nonce) {
    const bodySha = computeBodySha256(rawBody);
    const stringToSign = buildStringToSign({ endpointName, method, timestamp, nonce, bodySha256: bodySha });
    const signature = crypto.createHmac('sha256', secret).update(stringToSign).digest('hex');
    return {
      'x-watchdog-key-id': 'v1',
      'x-watchdog-timestamp': String(timestamp),
      'x-watchdog-nonce': nonce,
      'x-watchdog-signature': signature,
      'content-type': 'application/json',
    };
  }

  function mock(method, headers, body) {
    const { EventEmitter } = require('events');
    const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
    const req = { method, headers, body, rawBody, query: {} };
    const res = new EventEmitter();
    res.statusCode = 200;
    res.body = null;
    res.headers = {};
    res.status = function status(code) { this.statusCode = code; return this; };
    res.json = function json(data) { this.body = data; this.emit('finish'); return this; };
    res.send = function send(data) { this.body = data; this.emit('finish'); return this; };
    res.setHeader = function setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; };
    res.getHeader = function getHeader(k) { return this.headers[String(k).toLowerCase()]; };
    return { req, res, get: () => ({ status: res.statusCode, body: res.body }) };
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      projectId,
      databaseURL: `https://${projectId}-default-rtdb.firebaseio.com`,
    });
  }
  const db = admin.database();
  await withTimeout(db.ref('well_config/Kahuna 5').set({
    wellName,
    companyId: 'liquid-gold',
    route: 'Kahuna 381',
    tanks: 10,
    bottomLevel: 3,
    pullBbls: 140,
    tankHeight: 20,
    bblPerFoot: 20,
  }), 5000, 'seed_well_config');
  await withTimeout(db.ref('integration_ledgers/watchdog').remove(), 5000, 'clear_ledger');
  await withTimeout(db.ref('packets').remove(), 5000, 'clear_packets');
  await withTimeout(db.ref('wells/Kahuna 5/status').remove(), 5000, 'clear_status');

  const now = Date.now();
  const payloadA = {
    packetId: packetA,
    wellName,
    top: 8.1,
    bottom: 7.2,
    explicitBbl: 150,
    dateTimeUTC: '2026-09-14T06:01:00.000Z',
  };
  const rawA = JSON.stringify(payloadA);
  const headersA = sign('ingestWatchdogPull', 'POST', rawA, now, 'nonce_fresh_a_001');
  const mockA = mock('POST', headersA, payloadA);
  await withTimeout(ingestWatchdogPull(mockA.req, mockA.res), 8000, 'ingestWatchdogPull_A');
  if (mockA.get().status !== 200 || mockA.get().body.submitted !== true) {
    die(4, 'valid_signed_request_failed', { blockingOperation: 'ingestWatchdogPull_A', response: mockA.get() });
  }

  const replay = mock('POST', headersA, payloadA);
  await withTimeout(ingestWatchdogPull(replay.req, replay.res), 8000, 'ingestWatchdogPull_replay');
  if (replay.get().status !== 401 || replay.get().body.error !== 'replay_detected') {
    die(5, 'nonce_replay_not_rejected', { blockingOperation: 'ingestWatchdogPull_replay', response: replay.get() });
  }

  async function runProcessor(packetId) {
    const snap = await db.ref(`packets/incoming/${packetId}`).once('value');
    if (!snap.exists()) {
      throw new Error('incoming_missing:' + packetId);
    }
    await withTimeout(
      processIncomingPull.run(snap, { params: { packetId }, eventId: 'bounded-' + packetId }),
      PROCESSOR_MS,
      'processIncomingPull.run:' + packetId,
    );
  }

  try {
    await runProcessor(packetA);
  } catch (err) {
    die(6, String(err && err.message || err), { blockingOperation: 'processIncomingPull.run:' + packetA });
  }

  const rcptA = await receipt(packetA, 'nonce_fresh_rcpt_a');
  if (rcptA.status !== 200 || rcptA.body.ok !== true || rcptA.body.canonicalCurrentLevelUpdated !== true) {
    die(9, 'receipt_a_incomplete', { blockingOperation: 'getWatchdogPullReceipt_A', response: rcptA });
  }
  if (rcptA.body.adminGetWellPool.lastPullPacketId !== packetA) {
    die(9, 'receipt_a_pool_not_event_a', { blockingOperation: 'adminGetWellPool lastPullPacketId A', response: rcptA });
  }

  const payloadB = {
    packetId: packetB,
    wellName,
    top: 7.2,
    bottom: 6.4,
    explicitBbl: 140,
    dateTimeUTC: '2026-09-14T06:15:00.000Z',
  };
  const rawB = JSON.stringify(payloadB);
  const headersB = sign('ingestWatchdogPull', 'POST', rawB, now, 'nonce_fresh_b_001');
  const mockB = mock('POST', headersB, payloadB);
  await withTimeout(ingestWatchdogPull(mockB.req, mockB.res), 8000, 'ingestWatchdogPull_B');
  if (mockB.get().status !== 200 || mockB.get().body.submitted !== true) {
    die(7, 'event_b_ingest_failed', { blockingOperation: 'ingestWatchdogPull_B', response: mockB.get() });
  }
  try {
    await runProcessor(packetB);
  } catch (err) {
    die(8, String(err && err.message || err), { blockingOperation: 'processIncomingPull.run:' + packetB });
  }

  async function receipt(packetId, nonce) {
    const body = { packetId };
    const headers = sign('getWatchdogPullReceipt', 'POST', JSON.stringify(body), now, nonce);
    const m = mock('POST', headers, body);
    await withTimeout(getWatchdogPullReceipt(m.req, m.res), 8000, 'getWatchdogPullReceipt:' + packetId);
    return m.get();
  }
  const rcptB = await receipt(packetB, 'nonce_fresh_rcpt_b');
  const rcptAAfterB = await receipt(packetA, 'nonce_fresh_rcpt_a_after_b');
  if (rcptAAfterB.body.ok === true && rcptAAfterB.body.canonicalCurrentLevelUpdated === true) {
    die(9, 'event_a_still_current_after_b', { blockingOperation: 'getWatchdogPullReceipt_A_after_B', response: rcptAAfterB });
  }
  if (rcptB.status !== 200 || rcptB.body.ok !== true || rcptB.body.canonicalCurrentLevelUpdated !== true) {
    die(10, 'receipt_b_incomplete', { blockingOperation: 'getWatchdogPullReceipt_B', response: rcptB });
  }
  if (rcptB.body.adminGetWellPool.lastPullPacketId !== packetB) {
    die(10, 'receipt_b_pool_not_event_b', { blockingOperation: 'adminGetWellPool lastPullPacketId', response: rcptB });
  }

  const outgoingTree = (await db.ref('packets/outgoing').once('value')).val() || {};
  const pool = projectWellStatus(outgoingTree);
  if (!pool['Kahuna 5'] || pool['Kahuna 5'].lastPullDateTimeUTC !== payloadB.dateTimeUTC) {
    die(13, 'adminGetWellPool_projection_not_event_b', { blockingOperation: 'projectWellStatus', pool: pool['Kahuna 5'] || null });
  }

  const delayed = {
    packetId: '20260914_054000_Kahuna5_aa0001',
    wellName,
    top: 9.0,
    bottom: 8.0,
    explicitBbl: 165,
    dateTimeUTC: '2026-09-14T05:40:00.000Z',
  };
  const delayedHeaders = sign('ingestWatchdogPull', 'POST', JSON.stringify(delayed), now, 'nonce_fresh_delayed');
  const delayedMock = mock('POST', delayedHeaders, delayed);
  await withTimeout(ingestWatchdogPull(delayedMock.req, delayedMock.res), 8000, 'ingestWatchdogPull_delayed');
  try {
    await runProcessor(delayed.packetId);
  } catch (err) {
    // Timeout/quarantine is acceptable; overwrite is not.
    if (String(err && err.message || err).startsWith('timeout:')) {
      die(14, String(err.message), { blockingOperation: 'processIncomingPull.run:' + delayed.packetId });
    }
  }
  const poolAfterDelay = projectWellStatus((await db.ref('packets/outgoing').once('value')).val() || {});
  if (poolAfterDelay['Kahuna 5'] && poolAfterDelay['Kahuna 5'].lastPullDateTimeUTC !== payloadB.dateTimeUTC) {
    die(15, 'delayed_older_overwrote_current_level', {
      blockingOperation: 'packets/outgoing currentLevel',
      after: poolAfterDelay['Kahuna 5'],
    });
  }
  const rcptB2 = await receipt(packetB, 'nonce_fresh_rcpt_b2');
  if (rcptB2.body.ok !== true || rcptB2.body.adminGetWellPool.lastPullPacketId !== packetB) {
    die(16, 'event_b_receipt_lost_after_delayed', { blockingOperation: 'getWatchdogPullReceipt_B_after_delayed', response: rcptB2 });
  }

  const dupHeaders = sign('ingestWatchdogPull', 'POST', JSON.stringify(payloadB), now, 'nonce_fresh_b_dup');
  const dupMock = mock('POST', dupHeaders, payloadB);
  await withTimeout(ingestWatchdogPull(dupMock.req, dupMock.res), 8000, 'ingestWatchdogPull_B_dup');
  if (dupMock.get().status !== 200 || dupMock.get().body.duplicate !== true) {
    die(17, 'duplicate_not_idempotent', { blockingOperation: 'ingestWatchdogPull_B_dup', response: dupMock.get() });
  }

  const processedA = (await db.ref(`packets/processed/${packetA}`).once('value')).val() || {};
  const processedB = (await db.ref(`packets/processed/${packetB}`).once('value')).val() || {};
  if (Math.abs((processedA.tankAfterInches || 0) - 7.2 * 12) > 0.05) {
    die(11, 'event_a_bottom_not_authoritative', { blockingOperation: 'processIncomingPull tankAfterInches A', tankAfterInches: processedA.tankAfterInches });
  }
  if (Math.abs((processedB.tankAfterInches || 0) - 6.4 * 12) > 0.05) {
    die(12, 'event_b_bottom_not_authoritative', { blockingOperation: 'processIncomingPull tankAfterInches B', tankAfterInches: processedB.tankAfterInches });
  }

  try { db.goOffline(); } catch (_) {}
  await Promise.all(admin.apps.map((app) => app && app.delete()));
  clearTimeout(hardTimer);
  die(0, 'bounded_proof_passed', {
    blockingOperation: null,
    packets: [packetA, packetB],
    receipts: { A: rcptA.body.status, B: rcptB.body.status },
    canonicalProcessingComplete: { A: true, B: true },
    quarantinedPacketsUnused: true,
    productionWrites: 0,
  });
})().catch((err) => {
  die(1, String(err && err.message || err), { blockingOperation: 'unhandled', stack: String(err && err.stack || '').slice(0, 400) });
});
