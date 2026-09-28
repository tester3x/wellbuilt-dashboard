import { lookupDvirAssetIdentity, type IdentityLookupIo } from '../services/dvirAssetIdentityLookup';

const AUTH = {
  uid: 'uid-1',
  token: { kind: 'driver', driverId: 'drv-1', companyId: 'co-1' },
};

function io(over: Partial<IdentityLookupIo> = {}): IdentityLookupIo & { writes: number } {
  const store = {
    writes: 0,
    loadAuthority: async () => ({ active: true, companyId: 'co-1' }),
    listActiveAssignments: async () => ({ rows: [], truncated: false }),
    loadEquipment: async () => null,
    listActiveByTypeAndUnit: async () => ({ rows: [], truncated: false }),
    ...over,
  };
  return store;
}

function eq(over: Partial<{
  equipmentId: string; companyId: string; equipmentTypeId: string; unitNumber: string; active: boolean;
}> = {}) {
  return {
    equipmentId: 'eq-truck-1',
    companyId: 'co-1',
    equipmentTypeId: 'truck',
    unitNumber: 'WB-1',
    active: true,
    ...over,
  };
}

describe('lookupDvirAssetIdentity', () => {
  it('resolves the authenticated driver assignment and ignores a forged company', async () => {
    const deps = io({
      listActiveAssignments: async () => ({ rows: [{ equipmentId: 'eq-truck-1' }], truncated: false }),
      loadEquipment: async () => eq(),
    });
    const decision = await lookupDvirAssetIdentity({
      auth: AUTH,
      payload: { requests: [{ role: 'truck', typedUnit: 'OTHER' }], companyId: 'attacker', driverHash: 'attacker' },
      io: deps,
    });
    expect(decision).toEqual({ ok: false, reason: 'malformed' });
    const clean = await lookupDvirAssetIdentity({
      auth: AUTH,
      payload: { requests: [{ role: 'truck' }] },
      io: deps,
    });
    expect(clean).toEqual({
      ok: true,
      startJobSatisfied: false,
      roles: [{ role: 'truck', status: 'resolved', equipmentId: 'eq-truck-1' }],
    });
    expect(deps.writes).toBe(0);
  });

  it('fails closed without auth or when the claim company disagrees', async () => {
    expect(await lookupDvirAssetIdentity({
      auth: { uid: null, token: null },
      payload: { requests: [] },
      io: io(),
    })).toEqual({ ok: false, reason: 'unauthenticated' });
    expect(await lookupDvirAssetIdentity({
      auth: { uid: 'uid-1', token: { kind: 'staff', driverId: 'drv-1' } },
      payload: { requests: [] },
      io: io(),
    })).toEqual({ ok: false, reason: 'forbidden' });
    expect(await lookupDvirAssetIdentity({
      auth: { uid: 'uid-1', token: { kind: 'driver', driverId: 'drv-1', companyId: 'other-co' } },
      payload: { requests: [] },
      io: io(),
    })).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('fails closed on two active trucks and does not pick one', async () => {
    const decision = await lookupDvirAssetIdentity({
      auth: AUTH,
      payload: { requests: [{ role: 'truck' }] },
      io: io({
        listActiveAssignments: async () => ({
          rows: [{ equipmentId: 'eq-a' }, { equipmentId: 'eq-b' }],
          truncated: false,
        }),
        loadEquipment: async (_company, equipmentId) => eq({ equipmentId }),
      }),
    });
    expect(decision).toEqual({
      ok: true,
      startJobSatisfied: false,
      roles: [{ role: 'truck', status: 'ambiguous', reason: 'multiple_assignments', matchCount: 2 }],
    });
  });

  it('does not accept missing, inactive, or wrong-company equipment', async () => {
    const missing = await lookupDvirAssetIdentity({
      auth: AUTH,
      payload: { requests: [{ role: 'truck', typedUnit: 'WB-1' }] },
      io: io({
        listActiveAssignments: async () => ({ rows: [{ equipmentId: 'missing' }], truncated: false }),
        loadEquipment: async () => null,
        listActiveByTypeAndUnit: async () => ({
          rows: [{ equipmentId: 'eq-real', equipmentTypeId: 'truck', unitNumber: 'WB-1' }],
          truncated: false,
        }),
      }),
    });
    expect(missing.ok && missing.roles[0]).toEqual({
      role: 'truck', status: 'unresolved', reason: 'assignment_unusable',
    });

    const inactive = await lookupDvirAssetIdentity({
      auth: AUTH,
      payload: { requests: [{ role: 'truck' }, { role: 'trailer', typedUnit: 'T-1' }] },
      io: io({
        listActiveAssignments: async () => ({ rows: [{ equipmentId: 'eq-old' }], truncated: false }),
        loadEquipment: async () => eq({ equipmentId: 'eq-old', active: false }),
        listActiveByTypeAndUnit: async () => ({
          rows: [{ equipmentId: 'eq-trailer-1', equipmentTypeId: 'trailer', unitNumber: 'T-1' }],
          truncated: false,
        }),
      }),
    });
    expect(inactive).toEqual({
      ok: true,
      startJobSatisfied: false,
      roles: [
        { role: 'truck', status: 'unresolved', reason: 'assignment_unusable' },
        { role: 'trailer', status: 'resolved', equipmentId: 'eq-trailer-1' },
      ],
    });
  });

  it('resolves one unit and refuses duplicate units without limit(1)', async () => {
    const one = await lookupDvirAssetIdentity({
      auth: AUTH,
      payload: { requests: [{ role: 'trailer', typedUnit: ' t-318 ' }] },
      io: io({
        listActiveByTypeAndUnit: async (_c, typeId, unit) => ({
          truncated: false,
          rows: unit === 'T-318' && typeId === 'trailer'
            ? [{ equipmentId: 'eq-trailer-1', equipmentTypeId: 'trailer', unitNumber: 'T-318' }]
            : [],
        }),
      }),
    });
    expect(one.ok && one.roles[0]).toEqual({
      role: 'trailer', status: 'resolved', equipmentId: 'eq-trailer-1',
    });

    const duplicates = await lookupDvirAssetIdentity({
      auth: AUTH,
      payload: { requests: [{ role: 'truck', typedUnit: '12' }] },
      io: io({
        listActiveByTypeAndUnit: async () => ({
          truncated: false,
          rows: [
            { equipmentId: 'eq-1', equipmentTypeId: 'truck', unitNumber: '12' },
            { equipmentId: 'eq-2', equipmentTypeId: 'truck', unitNumber: '12' },
          ],
        }),
      }),
    });
    expect(duplicates.ok && duplicates.roles[0]).toEqual({
      role: 'truck', status: 'ambiguous', reason: 'duplicate_units', matchCount: 2,
    });
  });

  it('ignores wrong company and wrong type rows', async () => {
    const decision = await lookupDvirAssetIdentity({
      auth: AUTH,
      payload: { requests: [{ role: 'truck', typedUnit: '12' }] },
      io: io({
        listActiveByTypeAndUnit: async () => ({
          truncated: false,
          rows: [{ equipmentId: 'eq-pump', equipmentTypeId: 'pump', unitNumber: '12' }],
        }),
      }),
    });
    expect(decision.ok && decision.roles[0]).toEqual({ role: 'truck', status: 'unregistered' });
  });

  it('keeps a trailer id when only the truck unit changes', async () => {
    const decision = await lookupDvirAssetIdentity({
      auth: AUTH,
      payload: { requests: [{ role: 'truck', typedUnit: 'WB-2' }, { role: 'trailer' }] },
      io: io({
        listActiveAssignments: async () => ({ rows: [{ equipmentId: 'eq-trailer-1' }], truncated: false }),
        loadEquipment: async () => eq({
          equipmentId: 'eq-trailer-1', equipmentTypeId: 'trailer', unitNumber: 'T-1',
        }),
        listActiveByTypeAndUnit: async () => ({
          truncated: false,
          rows: [{ equipmentId: 'eq-truck-2', equipmentTypeId: 'truck', unitNumber: 'WB-2' }],
        }),
      }),
    });
    expect(decision).toEqual({
      ok: true,
      startJobSatisfied: false,
      roles: [
        { role: 'truck', status: 'resolved', equipmentId: 'eq-truck-2' },
        { role: 'trailer', status: 'resolved', equipmentId: 'eq-trailer-1' },
      ],
    });
  });

  it('keeps truck and trailer swaps independent', async () => {
    const decision = await lookupDvirAssetIdentity({
      auth: AUTH,
      payload: {
        requests: [
          { role: 'truck' },
          { role: 'trailer', typedUnit: 'T-9' },
        ],
      },
      io: io({
        listActiveAssignments: async () => ({ rows: [{ equipmentId: 'eq-truck-1' }], truncated: false }),
        loadEquipment: async () => eq(),
        listActiveByTypeAndUnit: async () => ({
          truncated: false,
          rows: [{ equipmentId: 'eq-trailer-9', equipmentTypeId: 'trailer', unitNumber: 'T-9' }],
        }),
      }),
    });
    expect(decision).toEqual({
      ok: true,
      startJobSatisfied: false,
      roles: [
        { role: 'truck', status: 'resolved', equipmentId: 'eq-truck-1' },
        { role: 'trailer', status: 'resolved', equipmentId: 'eq-trailer-9' },
      ],
    });
  });

  it('rejects an empty request as satisfaction and rejects oversized input', async () => {
    const empty = await lookupDvirAssetIdentity({
      auth: AUTH,
      payload: { requests: [] },
      io: io(),
    });
    expect(empty).toEqual({ ok: true, startJobSatisfied: false, roles: [] });
    expect(await lookupDvirAssetIdentity({
      auth: AUTH,
      payload: { requests: [{ role: 'truck', typedUnit: 'X'.repeat(65) }] },
      io: io(),
    })).toEqual({ ok: false, reason: 'malformed' });
    expect(await lookupDvirAssetIdentity({
      auth: AUTH,
      payload: { requests: [{ role: 'truck', verified: true }] },
      io: io(),
    })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns unresolved when a query is truncated or fails, and does not write', async () => {
    const deps = io({
      listActiveAssignments: async () => ({ rows: [{ equipmentId: 'eq-1' }], truncated: true }),
    });
    expect(await lookupDvirAssetIdentity({
      auth: AUTH,
      payload: { requests: [{ role: 'truck' }] },
      io: deps,
    })).toEqual({
      ok: true,
      startJobSatisfied: false,
      roles: [{ role: 'truck', status: 'unresolved', reason: 'query_truncated' }],
    });
    expect(await lookupDvirAssetIdentity({
      auth: AUTH,
      payload: { requests: [{ role: 'truck', typedUnit: '1' }] },
      io: io({
        listActiveByTypeAndUnit: async () => { throw new Error('firestore down'); },
      }),
    })).toEqual({ ok: false, reason: 'lookup_failed' });
    expect(deps.writes).toBe(0);
  });
});
