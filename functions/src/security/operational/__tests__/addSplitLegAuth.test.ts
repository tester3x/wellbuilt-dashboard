import {
  decideAddSplitLegAuthority,
  parentOwnerId,
  splitAttemptKey,
  SPLIT_STAFF_CAPABILITY,
} from '../addSplitLegAuth';

const parent = {
  companyId: 'liquid-gold',
  driverId: 'drv-a',
  splitGroupId: 'sg1',
};

describe('decideAddSplitLegAuthority', () => {
  it('denies missing caller, parent, company, and split chain', () => {
    expect(decideAddSplitLegAuthority({ caller: null, parent })).toMatchObject({
      ok: false,
      reason: 'unauthenticated',
    });
    expect(
      decideAddSplitLegAuthority({
        caller: { class: 'driver', uid: 'u', driverId: 'drv-a', companyId: 'liquid-gold' },
        parent: null,
      }),
    ).toMatchObject({ ok: false, reason: 'unscoped_resource' });
    expect(
      decideAddSplitLegAuthority({
        caller: { class: 'driver', uid: 'u', driverId: 'drv-a', companyId: 'liquid-gold' },
        parent: { ...parent, companyId: '' },
      }),
    ).toMatchObject({ ok: false, reason: 'unscoped_resource' });
    expect(
      decideAddSplitLegAuthority({
        caller: { class: 'driver', uid: 'u', driverId: 'drv-a', companyId: 'liquid-gold' },
        parent: { ...parent, splitGroupId: '' },
      }),
    ).toMatchObject({ ok: false, reason: 'no_split_chain' });
  });

  it('allows owning driver and denies other driver / other company / missing owner', () => {
    const driver = { class: 'driver' as const, uid: 'u', driverId: 'drv-a', companyId: 'liquid-gold' };
    expect(decideAddSplitLegAuthority({ caller: driver, parent }).ok).toBe(true);
    expect(
      decideAddSplitLegAuthority({
        caller: { ...driver, driverId: 'drv-b' },
        parent,
      }),
    ).toMatchObject({ ok: false, reason: 'not_owner' });
    expect(
      decideAddSplitLegAuthority({
        caller: { ...driver, companyId: 'acme-demo' },
        parent,
      }),
    ).toMatchObject({ ok: false, reason: 'cross_company' });
    expect(
      decideAddSplitLegAuthority({
        caller: driver,
        parent: { companyId: 'liquid-gold', splitGroupId: 'sg1' },
      }),
    ).toMatchObject({ ok: false, reason: 'missing_owner' });
  });

  it('uses server-mapped owner when parent has only a legacy hash', () => {
    const driver = { class: 'driver' as const, uid: 'u', driverId: 'drv-a', companyId: 'liquid-gold' };
    const hashed = { companyId: 'liquid-gold', splitGroupId: 'sg1' };
    expect(decideAddSplitLegAuthority({ caller: driver, parent: hashed })).toMatchObject({
      ok: false,
      reason: 'missing_owner',
    });
    expect(
      decideAddSplitLegAuthority({
        caller: driver,
        parent: hashed,
        serverMappedOwnerId: 'drv-a',
      }).ok,
    ).toBe(true);
    expect(
      decideAddSplitLegAuthority({
        caller: driver,
        parent: hashed,
        serverMappedOwnerId: 'drv-b',
      }),
    ).toMatchObject({ ok: false, reason: 'not_owner' });
    expect(parentOwnerId(hashed, 'drv-a')).toBe('drv-a');
  });

  it('allows staff with createDispatch at the parent company only', () => {
    const staff = {
      class: 'staff' as const,
      uid: 's',
      companyId: 'liquid-gold',
      caps: [SPLIT_STAFF_CAPABILITY],
    };
    expect(decideAddSplitLegAuthority({ caller: staff, parent }).ok).toBe(true);
    expect(
      decideAddSplitLegAuthority({
        caller: { ...staff, caps: ['viewTickets'] },
        parent,
      }),
    ).toMatchObject({ ok: false, reason: 'missing_capability' });
    expect(
      decideAddSplitLegAuthority({
        caller: { ...staff, companyId: 'acme-demo' },
        parent,
      }),
    ).toMatchObject({ ok: false, reason: 'cross_company' });
  });

  it('allows complete platform admin and ignores client company override', () => {
    expect(
      decideAddSplitLegAuthority({
        caller: { class: 'platform', uid: 'admin-1' },
        parent,
      }).ok,
    ).toBe(true);
  });

  it('retry key is stable for the same caller/parent/disposal', () => {
    const a = splitAttemptKey({
      uid: 'u',
      splitGroupId: 'sg1',
      parentDispatchId: 'd1',
      disposal: ' Hydro Clear ',
    });
    const b = splitAttemptKey({
      uid: 'u',
      splitGroupId: 'sg1',
      parentDispatchId: 'd1',
      disposal: 'hydro clear',
    });
    expect(a).toBe(b);
  });
});
