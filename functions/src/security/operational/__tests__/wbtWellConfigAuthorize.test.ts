import { evaluateWbtWellLookup } from '../wbtWellConfigAuthorize';

const COMPANY = 'liquid-gold';
const WELLS = {
  'Gabriel 1': {
    companyId: COMPANY,
    ndicName: 'GABRIEL 1-36-25H',
    ndicApiNo: '33-053-09031-00-00',
    waterWeight: 8.34,
    h2sStatus: 'low',
    tanks: 2,
    numTanks: 2,
    pullBbls: 140,
    bblPerFoot: 40,
    allowedBottom: 3,
    bottomLevel: 3,
    route: 'Gabriels',
    avgFlowRate: '1.2 min/in',
    passcode: 'secret',
  },
  'Other Co': {
    companyId: 'other-co',
    ndicName: 'OTHER 1-1-1H',
    ndicApiNo: '33-000-00000-00-00',
    waterWeight: 9.5,
  },
};

describe('evaluateWbtWellLookup', () => {
  it('resolves one company well by key and returns allowlisted fields only', () => {
    const decided = evaluateWbtWellLookup({
      wellConfigKey: 'Gabriel 1',
      companyId: COMPANY,
      wellConfig: WELLS,
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.wellConfigKey).toBe('Gabriel 1');
    expect(decided.wellId).toBe('33-053-09031-00-00');
    expect(decided.config.waterWeight).toBe(8.34);
    expect(decided.config.h2sStatus).toBe('low');
    expect(decided.config.tanks).toBe(2);
    expect(decided.config.bblPerFoot).toBe(40);
    expect(decided.config.allowedBottom).toBe(3);
    expect(decided.config.pullBbls).toBe(140);
    expect(decided.config.route).toBe('Gabriels');
    expect(decided.config).not.toHaveProperty('passcode');
    expect(decided.config).not.toHaveProperty('companyId');
  });

  it('resolves unique NDIC name / API and fails closed on miss, stale, ambiguous, wrong company', () => {
    expect(evaluateWbtWellLookup({
      wellName: 'GABRIEL 1-36-25H',
      companyId: COMPANY,
      wellConfig: WELLS,
    }).ok).toBe(true);
    expect(evaluateWbtWellLookup({
      wellId: '33-053-09031-00-00',
      companyId: COMPANY,
      wellConfig: WELLS,
    }).ok).toBe(true);
    expect(evaluateWbtWellLookup({
      wellName: 'No Such',
      companyId: COMPANY,
      wellConfig: WELLS,
    })).toEqual({ ok: false, reason: 'well_not_found' });
    expect(evaluateWbtWellLookup({
      wellConfigKey: 'Gabriel 1',
      wellName: 'SOME OTHER WELL',
      companyId: COMPANY,
      wellConfig: WELLS,
    })).toEqual({ ok: false, reason: 'stale_well_binding' });
    expect(evaluateWbtWellLookup({
      wellConfigKey: 'Gabriel 1',
      companyId: COMPANY,
      wellConfig: WELLS,
    }).ok).toBe(true);
    expect(evaluateWbtWellLookup({
      wellName: 'OTHER 1-1-1H',
      companyId: COMPANY,
      wellConfig: WELLS,
    })).toEqual({ ok: false, reason: 'well_not_found' });
    expect(evaluateWbtWellLookup({
      wellConfigKey: 'Other Co',
      companyId: COMPANY,
      wellConfig: WELLS,
    })).toEqual({ ok: false, reason: 'cross_company_well' });
    expect(evaluateWbtWellLookup({
      companyId: COMPANY,
      wellConfig: WELLS,
    })).toEqual({ ok: false, reason: 'missing_well_identity' });

    const ambiguous = {
      ...WELLS,
      'Gabriel 1 Twin': { companyId: COMPANY, ndicName: 'GABRIEL 1-36-25H' },
    };
    expect(evaluateWbtWellLookup({
      wellName: 'GABRIEL 1-36-25H',
      companyId: COMPANY,
      wellConfig: ambiguous,
    })).toEqual({ ok: false, reason: 'ambiguous_well' });
  });
});
