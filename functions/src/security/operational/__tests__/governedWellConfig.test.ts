import {
  evaluateGovernedWellConfig,
  evaluateGovernedWellConfigRequest,
  toGovernedWellConfig,
} from '../governedWellConfig';

const COMPANY = 'liquid-gold';
const wellConfig = {
  'Gabriel 5': {
    route: 'Gabriels',
    companyId: COMPANY,
    ndicName: 'GABRIEL 5',
    ndicApiNo: '33-053-01234-00-00',
    h2sStatus: 'low',
    waterWeight: 8.34,
    bblPerFoot: 40,
    tanks: 2,
    tankCapacity: 400,
    tankHeight: 20,
  },
  'Watford 1': {
    route: 'Watford',
    companyId: COMPANY,
    ndicApiNo: '33-053-09999-00-00',
    tanks: 1,
  },
  'String Rate 1': {
    route: 'Gabriels',
    companyId: COMPANY,
    bblPerFoot: '40.5',
    tankCapacity: '400',
    tankHeight: '20',
    numTanks: '2',
    waterWeight: '8.34',
  },
  'Other Co 1': {
    route: 'Gabriels',
    companyId: 'other-co',
    tanks: 1,
  },
};

describe('evaluateGovernedWellConfigRequest', () => {
  it('accepts the WB-T allowlist { wellName, assignmentKey }', () => {
    expect(evaluateGovernedWellConfigRequest({
      wellName: 'Gabriel 5',
      assignmentKey: 'inv_abc',
    })).toEqual({ ok: true, wellName: 'Gabriel 5', assignmentKey: 'inv_abc' });
    expect(evaluateGovernedWellConfigRequest({
      wellName: 'Gabriel 5',
      assignmentKey: null,
    })).toEqual({ ok: true, wellName: 'Gabriel 5', assignmentKey: null });
  });

  it('rejects extra fields and missing wellName', () => {
    expect(evaluateGovernedWellConfigRequest({
      wellName: 'Gabriel 5',
      companyId: COMPANY,
    })).toEqual({ ok: false, reason: 'unexpected_field' });
    expect(evaluateGovernedWellConfigRequest({ assignmentKey: 'x' }))
      .toEqual({ ok: false, reason: 'missing_wellName' });
  });
});

describe('evaluateGovernedWellConfig', () => {
  it('returns {ok, found, config, reason} for one requested well', () => {
    const r = evaluateGovernedWellConfig({
      companyId: COMPANY,
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      wellConfig,
      wellName: 'Gabriel 5',
      assignmentKey: 'inv_abc',
    });
    expect(r).toMatchObject({ ok: true, found: true, reason: null });
    if (!r.found) return;
    expect(r.config).toMatchObject({
      wellName: 'Gabriel 5',
      ndicName: 'GABRIEL 5',
      ndicApiNo: '33-053-01234-00-00',
      h2sStatus: 'low',
      waterWeight: 8.34,
      bblPerFoot: 40,
      tanks: 2,
      tankCapacity: 400,
      tankHeight: 20,
      route: 'Gabriels',
      companyId: COMPANY,
    });
    expect(r.config).not.toHaveProperty('canonicalWellKey');
    expect(r.config).not.toHaveProperty('wells');
  });

  it('does not invent 20×tanks when bblPerFoot is absent', () => {
    const r = evaluateGovernedWellConfig({
      companyId: COMPANY,
      assignedRoutes: ['Gabriels'],
      assignedWells: ['Watford 1'],
      wellConfig,
      wellName: 'Watford 1',
    });
    expect(r.ok).toBe(true);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.config.bblPerFoot).toBeUndefined();
    expect(r.config.tanks).toBe(1);
    expect(r.config.tankCapacity).toBeUndefined();
    expect(r.config.tankHeight).toBeUndefined();
  });

  it('passes through numeric strings used by governed well_config', () => {
    const r = evaluateGovernedWellConfig({
      companyId: COMPANY,
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      wellConfig,
      wellName: 'String Rate 1',
    });
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.config.bblPerFoot).toBe('40.5');
    expect(r.config.tankCapacity).toBe('400');
    expect(r.config.tankHeight).toBe('20');
    expect(r.config.numTanks).toBe('2');
    expect(r.config.waterWeight).toBe('8.34');
  });

  it('denies cross-company wells without leaking the row', () => {
    const r = evaluateGovernedWellConfig({
      companyId: COMPANY,
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      wellConfig,
      wellName: 'Other Co 1',
    });
    expect(r).toMatchObject({ ok: true, found: false, config: null, reason: 'well_not_found' });
  });

  it('denies unassigned wells in the same company', () => {
    const r = evaluateGovernedWellConfig({
      companyId: COMPANY,
      assignedRoutes: ['Gabriels'],
      assignedWells: [],
      wellConfig,
      wellName: 'Watford 1',
    });
    expect(r).toMatchObject({ ok: true, found: false, config: null, reason: 'well_out_of_scope' });
  });

  it('does not project secret or unbounded fields', () => {
    const rec = toGovernedWellConfig('Gabriel 5', {
      ...wellConfig['Gabriel 5'],
      secretToken: 'nope',
    });
    expect(rec).not.toHaveProperty('secretToken');
    expect(rec.wellName).toBe('Gabriel 5');
  });
});
