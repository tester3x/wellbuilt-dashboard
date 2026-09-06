import {
  decideWbtPullTransaction,
  evaluateWbtDriverPacket,
  wbtIncomingPath,
  wbtPullStorageKey,
  WBT_PULL_FIELD_ALLOWLIST,
} from '../wbtPacketAuthorize';
import { PULL_ALLOWLIST } from '../wbmPullAuthorize';

const PID = '20260906_120000_Gabriel1_abc123';
const COMPANY = 'liquid-gold';
const WELL_CONFIG = { 'Gabriel 1': { route: 'Gabriels', companyId: COMPANY, waterWeight: 8.34 } };

function basePacket(over: Record<string, unknown> = {}) {
  return {
    requestType: 'pull',
    wellName: 'Gabriel 1',
    dateTimeUTC: '2026-09-06T17:00:00.000Z',
    tankLevelFeet: 9.5,
    bblsTaken: 140,
    packetId: PID,
    idempotencyKey: PID,
    invoiceDocId: 'inv-1',
    dispatchId: 'disp-1',
    companyId: COMPANY,
    invoicingMode: 'hybrid',
    originAppContext: 'wbt',
    jobType: 'Production Water',
    wellConfigKey: 'Gabriel 1',
    wellId: '33-053-09031-00-00',
    ...over,
  };
}

describe('evaluateWbtDriverPacket', () => {
  it('keeps minted packetId as the storage key and preserves WB-T extras', () => {
    const decided = evaluateWbtDriverPacket({
      packet: basePacket(),
      companyId: COMPANY,
      wellConfig: WELL_CONFIG,
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.packetId).toBe(PID);
    expect(wbtPullStorageKey(decided.packetId)).toBe(PID);
    expect(wbtIncomingPath(decided.packetId)).toBe(`packets/incoming/${PID}`);
    expect(wbtIncomingPath(decided.packetId)).not.toContain('idem_');
    expect(decided.payload.invoiceDocId).toBe('inv-1');
    expect(decided.payload.dispatchId).toBe('disp-1');
    expect(decided.payload.originAppContext).toBe('wbt');
    expect(decided.payload.wellConfigKey).toBe('Gabriel 1');
    expect(decided.payload.wellId).toBe('33-053-09031-00-00');
    expect(decided.payload.jobType).toBe('Production Water');
  });

  it('rejects idem_ rewrite identities and packetId mismatches', () => {
    expect(evaluateWbtDriverPacket({
      packet: basePacket({ packetId: `idem_${PID}`, idempotencyKey: `idem_${PID}` }),
      companyId: COMPANY,
      wellConfig: WELL_CONFIG,
    }).ok).toBe(false);
    const mismatch = evaluateWbtDriverPacket({
      packet: basePacket({ idempotencyKey: 'other' }),
      companyId: COMPANY,
      wellConfig: WELL_CONFIG,
    });
    expect(mismatch).toEqual({ ok: false, reason: 'packet_id_mismatch' });
  });

  it('rejects unexpected fields and cross-company packets/wells', () => {
    expect(evaluateWbtDriverPacket({
      packet: basePacket({ isAdmin: true }),
      companyId: COMPANY,
      wellConfig: WELL_CONFIG,
    })).toEqual({ ok: false, reason: 'unexpected_field' });
    expect(evaluateWbtDriverPacket({
      packet: basePacket({ companyId: 'other-co' }),
      companyId: COMPANY,
      wellConfig: WELL_CONFIG,
    })).toEqual({ ok: false, reason: 'cross_company_packet' });
    expect(evaluateWbtDriverPacket({
      packet: basePacket(),
      companyId: COMPANY,
      wellConfig: { 'Gabriel 1': { companyId: 'other-co' } },
    })).toEqual({ ok: false, reason: 'cross_company_well' });
    expect(evaluateWbtDriverPacket({
      packet: basePacket(),
      companyId: COMPANY,
      wellConfig: {},
    })).toEqual({ ok: false, reason: 'well_not_found' });
  });

  it('does not use the WB-M pull allowlist (WB-T extras remain legal)', () => {
    for (const extra of ['invoiceDocId', 'dispatchId', 'originAppContext', 'wellConfigKey', 'wellId', 'jobType']) {
      expect(WBT_PULL_FIELD_ALLOWLIST).toContain(extra);
      expect((PULL_ALLOWLIST as readonly string[]).includes(extra)).toBe(false);
    }
  });

  it('duplicate digest is idempotent; different payload or driver aborts', () => {
    const decided = evaluateWbtDriverPacket({
      packet: basePacket(),
      companyId: COMPANY,
      wellConfig: WELL_CONFIG,
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decideWbtPullTransaction({
      existing: null,
      driverId: 'd1',
      payloadDigest: decided.payloadDigest,
    })).toEqual({ action: 'write' });
    expect(decideWbtPullTransaction({
      existing: { driverId: 'd1', payloadDigest: decided.payloadDigest },
      driverId: 'd1',
      payloadDigest: decided.payloadDigest,
    })).toEqual({ action: 'duplicate' });
    expect(decideWbtPullTransaction({
      existing: { driverId: 'd2', payloadDigest: decided.payloadDigest },
      driverId: 'd1',
      payloadDigest: decided.payloadDigest,
    })).toEqual({ action: 'abort', reason: 'idempotency_cross_driver' });
    expect(decideWbtPullTransaction({
      existing: { driverId: 'd1', payloadDigest: 'other' },
      driverId: 'd1',
      payloadDigest: decided.payloadDigest,
    })).toEqual({ action: 'abort', reason: 'idempotency_payload_conflict' });
  });
});
