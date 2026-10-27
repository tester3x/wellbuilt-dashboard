import { applyFreshWaterDelivery, overlappingFreshWaterGroup, projectFreshWaterFeet,
  validFreshWaterConfig, type FreshWaterConfig } from '../freshWaterSupplyCore';

describe('shared fresh-water tank groups', () => {
  const groups = {
    gabrielNorth: { wellNames: ['Gabriel 1', 'Gabriel 4', 'Gabriel 5', 'Gabriel 6'] },
    gabrielSouth: { wellNames: ['Gabriel 3', 'Gabriel 7'] },
    gabrielTwo: { wellNames: ['Gabriel 2'] },
  };
  it('keeps the Gabriel supplies separate and blocks duplicate well membership', () => {
    expect(overlappingFreshWaterGroup(groups, 'gabrielNorth', ['Gabriel 1', 'Gabriel 4', 'Gabriel 5', 'Gabriel 6'])).toBeNull();
    expect(overlappingFreshWaterGroup(groups, 'newGroup', ['Gabriel 4'])).toBe('gabrielNorth');
    expect(overlappingFreshWaterGroup(groups, 'newGroup', ['Gabriel 2'])).toBe('gabrielTwo');
    expect(overlappingFreshWaterGroup(groups, 'newGroup', ['Unlinked well'])).toBeNull();
  });
});

const config: FreshWaterConfig = {
  enabled: true, tankCount: 2, tankHeightFeet: 20, bblPerFootPerTank: 20,
  equalization: 'verified-equalized', dailyUseBbl: null,
};
const first = {
  deliveryId: 'delivery-1', driverId: 'driver-1', deliveredAtUTC: '2026-10-20T12:00:00.000Z',
  deliveredBbl: 120, measuredBeforeFeet: 10,
};

describe('fresh-water supply inventory', () => {
  it('treats an RTDB-omitted null use rate as unknown', () => {
    const { dailyUseBbl: _removed, ...storedConfig } = config;
    expect(validFreshWaterConfig(storedConfig)).toBe(true);
  });

  it('raises two equalized tanks from 10 to 13 feet with one 120 BBL load', () => {
    const result = applyFreshWaterDelivery(null, config, first);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.levelFeet).toBe(13);
    expect(projectFreshWaterFeet(result.state, config, '2026-10-21T12:00:00.000Z')).toBeNull();
  });

  it('adds deliveries and subtracts only an explicitly configured use rate', () => {
    const knownUse = { ...config, dailyUseBbl: 40 };
    const initial = applyFreshWaterDelivery(null, knownUse, first);
    if (!initial.ok) throw Error('initial delivery rejected');
    expect(projectFreshWaterFeet(initial.state, knownUse, '2026-10-21T12:00:00.000Z')).toBe(12);
  });

  it('uses aggregate BBL per foot only for verified equalized tanks', () => {
    const three = { ...config, tankCount: 3 };
    const threeResult = applyFreshWaterDelivery(null, three, first);
    if (!threeResult.ok) throw Error('three-tank delivery rejected');
    expect(threeResult.state.levelFeet).toBe(12);
    const single = { ...config, tankCount: 1, equalization: 'single-tank' as const };
    const singleResult = applyFreshWaterDelivery(null, single, first);
    if (!singleResult.ok) throw Error('single-tank delivery rejected');
    expect(singleResult.state.levelFeet).toBe(16);
    expect(applyFreshWaterDelivery(null, { ...three, equalization: 'unverified' }, first))
      .toEqual({ ok: false, reason: 'equalization_unverified' });
  });

  it('accepts an exact retry once and rejects a changed replay', () => {
    const initial = applyFreshWaterDelivery(null, config, first);
    if (!initial.ok) throw Error('initial delivery rejected');
    expect(applyFreshWaterDelivery(initial.state, config, first)).toMatchObject({ ok: true, duplicate: true });
    expect(applyFreshWaterDelivery(initial.state, config, { ...first, deliveredBbl: 100 }))
      .toEqual({ ok: false, reason: 'id_collision' });
  });

  it('replays a late-arriving offline load in event-time order', () => {
    const knownUse = { ...config, dailyUseBbl: 3 };
    const knownInitial = applyFreshWaterDelivery(null, knownUse, first);
    if (!knownInitial.ok) throw Error('known-rate initial delivery rejected');
    const later = applyFreshWaterDelivery(knownInitial.state, knownUse, {
      deliveryId: 'delivery-3', driverId: 'driver-2', deliveredAtUTC: '2026-10-22T12:00:00.000Z',
      deliveredBbl: 40,
    });
    if (!later.ok) throw Error('later delivery rejected');
    const middle = applyFreshWaterDelivery(later.state, knownUse, {
      deliveryId: 'delivery-2', driverId: 'driver-1', deliveredAtUTC: '2026-10-21T12:00:00.000Z',
      deliveredBbl: 40,
    });
    if (!middle.ok) throw Error('offline delivery rejected');
    expect(middle.state.asOfUTC).toBe('2026-10-22T12:00:00.000Z');
    expect(middle.state.levelFeet).toBe(14.85);
  });

  it('requires a fresh measurement when usage remains unknown', () => {
    const initial = applyFreshWaterDelivery(null, config, first);
    if (!initial.ok) throw Error('initial delivery rejected');
    expect(applyFreshWaterDelivery(initial.state, config, {
      deliveryId: 'delivery-2', driverId: 'driver-1', deliveredAtUTC: '2026-10-21T12:00:00.000Z',
      deliveredBbl: 40,
    })).toEqual({ ok: false, reason: 'usage_rate_unknown' });
  });

  it('requires an initial reading and refuses overflow or out-of-order loads', () => {
    expect(applyFreshWaterDelivery(null, config, { ...first, measuredBeforeFeet: undefined }))
      .toEqual({ ok: false, reason: 'initial_level_required' });
    expect(applyFreshWaterDelivery(null, config, { ...first, deliveredBbl: 500, measuredBeforeFeet: 19 }))
      .toEqual({ ok: false, reason: 'tank_overflow' });
    const initial = applyFreshWaterDelivery(null, config, first);
    if (!initial.ok) throw Error('initial delivery rejected');
    expect(applyFreshWaterDelivery(initial.state, config, { ...first, deliveryId: 'earlier', deliveredAtUTC: '2026-10-19T12:00:00.000Z' }))
      .toEqual({ ok: false, reason: 'stale_delivery' });
  });
});
