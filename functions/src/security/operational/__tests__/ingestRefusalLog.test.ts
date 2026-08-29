// Phase-4: structured ingest-refusal observability — reason codes reach the
// log with identity metadata only; payloads and secrets can never pass.
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildIngestRefusalEntry,
  logIngestRefusal,
  safePayloadDigest,
  sanitizeClientMeta,
} from '../ingestRefusalLog';

const NOW = Date.parse('2026-08-28T09:48:12.174Z'); // the first unexplained 400

describe('buildIngestRefusalEntry — allowlist + redaction', () => {
  test('carries exactly the safe identity fields', () => {
    const e = buildIngestRefusalEntry({
      endpoint: 'ingestWbmPull',
      reason: 'well_out_of_scope',
      uid: 'driver_2cad521c',
      driverId: '2cad521c-13ac',
      companyId: 'liquid-gold',
      wellName: 'Gabriel 5',
      operationType: 'pull',
      packetId: '20260828_044800_Gabriel5_ab12cd',
      payloadDigest: 'f'.repeat(64),
      clientMeta: { appVersion: '2.1.0', versionCode: '25', platform: 'android' },
      nowMs: NOW,
    });
    expect(e).toEqual({
      event: 'ingest_refusal',
      endpoint: 'ingestWbmPull',
      reason: 'well_out_of_scope',
      uid: 'driver_2cad521c',
      driverId: '2cad521c-13ac',
      companyId: 'liquid-gold',
      wellName: 'Gabriel 5',
      operationType: 'pull',
      packetId: '20260828_044800_Gabriel5_ab12cd',
      payloadDigest: 'f'.repeat(64),
      clientMeta: { appVersion: '2.1.0', versionCode: '25', platform: 'android' },
      serverTs: '2026-08-28T09:48:12.174Z',
    });
  });

  test('missing/oversized/sensitive-looking values become null — never truncated leaks', () => {
    const e = buildIngestRefusalEntry({
      endpoint: 'ingestWbmPull',
      reason: 'invalid_packetId',
      uid: 'authorization: Bearer abc',      // sensitive-looking → dropped
      wellName: 'x'.repeat(300),             // over bound → dropped
      operationType: 'my-passcode-1234',     // sensitive-looking → dropped
      nowMs: NOW,
    });
    expect(e.uid).toBeNull();
    expect(e.wellName).toBeNull();
    expect(e.operationType).toBeNull();
    expect(e.driverId).toBeNull();
    expect(e.payloadDigest).toBeNull();
  });

  test('the serialized entry cannot contain packet material — digest only', () => {
    const secretPacket = { wellName: 'Gabriel 5', bblsTaken: 140, passcode: 'SECRET-9999', authToken: 'tok_abc' };
    const entry = logIngestRefusal({
      endpoint: 'ingestWbmPull',
      reason: 'unsupported_request_type',
      payloadDigest: safePayloadDigest(secretPacket),
      nowMs: NOW,
    });
    const flat = JSON.stringify(entry);
    expect(flat).not.toContain('SECRET-9999');
    expect(flat).not.toContain('tok_abc');
    expect(flat).not.toContain('140');
    expect(entry.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sanitizeClientMeta — bounded allowlist', () => {
  test('accepts only the four bounded string fields', () => {
    expect(sanitizeClientMeta({
      appVersion: '2.1.0', versionCode: '25', channel: 'preview', platform: 'android',
      installationId: 'imei-123', token: 'x', extra: { a: 1 },
    })).toEqual({ appVersion: '2.1.0', versionCode: '25', channel: 'preview', platform: 'android' });
    expect(sanitizeClientMeta({ appVersion: 'x'.repeat(65) })).toBeNull();
    expect(sanitizeClientMeta('2.1.0')).toBeNull();
    expect(sanitizeClientMeta(null)).toBeNull();
  });
});

describe('safePayloadDigest', () => {
  test('deterministic for identical payloads, distinct for different payloads', () => {
    const a1 = safePayloadDigest({ x: 1 });
    const a2 = safePayloadDigest({ x: 1 });
    const b = safePayloadDigest({ x: 2 });
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(safePayloadDigest(undefined)).toBeNull();
  });
});

describe('ingestWbmPull wiring (source)', () => {
  const src = readFileSync(join(__dirname, '../ingestWbmPull.ts'), 'utf8');

  test('every governed HttpsError refusal is logged with the redacted builder', () => {
    expect(src).toContain('logIngestRefusal({');
    expect(src).toContain("endpoint: 'ingestWbmPull'");
    expect(src).toContain('payloadDigest: safePayloadDigest(data.packet)');
    expect(src).toContain('clientMeta: sanitizeClientMeta(data.clientMeta)');
    // The catch rethrows — clients still receive the stable reason code.
    expect(src).toMatch(/throw err;/);
  });

  test('the raw packet body is never logged directly', () => {
    expect(src).not.toMatch(/console\.(log|warn|error)\([^)]*data\.packet/);
    expect(src).not.toMatch(/JSON\.stringify\(data\.packet\)/); // digesting happens inside the helper
  });
});
