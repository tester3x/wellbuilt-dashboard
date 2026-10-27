import { applyFreshWaterDelivery, projectFreshWaterFeet, type FreshWaterConfig } from '../freshWaterSupplyCore';

const config: FreshWaterConfig = {
  enabled: true, tankCount: 2, tankHeightFeet: 20, bblPerFootPerTank: 20, dailyUseBbl: 3,
};
const first = {
  deliveryId: 'delivery-1', driverId: 'driver-1', deliveredAtUTC: '2026-10-20T12:00:00.000Z',
  deliveredBbl: 120, measuredBeforeFeet: 10,
};

describe('fresh-water supply inventory', () => {
  it('raises two equalized tanks from 10 to 13 feet with one 120 BBL load', () => {
    const result = applyFreshWaterDelivery(null, config, first);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.levelFeet).toBe(13);
    expect(projectFreshWaterFeet(result.state, config, '2026-10-21T12:00:00.000Z')).toBe(12.925);
  });

  it('learns a slower pad-specific draw from successive measured levels', () => {
    const initial = applyFreshWaterDelivery(null, { ...config, dailyUseBbl: 20 }, first);
    if (!initial.ok) throw Error('initial delivery rejected');
    const next = applyFreshWaterDelivery(initial.state, config, {
      deliveryId: 'delivery-2', driverId: 'driver-1', deliveredAtUTC: '2026-10-22T12:00:00.000Z',
      deliveredBbl: 40, measuredBeforeFeet: 12.85,
    });
    if (!next.ok) throw Error('next delivery rejected');
    // 13' minus 12.85' across 40 BBL/ft = 6 BBL in two days, or 3 BBL/day.
    expect(next.state.dailyUseBbl).toBe(14.9);
    expect(next.state.levelFeet).toBe(13.85);
  });

  it('accepts an exact retry once and rejects a changed replay', () => {
    const initial = applyFreshWaterDelivery(null, config, first);
    if (!initial.ok) throw Error('initial delivery rejected');
    expect(applyFreshWaterDelivery(initial.state, config, first)).toMatchObject({ ok: true, duplicate: true });
    expect(applyFreshWaterDelivery(initial.state, config, { ...first, deliveredBbl: 100 }))
      .toEqual({ ok: false, reason: 'id_collision' });
  });

  it('replays a late-arriving offline load in event-time order', () => {
    const initial = applyFreshWaterDelivery(null, config, first);
    if (!initial.ok) throw Error('initial delivery rejected');
    const later = applyFreshWaterDelivery(initial.state, config, {
      deliveryId: 'delivery-3', driverId: 'driver-2', deliveredAtUTC: '2026-10-22T12:00:00.000Z',
      deliveredBbl: 40,
    });
    if (!later.ok) throw Error('later delivery rejected');
    const middle = applyFreshWaterDelivery(later.state, config, {
      deliveryId: 'delivery-2', driverId: 'driver-1', deliveredAtUTC: '2026-10-21T12:00:00.000Z',
      deliveredBbl: 40,
    });
    if (!middle.ok) throw Error('offline delivery rejected');
    expect(middle.state.asOfUTC).toBe('2026-10-22T12:00:00.000Z');
    expect(middle.state.levelFeet).toBe(14.85);
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
