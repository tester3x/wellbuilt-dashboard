import {
  decideWbmPullTransaction,
  evaluateWbmPull,
  wbmIncomingPath,
  wbmPullStorageKey,
} from '../wbmPullAuthorize';

const wellConfig = {
  'Gabriel 1': { route: 'Gabriels', companyId: 'liquid-gold' },
  'Watford 1': { route: 'Watford', companyId: 'liquid-gold' },
  'Other Co 1': { route: 'Gabriels', companyId: 'other-co' },
};

const PID = '20260820_124211_Gabriel1_frr2t3';

const pull = {
  requestType: 'pull',
  wellName: 'Gabriel 1',
  dateTimeUTC: '2026-08-21T12:00:00.000Z',
  tankLevelFeet: 8,
  bblsTaken: 140,
  packetId: PID,
  idempotencyKey: PID,
};

describe('evaluateWbmPull', () => {
  it('accepts an in-scope canonical pull and projects allowlisted fields only', () => {
    const r = evaluateWbmPull({
      packet: { ...pull, isAdmin: true, extra: 'nope' },
      companyId: 'liquid-gold',
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      wellConfig,
    });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe('unexpected_field');
    const ok = evaluateWbmPull({
      packet: pull,
      companyId: 'liquid-gold',
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      wellConfig,
    });
    expect(ok).toMatchObject({ ok: true, wellName: 'Gabriel 1' });
    if (ok.ok) {
      expect(ok.payload).not.toHaveProperty('isAdmin');
      expect(ok.payload.packetId).toBe(PID);
      expect(ok.payload.idempotencyKey).toBe(PID);
      expect(ok.idempotencyKey).toBe(PID);
      expect(ok.payloadDigest).toHaveLength(64);
      expect(ok.payload).not.toHaveProperty('assignedRoutes');
    }
  });

  it('requires packetId present, equal to idempotencyKey, mint-shaped, and Firebase-key safe', () => {
    const base = {
      companyId: 'liquid-gold',
      assignedRoutes: ['Gabriels'] as string[],
      assignedWells: [] as string[],
      wellConfig,
    };
    expect(evaluateWbmPull({ packet: { ...pull, packetId: undefined }, ...base }))
      .toEqual({ ok: false, reason: 'missing_packetId' });
    expect(evaluateWbmPull({ packet: { ...pull, idempotencyKey: undefined }, ...base }))
      .toEqual({ ok: false, reason: 'missing_idempotency_key' });
    expect(evaluateWbmPull({ packet: { ...pull, idempotencyKey: 'other-id-xxxxxx' }, ...base }))
      .toEqual({ ok: false, reason: 'packet_id_mismatch' });
    expect(evaluateWbmPull({
      packet: { ...pull, packetId: 'abc.12345_not_a_mint', idempotencyKey: 'abc.12345_not_a_mint' },
      ...base,
    })).toEqual({ ok: false, reason: 'invalid_packetId' });
    expect(evaluateWbmPull({
      packet: {
        ...pull,
        packetId: '20260820_124211_Gabriel1/frr2t3',
        idempotencyKey: '20260820_124211_Gabriel1/frr2t3',
      },
      ...base,
    })).toEqual({ ok: false, reason: 'invalid_packetId' });
    expect(evaluateWbmPull({
      packet: { ...pull, packetId: '20260820_124211_Watford1_frr2t3', idempotencyKey: '20260820_124211_Watford1_frr2t3' },
      ...base,
    })).toEqual({ ok: false, reason: 'invalid_packetId' });
  });

  it('rejects out-of-scope wells', () => {
    expect(evaluateWbmPull({
      packet: pull,
      companyId: 'liquid-gold',
      assignedRoutes: ['Watford'],
      assignedWells: [],
      wellConfig,
    })).toEqual({ ok: false, reason: 'well_out_of_scope' });
  });

  it('rejects another company\'s wells', () => {
    const otherPid = '20260820_124211_OtherCo1_frr2t3';
    expect(evaluateWbmPull({
      packet: { ...pull, wellName: 'Other Co 1', packetId: otherPid, idempotencyKey: otherPid },
      companyId: 'liquid-gold',
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      wellConfig,
    })).toEqual({ ok: false, reason: 'cross_company_well' });
  });

  it('rejects nested objects and invalid levels', () => {
    expect(evaluateWbmPull({
      packet: { ...pull, wellDown: { nested: true } },
      companyId: 'liquid-gold',
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      wellConfig,
    }).ok).toBe(false);
    expect(evaluateWbmPull({
      packet: { ...pull, tankLevelFeet: -1 },
      companyId: 'liquid-gold',
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      wellConfig,
    })).toEqual({ ok: false, reason: 'invalid_tankLevelFeet' });
    expect(evaluateWbmPull({
      packet: { ...pull, requestType: 'edit' },
      companyId: 'liquid-gold',
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      wellConfig,
    })).toEqual({ ok: false, reason: 'unsupported_request_type' });
  });
});

describe('canonical storage key and transaction', () => {
  const d1 = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
  const d2 = '99ff4b35-51ab-4d45-8d54-18b3b8515c9b';
  const digest = 'abc';

  it('storage key is the exact minted packetId, never a wbm_ hash', () => {
    expect(wbmPullStorageKey(PID)).toBe(PID);
    expect(wbmPullStorageKey(PID)).not.toMatch(/^wbm_/);
    expect(wbmIncomingPath(PID)).toBe(`packets/incoming/${PID}`);
  });

  it('does not sanitize a dotted id into a different key', () => {
    const dotted = '20260820_124211_Gabriel.1_frr2t3';
    expect(wbmPullStorageKey(dotted)).toBe(dotted);
  });

  it('same payload is duplicate; different payload conflicts; other driver rejected', () => {
    expect(decideWbmPullTransaction({ existing: null, driverId: d1, payloadDigest: digest }))
      .toEqual({ action: 'write' });
    expect(decideWbmPullTransaction({
      existing: { driverId: d1, payloadDigest: digest },
      driverId: d1,
      payloadDigest: digest,
    })).toEqual({ action: 'duplicate' });
    expect(decideWbmPullTransaction({
      existing: { driverId: d1, payloadDigest: digest },
      driverId: d1,
      payloadDigest: 'other',
    })).toEqual({ action: 'abort', reason: 'idempotency_payload_conflict' });
    expect(decideWbmPullTransaction({
      existing: { driverId: d1, payloadDigest: digest },
      driverId: d2,
      payloadDigest: digest,
    })).toEqual({ action: 'abort', reason: 'idempotency_cross_driver' });
  });
});

// Phase-1 regression freeze (2026-08-29): stable client-visible refusal
// reasons for the ingest gate, and the no-physical-plausibility contract.
// Three production HTTP 400s on 2026-08-28 left no server trace; these pins
// guarantee every governed refusal has a stable reason a client can parse.
describe('ingest refusal reasons — Phase-1 freeze', () => {
  const scope = { companyId: 'liquid-gold', assignedRoutes: ['Gabriels'], assignedWells: [], wellConfig };
  const PID2 = '20260828_090803_Gabriel1_3k806o';
  const base = {
    requestType: 'pull', wellName: 'Gabriel 1', dateTimeUTC: '2026-08-28T14:07:57.497Z',
    tankLevelFeet: 14, bblsTaken: 140, packetId: PID2, idempotencyKey: PID2,
  };

  it('unsupported request type → stable reason', () => {
    expect(evaluateWbmPull({ ...scope, packet: { ...base, requestType: 'edit' } }))
      .toEqual({ ok: false, reason: 'unsupported_request_type' });
  });

  it('oversized packet → stable reason (before any field inspection)', () => {
    expect(evaluateWbmPull({ ...scope, packet: { ...base, blob: 'x'.repeat(200_001) } }))
      .toEqual({ ok: false, reason: 'packet_too_large' });
  });

  it('malformed packet → stable reason', () => {
    expect(evaluateWbmPull({ ...scope, packet: null })).toEqual({ ok: false, reason: 'packet_required' });
    expect(evaluateWbmPull({ ...scope, packet: { ...base, dateTimeUTC: 'not-a-time' } }))
      .toMatchObject({ ok: false, reason: 'invalid_dateTimeUTC' });
  });

  it('out-of-scope well → stable reason (authorization, not silence)', () => {
    const wid = '20260828_090803_Watford1_3k806o';
    expect(evaluateWbmPull({
      ...scope,
      packet: { ...base, wellName: 'Watford 1', packetId: wid, idempotencyKey: wid },
    })).toMatchObject({ ok: false, reason: 'well_out_of_scope' });
  });

  it('unusual field readings are ACCEPTED for review, never physically rejected', () => {
    // Big-but-bounded gauge and pull values pass the gate; review tags are a
    // downstream concern, not an ingest rejection.
    const r = evaluateWbmPull({ ...scope, packet: { ...base, tankLevelFeet: 39.9, bblsTaken: 19999 } });
    expect(r).toMatchObject({ ok: true });
    const zero = evaluateWbmPull({ ...scope, packet: { ...base, bblsTaken: 0 } });
    expect(zero).toMatchObject({ ok: true }); // 0-BBL well-down gauge (Gabriel 5 shape)
  });
});
