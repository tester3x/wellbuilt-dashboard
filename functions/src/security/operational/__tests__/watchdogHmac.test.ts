import * as crypto from 'crypto';
import {
  verifyHmacHeaders,
  buildStringToSign,
  validateObservationPayload,
  computeBodySha256,
  WATCHDOG_PRINCIPAL_ID,
  WATCHDOG_COMPANY_ID,
} from '../watchdogHmac';

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
