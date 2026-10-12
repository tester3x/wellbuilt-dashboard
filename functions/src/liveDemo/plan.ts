/** Deterministic, synthetic loads for the public live demo. */
export const DEMO_COMPANY_ID = 'wellbuilt-demo';
export const DEMO_COMPANY_NAME = 'WellBuilt Demo Hauling';
export const DEMO_MAX_SCENARIOS_PER_DAY = 24;

export type DemoScenarioKind = 'single' | 'multi_haul' | 'split_ticket';
export type DemoStage = 'pending' | 'accepted' | 'at_pickup' | 'departed' | 'at_dropoff' | 'closed';

export interface DemoStop {
  name: string;
  bbls: number;
}

export interface DemoLoad {
  id: string;
  pickup: string;
  bbls: number;
  stops: DemoStop[];
  /** A new physical pickup always has a new ticket family. */
  familyId: string;
  haulGroupId?: string;
}

export interface DemoScenario {
  id: string;
  sequence: number;
  kind: DemoScenarioKind;
  driverId: string;
  driverName: string;
  loads: DemoLoad[];
}

const drivers = [
  { id: 'demo-driver-claude', name: 'Claude Demo Driver' },
  { id: 'demo-driver-grok', name: 'Grok Demo Driver' },
] as const;

export function demoScenarioKind(sequence: number): DemoScenarioKind {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('invalid_demo_sequence');
  if (sequence % 7 === 0) return 'split_ticket';
  if (sequence % 5 === 0) return 'multi_haul';
  return 'single';
}

export function buildDemoScenario(sequence: number): DemoScenario {
  const kind = demoScenarioKind(sequence);
  const driver = drivers[(sequence - 1) % drivers.length];
  const id = `demo-${String(sequence).padStart(6, '0')}`;
  const load = (suffix: string, pickup: string, bbls: number, stops: DemoStop[]): DemoLoad => ({
    id: `${id}-${suffix}`,
    pickup,
    bbls,
    stops,
    familyId: `${id}-${suffix}-family`,
  });
  let loads: DemoLoad[];
  if (kind === 'multi_haul') {
    const haulGroupId = `${id}-haul`;
    loads = [
      { ...load('a', 'Demo Well 1', 90, [{ name: 'Demo SWD 1', bbls: 90 }]), haulGroupId },
      { ...load('b', 'Demo Well 2', 55, [{ name: 'Demo SWD 1', bbls: 55 }]), haulGroupId },
    ];
  } else if (kind === 'split_ticket') {
    loads = [load('a', 'Demo Well 1', 140, [
      { name: 'Demo Pad 1', bbls: 60 },
      { name: 'Demo SWD 1', bbls: 80 },
    ])];
  } else {
    loads = [load('a', 'Demo Well 1', 140, [{ name: 'Demo SWD 1', bbls: 140 }])];
  }
  const scenario = { id, sequence, kind, driverId: driver.id, driverName: driver.name, loads };
  assertDemoScenario(scenario);
  return scenario;
}

export function assertDemoScenario(scenario: DemoScenario): void {
  if (!/^demo-\d{6}$/.test(scenario.id)) throw new Error('invalid_demo_id');
  if (!drivers.some(driver => driver.id === scenario.driverId && driver.name === scenario.driverName)) {
    throw new Error('invalid_demo_driver');
  }
  if (!scenario.loads.length || scenario.loads.length > 2) throw new Error('invalid_demo_load_count');
  const families = new Set<string>();
  for (const load of scenario.loads) {
    if (!load.id.startsWith(`${scenario.id}-`)) throw new Error('cross_scenario_load');
    if (families.has(load.familyId)) throw new Error('reused_family_for_new_pickup');
    families.add(load.familyId);
    if (!['Demo Well 1', 'Demo Well 2'].includes(load.pickup)) throw new Error('unknown_demo_pickup');
    if (!Number.isInteger(load.bbls) || load.bbls < 1 || load.bbls > 250) throw new Error('invalid_demo_bbls');
    if (!load.stops.length || load.stops.length > 2) throw new Error('invalid_demo_stop_count');
    if (load.stops.some(stop => !['Demo SWD 1', 'Demo Pad 1'].includes(stop.name) || !Number.isInteger(stop.bbls) || stop.bbls < 1)) {
      throw new Error('invalid_demo_stop');
    }
    if (load.stops.reduce((sum, stop) => sum + stop.bbls, 0) !== load.bbls) {
      throw new Error('demo_bbls_unbalanced');
    }
  }
  if (scenario.kind === 'multi_haul' && (scenario.loads.length !== 2 || scenario.loads[0].haulGroupId !== scenario.loads[1].haulGroupId)) {
    throw new Error('invalid_demo_multi_haul');
  }
  if (scenario.kind === 'split_ticket' && (scenario.loads.length !== 1 || scenario.loads[0].stops.length !== 2)) {
    throw new Error('invalid_demo_split');
  }
}
