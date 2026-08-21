import {
  evaluateWbmWellScope,
  projectWbmWells,
  wellBelongsToDriverCompany,
  wellMatchesWbmScope,
} from '../wbmWellScope';

const gabrielsWell = { route: 'Gabriels', maxLevel: 20, secretHash: 'nope', companyId: 'liquid-gold' };
const watfordWell = { route: 'Watford', maxLevel: 18, companyId: 'liquid-gold' };
const unroutedWell = { route: 'Unrouted 2', maxLevel: 16 };
const otherCoWell = { route: 'Gabriels', maxLevel: 20, companyId: 'other-co' };
const unscopedWell = { route: 'Gabriels', maxLevel: 12 };

const pool = {
  'Gabriel 1': gabrielsWell,
  'Watford 1': watfordWell,
  'Unrouted Pad': unroutedWell,
  'Other Co 1': otherCoWell,
  'Legacy Pool 1': unscopedWell,
};

describe('evaluateWbmWellScope', () => {
  it('missing assignedRoutes and assignedWells is scope_missing, not empty', () => {
    expect(evaluateWbmWellScope(undefined, undefined)).toEqual({ ok: false, reason: 'scope_missing' });
    expect(evaluateWbmWellScope(null, null)).toEqual({ ok: false, reason: 'scope_missing' });
  });

  it('malformed non-array is distinct from missing', () => {
    expect(evaluateWbmWellScope('Gabriels', undefined)).toEqual({ ok: false, reason: 'scope_malformed' });
    expect(evaluateWbmWellScope(['Gabriels'], { well: true })).toEqual({ ok: false, reason: 'scope_malformed' });
  });

  it('explicit empty arrays are scope_empty, not all-company-wells', () => {
    expect(evaluateWbmWellScope([], [])).toEqual({ ok: false, reason: 'scope_empty' });
    expect(evaluateWbmWellScope([], undefined)).toEqual({ ok: false, reason: 'scope_empty' });
  });

  it('Unrouted-only with no assigned wells is scope_unrouted_only', () => {
    expect(evaluateWbmWellScope(['Unrouted'], [])).toEqual({ ok: false, reason: 'scope_unrouted_only' });
    expect(evaluateWbmWellScope(['Unrouted 2'], undefined)).toEqual({ ok: false, reason: 'scope_unrouted_only' });
  });

  it('a real route is scope_ok', () => {
    const s = evaluateWbmWellScope(['Gabriels', 'Unrouted'], undefined);
    expect(s).toMatchObject({ ok: true, reason: 'scope_ok', routes: ['Gabriels', 'Unrouted'] });
  });

  it('assignedWells alone is scope_ok (historical direct-permit semantics)', () => {
    const s = evaluateWbmWellScope(['Unrouted'], ['Gabriel 1']);
    expect(s).toMatchObject({ ok: true, wells: ['Gabriel 1'] });
  });
});

describe('projectWbmWells tenant + route scope', () => {
  const routed = evaluateWbmWellScope(['Gabriels'], undefined);
  if (!routed.ok) throw new Error('setup');

  it('a routed liquid-gold driver sees only wells on permitted routes', () => {
    const out = projectWbmWells(pool, 'liquid-gold', routed);
    expect(Object.keys(out).sort()).toEqual(['Gabriel 1', 'Legacy Pool 1']);
    expect(out['Gabriel 1']).not.toHaveProperty('secretHash');
    expect(out['Watford 1']).toBeUndefined();
  });

  it('directly permitted wells follow assignedWells even off-route', () => {
    const s = evaluateWbmWellScope(['Gabriels'], ['Watford 1']);
    if (!s.ok) throw new Error('setup');
    const out = projectWbmWells(pool, 'liquid-gold', s);
    expect(out['Watford 1']).toBeDefined();
    expect(out['Gabriel 1']).toBeDefined();
  });

  it('a driver cannot see another company\'s wells', () => {
    const out = projectWbmWells(pool, 'liquid-gold', routed);
    expect(out['Other Co 1']).toBeUndefined();
    const other = projectWbmWells(pool, 'other-co', routed);
    expect(Object.keys(other)).toEqual(['Other Co 1']);
    expect(other['Gabriel 1']).toBeUndefined();
    expect(other['Legacy Pool 1']).toBeUndefined();
  });

  it('unscoped well_config records belong only to liquid-gold', () => {
    expect(wellBelongsToDriverCompany(unscopedWell, 'liquid-gold')).toBe(true);
    expect(wellBelongsToDriverCompany(unscopedWell, 'other-co')).toBe(false);
  });

  it('Unrouted assignment matches Unrouted* well routes only when included in an otherwise-ok scope', () => {
    const s = evaluateWbmWellScope(['Gabriels', 'Unrouted'], []);
    if (!s.ok) throw new Error('setup');
    expect(wellMatchesWbmScope('Unrouted Pad', unroutedWell, s)).toBe(true);
    expect(wellMatchesWbmScope('Watford 1', watfordWell, s)).toBe(false);
  });
});
