import { resolveDvirAssetIdentity, type DvirAssetIdentityInput } from '../dvirAssetIdentity';
import { evaluateDvirAssetCoverage } from '../dvirAssetCoverage';

const OPEN = { state: 'open' as const, companyId: 'co-1', driverId: 'drv-1' };

function input(over: Partial<DvirAssetIdentityInput> = {}): DvirAssetIdentityInput {
  return {
    authority: OPEN,
    requests: [{ role: 'truck' }, { role: 'trailer' }],
    assignments: [],
    registry: [],
    ...over,
  };
}

describe('resolveDvirAssetIdentity', () => {
  it('resolves one active assignment and does not treat that as Start Job success', () => {
    const decision = resolveDvirAssetIdentity(input({
      requests: [{ role: 'truck', typedUnit: 'WB-1' }],
      assignments: [{
        companyId: 'co-1', driverId: 'drv-1', active: true,
        equipmentId: 'eq-truck-1', equipmentTypeId: 'truck',
      }],
    }));
    expect(decision).toEqual({
      ok: true,
      startJobSatisfied: false,
      roles: [{ role: 'truck', status: 'resolved', equipmentId: 'eq-truck-1' }],
    });
  });

  it('fails closed when two assignments share a role', () => {
    const decision = resolveDvirAssetIdentity(input({
      requests: [{ role: 'truck' }],
      assignments: [
        { companyId: 'co-1', driverId: 'drv-1', active: true, equipmentId: 'eq-a', equipmentTypeId: 'truck' },
        { companyId: 'co-1', driverId: 'drv-1', active: true, equipmentId: 'eq-b', equipmentTypeId: 'truck' },
      ],
      registry: [{
        companyId: 'co-1', active: true, equipmentId: 'eq-a', equipmentTypeId: 'truck', unitNumber: '1',
      }],
    }));
    expect(decision.ok && decision.roles[0]).toEqual({
      role: 'truck', status: 'ambiguous', reason: 'multiple_assignments', matchCount: 2,
    });
  });

  it('is unregistered when nothing is assigned or registered', () => {
    const decision = resolveDvirAssetIdentity(input({
      requests: [{ role: 'trailer', typedUnit: 'T-9' }],
    }));
    expect(decision.ok && decision.roles[0]).toEqual({ role: 'trailer', status: 'unregistered' });
  });

  it('resolves one typed unit only when every active match is returned', () => {
    const decision = resolveDvirAssetIdentity(input({
      requests: [{ role: 'trailer', typedUnit: ' t-318 ' }],
      registry: [{
        companyId: 'co-1', active: true, equipmentId: 'eq-trailer-1',
        equipmentTypeId: 'Trailer', unitNumber: 'T-318',
      }],
    }));
    expect(decision.ok && decision.roles[0]).toEqual({
      role: 'trailer', status: 'resolved', equipmentId: 'eq-trailer-1',
    });
  });

  it('does not pick among duplicate active units', () => {
    const decision = resolveDvirAssetIdentity(input({
      requests: [{ role: 'truck', typedUnit: '12' }],
      registry: [
        { companyId: 'co-1', active: true, equipmentId: 'eq-1', equipmentTypeId: 'truck', unitNumber: '12' },
        { companyId: 'co-1', active: true, equipmentId: 'eq-2', equipmentTypeId: 'truck', unitNumber: '12' },
      ],
    }));
    expect(decision.ok && decision.roles[0]).toEqual({
      role: 'truck', status: 'ambiguous', reason: 'duplicate_units', matchCount: 2,
    });
  });

  it('ignores another company and the wrong equipment type', () => {
    const decision = resolveDvirAssetIdentity(input({
      requests: [{ role: 'truck', typedUnit: '12' }],
      assignments: [{
        companyId: 'other', driverId: 'drv-1', active: true,
        equipmentId: 'eq-other', equipmentTypeId: 'truck',
      }, {
        companyId: 'co-1', driverId: 'drv-1', active: true,
        equipmentId: 'eq-trailer', equipmentTypeId: 'trailer',
      }],
      registry: [{
        companyId: 'other', active: true, equipmentId: 'eq-foreign',
        equipmentTypeId: 'truck', unitNumber: '12',
      }, {
        companyId: 'co-1', active: true, equipmentId: 'eq-pump',
        equipmentTypeId: 'pump', unitNumber: '12',
      }],
    }));
    expect(decision.ok && decision.roles[0]).toEqual({ role: 'truck', status: 'unregistered' });
  });

  it('keeps the truck id when only the trailer unit changes', () => {
    const first = resolveDvirAssetIdentity(input({
      requests: [
        { role: 'truck' },
        { role: 'trailer', typedUnit: 'T-1' },
      ],
      assignments: [{
        companyId: 'co-1', driverId: 'drv-1', active: true,
        equipmentId: 'eq-truck-1', equipmentTypeId: 'truck',
      }],
      registry: [{
        companyId: 'co-1', active: true, equipmentId: 'eq-trailer-1',
        equipmentTypeId: 'trailer', unitNumber: 'T-1',
      }],
    }));
    const swapped = resolveDvirAssetIdentity(input({
      requests: [
        { role: 'truck' },
        { role: 'trailer', typedUnit: 'T-9' },
      ],
      assignments: [{
        companyId: 'co-1', driverId: 'drv-1', active: true,
        equipmentId: 'eq-truck-1', equipmentTypeId: 'truck',
      }],
      registry: [{
        companyId: 'co-1', active: true, equipmentId: 'eq-trailer-9',
        equipmentTypeId: 'trailer', unitNumber: 'T-9',
      }],
    }));
    expect(first.ok && first.roles).toEqual([
      { role: 'truck', status: 'resolved', equipmentId: 'eq-truck-1' },
      { role: 'trailer', status: 'resolved', equipmentId: 'eq-trailer-1' },
    ]);
    expect(swapped.ok && swapped.roles).toEqual([
      { role: 'truck', status: 'resolved', equipmentId: 'eq-truck-1' },
      { role: 'trailer', status: 'resolved', equipmentId: 'eq-trailer-9' },
    ]);
  });

  it('keeps the trailer id when only the truck unit changes', () => {
    const decision = resolveDvirAssetIdentity(input({
      requests: [
        { role: 'truck', typedUnit: 'WB-2' },
        { role: 'trailer' },
      ],
      assignments: [{
        companyId: 'co-1', driverId: 'drv-1', active: true,
        equipmentId: 'eq-trailer-1', equipmentTypeId: 'trailer',
      }],
      registry: [{
        companyId: 'co-1', active: true, equipmentId: 'eq-truck-2',
        equipmentTypeId: 'truck', unitNumber: 'WB-2',
      }],
    }));
    expect(decision.ok && decision.roles).toEqual([
      { role: 'truck', status: 'resolved', equipmentId: 'eq-truck-2' },
      { role: 'trailer', status: 'resolved', equipmentId: 'eq-trailer-1' },
    ]);
  });

  it('does not treat a unit-derived id as the canonical equipment id', () => {
    const decision = resolveDvirAssetIdentity(input({
      requests: [{ role: 'truck', typedUnit: '12', cachedEquipmentId: 'truck_12' }],
      assignments: [{
        companyId: 'co-1', driverId: 'drv-1', active: true,
        equipmentId: 'truck_12', equipmentTypeId: 'truck',
      }],
      registry: [{
        companyId: 'co-1', active: true, equipmentId: 'truck_12',
        equipmentTypeId: 'truck', unitNumber: '12',
      }, {
        companyId: 'co-1', active: true, equipmentId: 'eq-real',
        equipmentTypeId: 'truck', unitNumber: '99',
      }],
    }));
    expect(decision.ok && decision.roles[0]).toEqual({ role: 'truck', status: 'non_canonical' });
  });

  it('reports unavailable authority instead of an off-shift decision', () => {
    const decision = resolveDvirAssetIdentity(input({
      authority: { state: 'unavailable' },
      requests: [{ role: 'truck', typedUnit: '1' }],
      assignments: [{
        companyId: 'co-1', driverId: 'drv-1', active: true,
        equipmentId: 'eq-truck-1', equipmentTypeId: 'truck',
      }],
    }));
    expect(decision).toEqual({
      ok: true,
      startJobSatisfied: false,
      roles: [{ role: 'truck', status: 'unavailable' }],
    });
  });

  it('does not call an empty request a satisfied Start Job', () => {
    const decision = resolveDvirAssetIdentity(input({ requests: [] }));
    expect(decision).toEqual({ ok: true, startJobSatisfied: false, roles: [] });
    const coverage = evaluateDvirAssetCoverage({
      phase: 'pre_trip',
      authority: { state: 'open', companyId: 'co-1', driverId: 'drv-1', periodId: '2026-09-27_080000' },
      assets: [],
      rows: [],
    });
    expect(coverage).toEqual({
      ok: true,
      phase: 'pre_trip',
      period: { state: 'open', periodId: '2026-09-27_080000' },
      assets: [],
    });
    expect(decision.ok && decision.startJobSatisfied).toBe(false);
  });

  it('keeps a cached canonical id unverified when the server has no match', () => {
    const decision = resolveDvirAssetIdentity(input({
      requests: [{ role: 'truck', cachedEquipmentId: 'eq-cached' }],
    }));
    expect(decision.ok && decision.roles[0]).toEqual({
      role: 'truck', status: 'cached_unverified', equipmentId: 'eq-cached',
    });
  });
});
