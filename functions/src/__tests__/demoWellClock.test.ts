import {
  demoProjectedInches,
  demoPullPlan,
  demoReadyAtMs,
  demoTriggerInches,
  demoWellClock,
} from '../liveDemo/wellClock';

const config = {
  companyId: 'wellbuilt-demo', isDemo: true,
  demoRealMinutesPerFoot: 60, demoClockMultiplier: 12,
  demoTriggerMinInches: 117, demoTriggerMaxInches: 133,
  bottomLevel: 3, tanks: 1, bblPerFoot: 20, demoPullCapBbls: 140, tankHeight: 20,
};

describe('demo well recovery and safe pull volume', () => {
  const clock = demoWellClock(config)!;

  test('a 9-foot top can supply 120 BBL and no more above a 3-foot bottom', () => {
    expect(demoPullPlan(clock, 108, 108)).toEqual({
      ready: true, topInches: 108, bbls: 120, bottomInches: 36,
    });
    const varyingTop = demoPullPlan(clock, 117, 117);
    expect(varyingTop.bbls).toBe(135);
    expect(varyingTop.bottomInches).toBe(36);
    expect(demoPullPlan(clock, 133, 133).bbls).toBe(140);
  });

  test('a real 60-minute-per-foot rate recovers six feet in 30 demo minutes at 12x', () => {
    const start = Date.parse('2026-10-14T00:00:00.000Z');
    const ready = demoReadyAtMs(clock, 36, start, 108);
    expect(ready - start).toBe(30 * 60_000);
    expect(demoProjectedInches(clock, 36, start, ready, 108)).toBe(108);
    expect(demoProjectedInches(clock, 36, start, ready + 24 * 3600_000, 108)).toBe(108);
  });

  test('the next trigger is stable for a packet and stays inside the configured range', () => {
    const a = demoTriggerInches(clock, 'ticket-20813');
    expect(a).toBe(demoTriggerInches(clock, 'ticket-20813'));
    expect(a).toBeGreaterThanOrEqual(117);
    expect(a).toBeLessThanOrEqual(133);
    expect(demoTriggerInches(clock, 'ticket-20814')).not.toBe(a);
  });

  test('simulation is unavailable to a real tenant or an unconfigured demo well', () => {
    expect(demoWellClock({ ...config, companyId: 'liquid-gold' })).toBeNull();
    expect(demoWellClock({ ...config, demoClockMultiplier: undefined })).toBeNull();
  });
});
