import {
  OILFIELD_PRODUCED_WATER_ALLOCATION_V1,
  OILFIELD_PRODUCED_WATER_ALLOCATION_V1_HASH,
  OILFIELD_PRODUCED_WATER_SPLIT_ACTIVATION_V1,
  OILFIELD_PRODUCED_WATER_SPLIT_ACTIVATION_V1_HASH,
  REGISTERED_CAPABILITY_POLICIES,
  computePolicyContentHash,
  findRegisteredPolicy,
} from '../jobPacketPolicyRegistry';

describe('jobPacketPolicyRegistry', () => {
  it('computes exact canonical sha256 hash for allocation policy v1', () => {
    const computed = computePolicyContentHash(OILFIELD_PRODUCED_WATER_ALLOCATION_V1);
    expect(computed).toBe(OILFIELD_PRODUCED_WATER_ALLOCATION_V1_HASH);
    expect(computed).toMatch(/^[a-f0-9]{64}$/);
  });

  it('computes exact canonical sha256 hash for split activation policy v1', () => {
    const computed = computePolicyContentHash(OILFIELD_PRODUCED_WATER_SPLIT_ACTIVATION_V1);
    expect(computed).toBe(OILFIELD_PRODUCED_WATER_SPLIT_ACTIVATION_V1_HASH);
    expect(computed).toMatch(/^[a-f0-9]{64}$/);
  });

  it('freezes registered definitions against mutation', () => {
    expect(Object.isFrozen(OILFIELD_PRODUCED_WATER_ALLOCATION_V1)).toBe(true);
    expect(Object.isFrozen(OILFIELD_PRODUCED_WATER_ALLOCATION_V1.rules)).toBe(true);
    expect(Object.isFrozen(OILFIELD_PRODUCED_WATER_SPLIT_ACTIVATION_V1)).toBe(true);
    expect(Object.isFrozen(OILFIELD_PRODUCED_WATER_SPLIT_ACTIVATION_V1.rules)).toBe(true);
    expect(Object.isFrozen(REGISTERED_CAPABILITY_POLICIES)).toBe(true);
  });

  it('finds registered multiHaul allocation policy', () => {
    const found = findRegisteredPolicy('multiHaul', 'allocationPolicy', {
      policyId: 'oilfield-produced-water-allocation',
      revision: 1,
      contentHash: OILFIELD_PRODUCED_WATER_ALLOCATION_V1_HASH,
    });
    expect(found).not.toBeNull();
    expect(found?.kind).toBe('allocation');
    expect(found?.policyId).toBe('oilfield-produced-water-allocation');
    expect(found?.revision).toBe(1);
  });

  it('finds registered splitTicket activation policy', () => {
    const found = findRegisteredPolicy('splitTicket', 'activationPolicy', {
      policyId: 'oilfield-produced-water-split-activation',
      revision: 1,
      contentHash: OILFIELD_PRODUCED_WATER_SPLIT_ACTIVATION_V1_HASH,
    });
    expect(found).not.toBeNull();
    expect(found?.kind).toBe('splitActivation');
    expect(found?.policyId).toBe('oilfield-produced-water-split-activation');
    expect(found?.revision).toBe(1);
  });

  it('rejects unknown policyId', () => {
    const found = findRegisteredPolicy('multiHaul', 'allocationPolicy', {
      policyId: 'unknown-allocation',
      revision: 1,
      contentHash: OILFIELD_PRODUCED_WATER_ALLOCATION_V1_HASH,
    });
    expect(found).toBeNull();
  });

  it('rejects wrong revision', () => {
    const found = findRegisteredPolicy('multiHaul', 'allocationPolicy', {
      policyId: 'oilfield-produced-water-allocation',
      revision: 2,
      contentHash: OILFIELD_PRODUCED_WATER_ALLOCATION_V1_HASH,
    });
    expect(found).toBeNull();
  });

  it('rejects mismatched content hash', () => {
    const found = findRegisteredPolicy('multiHaul', 'allocationPolicy', {
      policyId: 'oilfield-produced-water-allocation',
      revision: 1,
      contentHash: 'f'.repeat(64),
    });
    expect(found).toBeNull();
  });

  it('rejects capability mismatch (allocation policy under splitTicket)', () => {
    const found = findRegisteredPolicy('splitTicket', 'activationPolicy', {
      policyId: 'oilfield-produced-water-allocation',
      revision: 1,
      contentHash: OILFIELD_PRODUCED_WATER_ALLOCATION_V1_HASH,
    });
    expect(found).toBeNull();
  });

  it('rejects non-object or null policy input', () => {
    expect(findRegisteredPolicy('multiHaul', 'allocationPolicy', null)).toBeNull();
    expect(findRegisteredPolicy('multiHaul', 'allocationPolicy', undefined)).toBeNull();
    expect(findRegisteredPolicy('multiHaul', 'allocationPolicy', 'string')).toBeNull();
    expect(findRegisteredPolicy('multiHaul', 'allocationPolicy', [])).toBeNull();
  });
});
