import {
  assignmentDigest,
  evaluateAssignmentTransaction,
  knownRouteNames,
  parseScopeList,
  validateAssignedRoutesAgainstCatalog,
  validateAssignedWellsAgainstCatalog,
} from '../assignmentScope';

const DRIVER_ID_PROFILE = {
  displayName: 'Mikezfold',
  active: true,
  companyId: 'liquid-gold',
  assignedRoutes: ['Gabriels'],
  assignedWells: [],
};

const wellConfig = {
  'Gabriel 1': { route: 'Gabriels', companyId: 'liquid-gold' },
  'Watford 1': { route: 'Watford', companyId: 'liquid-gold' },
  'Other Co 1': { route: 'Gabriels', companyId: 'other-co' },
};

describe('parseScopeList refuses invalid input instead of emptying it', () => {
  it('requires an array and rejects non-strings, blanks, duplicates, overflow', () => {
    expect(parseScopeList(undefined, 'assignedRoutes')).toEqual({ ok: false, reason: 'assignedRoutes_required' });
    expect(parseScopeList('Gabriels', 'assignedRoutes')).toEqual({ ok: false, reason: 'assignedRoutes_malformed' });
    expect(parseScopeList(['Gabriels', 1], 'assignedRoutes')).toEqual({ ok: false, reason: 'assignedRoutes_non_string' });
    expect(parseScopeList(['  '], 'assignedRoutes')).toEqual({ ok: false, reason: 'assignedRoutes_blank' });
    expect(parseScopeList(['A', 'A'], 'assignedRoutes')).toEqual({ ok: false, reason: 'assignedRoutes_duplicate' });
    expect(parseScopeList([], 'assignedRoutes')).toEqual({ ok: true, values: [] });
    expect(parseScopeList(['Gabriels'], 'assignedRoutes')).toEqual({ ok: true, values: ['Gabriels'] });
  });
});

describe('catalog validation', () => {
  it('rejects nonexistent routes and wells and cross-company wells', () => {
    const known = knownRouteNames(wellConfig);
    expect(validateAssignedRoutesAgainstCatalog(['Gabriels'], known).ok).toBe(true);
    expect(validateAssignedRoutesAgainstCatalog(['NoSuchRoute'], known))
      .toEqual({ ok: false, reason: 'nonexistent_route' });
    expect(validateAssignedWellsAgainstCatalog(['Gabriel 1'], wellConfig, 'liquid-gold').ok).toBe(true);
    expect(validateAssignedWellsAgainstCatalog(['Missing'], wellConfig, 'liquid-gold'))
      .toEqual({ ok: false, reason: 'nonexistent_well' });
    expect(validateAssignedWellsAgainstCatalog(['Other Co 1'], wellConfig, 'liquid-gold'))
      .toEqual({ ok: false, reason: 'cross_company_well' });
  });
});

describe('transactional stale preview', () => {
  it('rejects a digest that does not match canonical before-state', () => {
    const digest = assignmentDigest(['Gabriels'], []);
    const proposed = assignmentDigest(['Watford'], []);
    expect(evaluateAssignmentTransaction({
      profile: DRIVER_ID_PROFILE,
      expectedBeforeDigest: digest,
      expectedProposedDigest: proposed,
      proposedRoutes: ['Watford'],
      proposedWells: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    }).ok).toBe(true);
    expect(evaluateAssignmentTransaction({
      profile: DRIVER_ID_PROFILE,
      expectedBeforeDigest: assignmentDigest(null, null),
      expectedProposedDigest: proposed,
      proposedRoutes: ['Watford'],
      proposedWells: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'stale_preview' });
    expect(evaluateAssignmentTransaction({
      profile: DRIVER_ID_PROFILE,
      expectedBeforeDigest: digest,
      expectedProposedDigest: assignmentDigest(['Gabriels'], []),
      proposedRoutes: ['Watford'],
      proposedWells: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'proposed_digest_mismatch' });
  });
});
