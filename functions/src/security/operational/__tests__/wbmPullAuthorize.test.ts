import { evaluateWbmPull, wbmPullIdempotencyKey } from '../wbmPullAuthorize';

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
  it('accepts an in-scope canonical pull', () => {
    expect(evaluateWbmPull({
      packet: pull,
      companyId: 'liquid-gold',
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      wellConfig,
    })).toMatchObject({ ok: true, wellName: 'Gabriel 1' });
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

  it('rejects edit/history packets', () => {
    expect(evaluateWbmPull({
      packet: { ...pull, requestType: 'edit' },
      companyId: 'liquid-gold',
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      wellConfig,
    })).toEqual({ ok: false, reason: 'unsupported_request_type' });
  });
});

describe('idempotency is driver-scoped', () => {
  it('same client key under two drivers does not collide', () => {
    const a = wbmPullIdempotencyKey('2cad521c-13ac-4b6c-b1ab-07843c6bf06f', 'abc12345pull');
    const b = wbmPullIdempotencyKey('99ff4b35-51ab-4d45-8d54-18b3b8515c9b', 'abc12345pull');
    expect(a).not.toEqual(b);
    expect(a).toContain('2cad521c-13a');
    expect(a).toEqual(wbmPullIdempotencyKey('2cad521c-13ac-4b6c-b1ab-07843c6bf06f', 'abc12345pull'));
  });
});
