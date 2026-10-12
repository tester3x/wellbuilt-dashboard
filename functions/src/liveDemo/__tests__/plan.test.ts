import { assertDemoScenario, buildDemoScenario, demoScenarioKind } from '../plan';

describe('live demo physical loads', () => {
  it('uses one ticket family per pickup, even for a multi-haul', () => {
    const scenario = buildDemoScenario(5);
    expect(scenario.kind).toBe('multi_haul');
    expect(scenario.loads).toHaveLength(2);
    expect(scenario.loads[0].haulGroupId).toBe(scenario.loads[1].haulGroupId);
    expect(scenario.loads[0].familyId).not.toBe(scenario.loads[1].familyId);
    expect(scenario.loads.map(load => load.bbls)).toEqual([102, 63]);
  });

  it('balances one physical load across two split destinations', () => {
    const scenario = buildDemoScenario(7);
    expect(scenario.kind).toBe('split_ticket');
    expect(scenario.loads[0].stops.map(stop => stop.bbls)).toEqual([72, 86]);
    expect(scenario.loads[0].bbls).toBe(158);
  });

  it('cycles occasional multi-haul and split plans with a stable priority', () => {
    expect(demoScenarioKind(1)).toBe('single');
    expect(demoScenarioKind(5)).toBe('multi_haul');
    expect(demoScenarioKind(7)).toBe('split_ticket');
    expect(demoScenarioKind(35)).toBe('split_ticket');
    expect(buildDemoScenario(5)).toEqual(buildDemoScenario(5));
  });

  it('keeps generating fresh 24-run sets and rotates three drivers', () => {
    const first = Array.from({ length: 24 }, (_, i) => buildDemoScenario(i + 1));
    const second = Array.from({ length: 24 }, (_, i) => buildDemoScenario(i + 25));
    const signature = (scenario: ReturnType<typeof buildDemoScenario>) =>
      scenario.loads.map(load => `${load.pickup}:${load.bbls}:${load.stops.map(stop => `${stop.name}:${stop.bbls}`).join(',')}`).join('|');
    expect(new Set(first.map(signature)).size).toBe(24);
    expect(new Set(second.map(signature)).size).toBe(24);
    expect(second.map(signature).filter(value => new Set(first.map(signature)).has(value))).toHaveLength(0);
    for (let i = 0; i < 24; i += 1) expect(signature(second[i])).not.toBe(signature(first[i]));
    expect(new Set(first.map(scenario => scenario.driverId)).size).toBe(3);
  });

  it('rejects an unbalanced or reused-family plan before any write', () => {
    const scenario = buildDemoScenario(5);
    scenario.loads[1].familyId = scenario.loads[0].familyId;
    expect(() => assertDemoScenario(scenario)).toThrow('reused_family_for_new_pickup');
    scenario.loads[1].familyId = 'unique';
    scenario.loads[1].stops[0].bbls = 54;
    expect(() => assertDemoScenario(scenario)).toThrow('demo_bbls_unbalanced');
  });
});

