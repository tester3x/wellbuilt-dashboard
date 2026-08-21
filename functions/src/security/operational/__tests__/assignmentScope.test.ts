import {
  assignmentDigest,
  evaluateAssignmentTransaction,
  knownRouteNames,
  parseScopeList,
  previewContextDigest,
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

describe('preview-context digest binds driver, company, revision, and scopes', () => {
  const driverId = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
  const otherId = '99ff4b35-51ab-4d45-8d54-18b3b8515c9b';
  const proposed = ['Watford'];
  const ctx = () => previewContextDigest({
    driverId,
    companyId: 'liquid-gold',
    assignmentRevision: 0,
    currentRoutes: ['Gabriels'],
    currentWells: [],
    proposedRoutes: proposed,
    proposedWells: [],
  });

  it('accepts a matching context and rejects driver/company/revision/proposed mismatches', () => {
    expect(evaluateAssignmentTransaction({
      driverId,
      profile: DRIVER_ID_PROFILE,
      expectedPreviewContextDigest: ctx(),
      proposedRoutes: proposed,
      proposedWells: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    }).ok).toBe(true);

    expect(evaluateAssignmentTransaction({
      driverId: otherId,
      profile: DRIVER_ID_PROFILE,
      expectedPreviewContextDigest: ctx(),
      proposedRoutes: proposed,
      proposedWells: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'stale_preview_context' });

    expect(evaluateAssignmentTransaction({
      driverId,
      profile: { ...DRIVER_ID_PROFILE, companyId: 'other-co' },
      expectedPreviewContextDigest: ctx(),
      proposedRoutes: proposed,
      proposedWells: [],
      callerCompanyId: 'other-co',
      isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'stale_preview_context' });

    expect(evaluateAssignmentTransaction({
      driverId,
      profile: { ...DRIVER_ID_PROFILE, assignmentRevision: 4, assignedRoutes: ['Gabriels'] },
      expectedPreviewContextDigest: ctx(),
      proposedRoutes: proposed,
      proposedWells: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'stale_preview_context' });

    expect(evaluateAssignmentTransaction({
      driverId,
      profile: DRIVER_ID_PROFILE,
      expectedPreviewContextDigest: ctx(),
      proposedRoutes: ['Gabriels'],
      proposedWells: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'stale_preview_context' });
  });

  it('rejects inactive and tenant-mismatched profiles before digest compare', () => {
    expect(evaluateAssignmentTransaction({
      driverId,
      profile: { ...DRIVER_ID_PROFILE, active: false },
      expectedPreviewContextDigest: ctx(),
      proposedRoutes: proposed,
      proposedWells: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'profile_inactive' });
    expect(evaluateAssignmentTransaction({
      driverId,
      profile: DRIVER_ID_PROFILE,
      expectedPreviewContextDigest: ctx(),
      proposedRoutes: proposed,
      proposedWells: [],
      callerCompanyId: 'other-co',
      isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'tenant_mismatch' });
  });
});
