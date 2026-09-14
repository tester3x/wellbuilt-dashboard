import * as crypto from 'crypto';
import {
  verifyHmacHeaders,
  buildStringToSign,
  validateObservationPayload,
  computeBodySha256,
  evaluateWatchdogReceipt,
  resolveWatchdogWellIdentity,
  WATCHDOG_PRINCIPAL_ID,
  WATCHDOG_COMPANY_ID,
} from '../watchdogHmac';
import { projectWellStatus } from '../../dashboardCatalogProjection';

describe('Watchdog HMAC Verification & Validation Unit Tests', () => {
  const secret = 'demo-watchdog-hmac-secret-key-32chars!';
  const endpointName = 'ingestWatchdogPull';
  const method = 'POST';

  function signRequest(rawBody: string, timestamp: number, nonce: string, keyId = 'v1') {
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
    };
  }

  test('valid HMAC signature passes verification', () => {
    const now = 1726180000000;
    const body = JSON.stringify({ hello: 'world' });
    const headers = signRequest(body, now, 'nonce-test-123456');

    const result = verifyHmacHeaders({
      endpointName,
      method,
      headers,
      rawBody: body,
      nowMs: now,
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe(200);
    expect(result.principalId).toBe(WATCHDOG_PRINCIPAL_ID);
  });

  test('missing header fails with 401', () => {
    const now = 1726180000000;
    const body = JSON.stringify({ hello: 'world' });
    const headers = signRequest(body, now, 'nonce-test-123456');
    delete (headers as any)['x-watchdog-signature'];

    const result = verifyHmacHeaders({
      endpointName,
      method,
      headers,
      rawBody: body,
      nowMs: now,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(401);
    expect(result.error).toBe('missing_hmac_headers');
  });

  test('timestamp skew beyond 5 minutes fails with 401', () => {
    const now = 1726180000000;
    const pastTime = now - 350_000; // > 5 min
    const body = JSON.stringify({ hello: 'world' });
    const headers = signRequest(body, pastTime, 'nonce-test-123456');

    const result = verifyHmacHeaders({
      endpointName,
      method,
      headers,
      rawBody: body,
      nowMs: now,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(401);
    expect(result.error).toBe('timestamp_skew_exceeded');
  });

  test('tampered body fails signature check', () => {
    const now = 1726180000000;
    const body = JSON.stringify({ hello: 'world' });
    const headers = signRequest(body, now, 'nonce-test-123456');

    const result = verifyHmacHeaders({
      endpointName,
      method,
      headers,
      rawBody: JSON.stringify({ hello: 'tampered' }),
      nowMs: now,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(401);
    expect(result.error).toBe('signature_mismatch');
  });

  test('cross-endpoint signature reuse fails', () => {
    const now = 1726180000000;
    const body = JSON.stringify({ hello: 'world' });
    const headers = signRequest(body, now, 'nonce-test-123456');

    // Verify against a different endpoint
    const result = verifyHmacHeaders({
      endpointName: 'getWatchdogPullReceipt',
      method,
      headers,
      rawBody: body,
      nowMs: now,
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(401);
    expect(result.error).toBe('signature_mismatch');
  });

  test('payload validation strictly rejects client companyId', () => {
    const payload = {
      packetId: '20260912_165700_Kahuna5_1ab68c',
      wellName: 'Kahuna 5',
      top: 7.5,
      bottom: 6.7,
      explicitBbl: 150,
      dateTimeUTC: '2026-09-12T21:57:00.000Z',
      companyId: 'evil-tenant',
    };

    const res = validateObservationPayload(payload, Date.parse('2026-09-12T22:00:00.000Z'));
    expect(res.ok).toBe(false);
    expect((res as any).error).toBe('forbidden_field:companyId');
  });

  test('payload validation strictly rejects driver and commercial fields', () => {
    const forbiddenList = ['driverId', 'driverName', 'ticketNumber', 'invoiceDocId', 'dispatchId', 'wellDown'];
    for (const field of forbiddenList) {
      const payload = {
        packetId: '20260912_165700_Kahuna5_1ab68c',
        wellName: 'Kahuna 5',
        top: 7.5,
        bottom: 6.7,
        explicitBbl: 150,
        dateTimeUTC: '2026-09-12T21:57:00.000Z',
        [field]: 'any_val',
      };
      const res = validateObservationPayload(payload, Date.parse('2026-09-12T22:00:00.000Z'));
      expect(res.ok).toBe(false);
      expect((res as any).error).toBe(`forbidden_field:${field}`);
    }
  });

  test('valid payload parses correctly with semantic observation digest', () => {
    const payload = {
      packetId: '20260912_165700_Kahuna5_1ab68c',
      wellName: 'Kahuna 5',
      top: 7.5,
      bottom: 6.7,
      explicitBbl: 150,
      dateTimeUTC: '2026-09-12T21:57:00.000Z',
    };

    const res = validateObservationPayload(payload, Date.parse('2026-09-12T22:00:00.000Z'));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.wellName).toBe('Kahuna 5');
      expect(res.value.top).toBe(7.5);
      expect(res.value.bottom).toBe(6.7);
      expect(res.value.bbl).toBe(150);
      expect(typeof res.value.observationDigest).toBe('string');
      expect(res.value.observationDigest.length).toBe(64);
    }
  });
});

describe('Watchdog canonical Current Level / adminGetWellPool receipt gate', () => {
  const packetId = '20260914_180100_Kahuna5_c0ffee';
  const wellName = 'Kahuna 5';
  const dateTimeUTC = '2026-09-14T18:01:00.000Z';

  test('well/company resolve deterministically to Kahuna 5 / liquid-gold', () => {
    const id = resolveWatchdogWellIdentity({
      wellName,
      wellConfig: { wellName: 'Kahuna 5', companyId: 'liquid-gold', tanks: 10 },
    });
    expect(id.ok).toBe(true);
    if (id.ok) {
      expect(id.wellName).toBe('Kahuna 5');
      expect(id.wellKey).toBe('Kahuna5');
      expect(id.companyId).toBe(WATCHDOG_COMPANY_ID);
    }
  });

  test('rejects well_config bound to another company', () => {
    const id = resolveWatchdogWellIdentity({
      wellName,
      wellConfig: { wellName, companyId: 'other-co' },
    });
    expect(id.ok).toBe(false);
  });

  test('receipt fails until adminGetWellPool outgoing Current Level is this packet', () => {
    const processed = { canonicalProcessingComplete: true, dateTimeUTC, wellName };
    const fail = evaluateWatchdogReceipt({
      packetId,
      wellName,
      processed,
      poolProjection: { currentLevel: '7\'2"', lastPullDateTimeUTC: dateTimeUTC },
      outgoingPacketId: 'someone-else',
      wellConfig: { wellName, companyId: 'liquid-gold' },
    });
    expect(fail.ok).toBe(false);
    expect(fail.canonicalCurrentLevelUpdated).toBe(false);
    expect(fail.reason).toBe('adminGetWellPool_current_level_not_this_packet');
  });

  test('receipt succeeds only when outgoing Current Level + timestamp match this packet', () => {
    const processed = { canonicalProcessingComplete: true, dateTimeUTC, wellName, tankAfterInches: 86.4 };
    const ok = evaluateWatchdogReceipt({
      packetId,
      wellName,
      processed,
      wellStatus: { lastPull: { packetId, dateTimeUTC } },
      poolProjection: { currentLevel: '7\'2"', lastPullDateTimeUTC: dateTimeUTC, lastPullBottomLevel: '7\'2"' },
      outgoingPacketId: packetId,
      wellConfig: { wellName, companyId: 'liquid-gold' },
    });
    expect(ok.ok).toBe(true);
    expect(ok.canonicalCurrentLevelUpdated).toBe(true);
    expect(ok.companyId).toBe('liquid-gold');
    expect(ok.poolCurrentLevel).toBe('7\'2"');
    expect(ok.poolLastPullDateTimeUTC).toBe(dateTimeUTC);
  });

  test('duplicate processed row is idempotent: same outgoing still satisfies receipt', () => {
    const processed = { canonicalProcessingComplete: true, dateTimeUTC, wellName };
    const first = evaluateWatchdogReceipt({
      packetId,
      wellName,
      processed,
      poolProjection: { currentLevel: '7\'2"', lastPullDateTimeUTC: dateTimeUTC },
      outgoingPacketId: packetId,
      wellConfig: { wellName, companyId: 'liquid-gold' },
    });
    const replay = evaluateWatchdogReceipt({
      packetId,
      wellName,
      processed,
      poolProjection: { currentLevel: '7\'2"', lastPullDateTimeUTC: dateTimeUTC },
      outgoingPacketId: packetId,
      wellConfig: { wellName, companyId: 'liquid-gold' },
    });
    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    expect(replay.poolLastPullPacketId).toBe(first.poolLastPullPacketId);
  });

  test('delayed older outgoing cannot satisfy a newer packet receipt', () => {
    const newer = '20260914_181500_Kahuna5_d11ecd';
    const res = evaluateWatchdogReceipt({
      packetId: newer,
      wellName,
      processed: { canonicalProcessingComplete: true, dateTimeUTC: '2026-09-14T18:15:00.000Z', wellName },
      poolProjection: { currentLevel: '8\'0"', lastPullDateTimeUTC: '2026-09-14T17:40:00.000Z' },
      outgoingPacketId: '20260914_174000_Kahuna5_aa0001',
      wellConfig: { wellName, companyId: 'liquid-gold' },
    });
    expect(res.ok).toBe(false);
    expect(res.canonicalCurrentLevelUpdated).toBe(false);
  });

  test('adminGetWellPool projection keys Current Level by wellName from packets/outgoing', () => {
    const outgoing = {
      response_20260914_180100_Kahuna5: {
        wellName: 'Kahuna 5',
        currentLevel: '7\'2"',
        lastPullDateTimeUTC: dateTimeUTC,
        lastPullPacketId: packetId,
        timestampUTC: dateTimeUTC,
        companyId: 'liquid-gold',
      },
    };
    const pool = projectWellStatus(outgoing);
    expect(pool['Kahuna 5'].currentLevel).toBe('7\'2"');
    expect(pool['Kahuna 5'].lastPullDateTimeUTC).toBe(dateTimeUTC);
    expect(pool['Kahuna 5'].lastPullPacketId).toBeUndefined();
  });
});
