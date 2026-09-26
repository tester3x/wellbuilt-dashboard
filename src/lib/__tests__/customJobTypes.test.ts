import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugifyCustomJobType,
  defaultCapabilitiesForLifecycle,
  validateNewCustomJobType,
  normalizeCustomJobType,
  CANONICAL_BUILTIN_JOB_TYPE_IDS,
} from '../customJobTypesCore.ts';
import type { CustomJobType } from '../companySettings.ts';

test('slugifyCustomJobType converts labels to clean kebab-case slugs', () => {
  assert.equal(slugifyCustomJobType('Ground Water'), 'ground-water');
  assert.equal(slugifyCustomJobType('  Vac Pipe Work  '), 'vac-pipe-work');
  assert.equal(slugifyCustomJobType('Roustabout Support! #1'), 'roustabout-support-1');
});

test('defaultCapabilitiesForLifecycle grants conservative capabilities', () => {
  assert.deepEqual(defaultCapabilitiesForLifecycle('pickup_dropoff'), ['lifecycle', 'pickup']);
  assert.deepEqual(defaultCapabilitiesForLifecycle('onsite_only'), ['lifecycle']);
});

test('validateNewCustomJobType succeeds for all 4 independent family + payBasis combinations', () => {
  // 1. Service Work + Per BBL
  const res1 = validateNewCustomJobType({
    label: 'Ground Water',
    baseJobTypeId: 'service-work',
    payBasis: 'per_bbl',
    lifecycleShape: 'pickup_dropoff',
    packages: ['water-hauling'],
  });
  assert.equal(res1.ok, true);
  if (res1.ok) {
    assert.equal(res1.value.id, 'ground-water');
    assert.equal(res1.value.label, 'Ground Water');
    assert.equal(res1.value.baseJobTypeId, 'service-work');
    assert.equal(res1.value.payBasis, 'per_bbl');
    assert.equal(res1.value.lifecycleShape, 'pickup_dropoff');
    assert.deepEqual(res1.value.capabilities, ['lifecycle', 'pickup']);
    assert.deepEqual(res1.value.packages, ['water-hauling']);
  }

  // 2. Service Work + Hourly
  const res2 = validateNewCustomJobType({
    label: 'Vac Work',
    baseJobTypeId: 'service-work',
    payBasis: 'hourly',
    lifecycleShape: 'onsite_only',
    packages: ['water-hauling'],
  });
  assert.equal(res2.ok, true);
  if (res2.ok) {
    assert.equal(res2.value.baseJobTypeId, 'service-work');
    assert.equal(res2.value.payBasis, 'hourly');
    assert.equal(res2.value.lifecycleShape, 'onsite_only');
    assert.deepEqual(res2.value.capabilities, ['lifecycle']);
  }

  // 3. Production Water + Per BBL
  const res3 = validateNewCustomJobType({
    label: 'Dedicated Haul',
    baseJobTypeId: 'pw',
    payBasis: 'per_bbl',
    lifecycleShape: 'pickup_dropoff',
    packages: ['water-hauling'],
  });
  assert.equal(res3.ok, true);
  if (res3.ok) {
    assert.equal(res3.value.baseJobTypeId, 'pw');
    assert.equal(res3.value.payBasis, 'per_bbl');
  }

  // 4. Production Water + Hourly
  const res4 = validateNewCustomJobType({
    label: 'Hourly Transfer',
    baseJobTypeId: 'pw',
    payBasis: 'hourly',
    lifecycleShape: 'onsite_only',
    packages: ['water-hauling'],
  });
  assert.equal(res4.ok, true);
  if (res4.ok) {
    assert.equal(res4.value.baseJobTypeId, 'pw');
    assert.equal(res4.value.payBasis, 'hourly');
    assert.equal(res4.value.lifecycleShape, 'onsite_only');
  }
});

test('validateNewCustomJobType fails closed when any of the 5 required fields is missing', () => {
  const base = {
    label: 'Test Type',
    baseJobTypeId: 'service-work',
    payBasis: 'hourly',
    lifecycleShape: 'onsite_only',
    packages: ['water-hauling'],
  };

  // Missing label
  assert.equal(validateNewCustomJobType({ ...base, label: '' }).ok, false);
  assert.equal(validateNewCustomJobType({ ...base, label: '   ' }).ok, false);

  // Missing / invalid family
  assert.equal(validateNewCustomJobType({ ...base, baseJobTypeId: '' }).ok, false);
  assert.equal(validateNewCustomJobType({ ...base, baseJobTypeId: 'arbitrary' }).ok, false);

  // Missing / invalid payBasis
  assert.equal(validateNewCustomJobType({ ...base, payBasis: '' }).ok, false);
  assert.equal(validateNewCustomJobType({ ...base, payBasis: 'per_ton' }).ok, false);

  // Missing / invalid lifecycle
  assert.equal(validateNewCustomJobType({ ...base, lifecycleShape: '' }).ok, false);
  assert.equal(validateNewCustomJobType({ ...base, lifecycleShape: 'destination_only' }).ok, false);

  // Missing / empty packages
  assert.equal(validateNewCustomJobType({ ...base, packages: [] }).ok, false);
});

test('validateNewCustomJobType rejects collision with built-in canonical job type IDs', () => {
  for (const builtinId of CANONICAL_BUILTIN_JOB_TYPE_IDS) {
    const res = validateNewCustomJobType({
      label: builtinId,
      baseJobTypeId: 'service-work',
      payBasis: 'hourly',
      lifecycleShape: 'onsite_only',
      packages: ['water-hauling'],
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.reason, 'canonical_collision');
    }
  }

  // Also case variations e.g. "PW" or "Service Work"
  const resPw = validateNewCustomJobType({
    label: 'PW',
    baseJobTypeId: 'pw',
    payBasis: 'per_bbl',
    lifecycleShape: 'pickup_dropoff',
    packages: ['water-hauling'],
  });
  assert.equal(resPw.ok, false);
  if (!resPw.ok) assert.equal(resPw.reason, 'canonical_collision');

  const resSw = validateNewCustomJobType({
    label: 'Service Work',
    baseJobTypeId: 'service-work',
    payBasis: 'hourly',
    lifecycleShape: 'pickup_dropoff',
    packages: ['water-hauling'],
  });
  assert.equal(resSw.ok, false);
  if (!resSw.ok) assert.equal(resSw.reason, 'canonical_collision');
});

test('validateNewCustomJobType rejects duplicate labels and duplicate slugs among existing custom types', () => {
  const existing: CustomJobType[] = [
    {
      id: 'ground-water',
      label: 'Ground Water',
      baseJobTypeId: 'service-work',
      payBasis: 'per_bbl',
      lifecycleShape: 'pickup_dropoff',
      capabilities: ['lifecycle', 'pickup'],
      packages: ['water-hauling'],
    },
  ];

  // Exact duplicate
  const dup1 = validateNewCustomJobType({
    label: 'Ground Water',
    baseJobTypeId: 'pw',
    payBasis: 'hourly',
    lifecycleShape: 'onsite_only',
    packages: ['water-hauling'],
  }, existing);
  assert.equal(dup1.ok, false);
  if (!dup1.ok) assert.equal(dup1.reason, 'duplicate_label');

  // Case variation
  const dup2 = validateNewCustomJobType({
    label: 'ground water',
    baseJobTypeId: 'pw',
    payBasis: 'hourly',
    lifecycleShape: 'onsite_only',
    packages: ['water-hauling'],
  }, existing);
  assert.equal(dup2.ok, false);
  if (!dup2.ok) assert.equal(dup2.reason, 'duplicate_label');

  // Different label but same slug
  const dup3 = validateNewCustomJobType({
    label: 'Ground_Water',
    baseJobTypeId: 'pw',
    payBasis: 'hourly',
    lifecycleShape: 'onsite_only',
    packages: ['water-hauling'],
  }, existing);
  assert.equal(dup3.ok, false);
  if (!dup3.ok) assert.equal(dup3.reason, 'duplicate_slug');
});

test('normalizeCustomJobType cleanly handles legacy string and object forms', () => {
  // Legacy string format
  const normStr = normalizeCustomJobType('Old Custom');
  assert.deepEqual(normStr, {
    id: 'old-custom',
    label: 'Old Custom',
    packages: [],
    baseJobTypeId: 'service-work',
    lifecycleShape: 'pickup_dropoff',
    capabilities: ['lifecycle', 'pickup'],
    payBasis: undefined,
  });

  // Legacy Ground Water profile without payBasis
  const legacyGw = normalizeCustomJobType({
    id: 'ground-water',
    label: 'Ground Water',
    packages: ['water-hauling', 'aggregate'],
    baseJobTypeId: 'service-work',
    lifecycleShape: 'pickup_dropoff',
    capabilities: ['lifecycle', 'pickup'],
  });
  assert.equal(legacyGw?.id, 'ground-water');
  assert.equal(legacyGw?.payBasis, undefined); // needs customer selection
  assert.equal(legacyGw?.lifecycleShape, 'pickup_dropoff');
  assert.deepEqual(legacyGw?.capabilities, ['lifecycle', 'pickup']);

  // Complete explicit v2 profile
  const v2 = normalizeCustomJobType({
    id: 'ground-water',
    label: 'Ground Water',
    packages: ['water-hauling'],
    baseJobTypeId: 'service-work',
    payBasis: 'hourly',
    lifecycleShape: 'pickup_dropoff',
    capabilities: ['lifecycle', 'pickup'],
  });
  assert.equal(v2?.payBasis, 'hourly');
});
