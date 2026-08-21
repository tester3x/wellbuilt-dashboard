import {
  decideWbmPullTransaction,
  evaluateWbmPull,
  wbmPullStorageKey,
} from '../wbmPullAuthorize';

const wellConfig = {
  'Gabriel 1': { route: 'Gabriels', companyId: 'liquid-gold' },
  'Watford 1': { route: 'Watford', companyId: 'liquid-gold' },
  'Other Co 1': { route: 'Gabriels', companyId: 'other-co' },
};

const pull = {
  requestType: 'pull',
  wellName: 'Gabriel 1',
  dateTimeUTC: '2026-08-21T12:00:00.000Z',
  tankLevelFeet: 8,
  bblsTaken: 140,
  idempotencyKey: 'abc12345pull',
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
      expect(ok.payloadDigest).toHaveLength(64);
    }
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
    expect(evaluateWbmPull({
      packet: { ...pull, wellName: 'Other Co 1' },
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

describe('idempotency key and transaction', () => {
  const d1 = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
  const d2 = '2cad521c-13ad-4b6c-b1ab-07843c6bf06f';
  const digest = 'abc';

  it('two driverIds sharing the first 12 characters get different keys', () => {
    expect(d1.slice(0, 12)).toBe(d2.slice(0, 12));
    expect(wbmPullStorageKey(d1, 'abc12345pull')).not.toEqual(wbmPullStorageKey(d2, 'abc12345pull'));
  });

  it('sanitized-equivalent client keys still hash differently', () => {
    const a = wbmPullStorageKey(d1, 'abc.12345pull');
    const b = wbmPullStorageKey(d1, 'abc_12345pull');
    expect(a).not.toEqual(b);
  });

  it('long keys are bounded by the digest', () => {
    const long = 'k'.repeat(500);
    const key = wbmPullStorageKey(d1, long);
    expect(key.length).toBeLessThan(200);
    expect(key.startsWith(`wbm_${d1}_`)).toBe(true);
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

  it('concurrent same-payload decision is duplicate for the second observer', () => {
    const first = decideWbmPullTransaction({ existing: null, driverId: d1, payloadDigest: digest });
    const afterWrite = { driverId: d1, payloadDigest: digest };
    const second = decideWbmPullTransaction({ existing: afterWrite, driverId: d1, payloadDigest: digest });
    expect(first).toEqual({ action: 'write' });
    expect(second).toEqual({ action: 'duplicate' });
  });
});
