import { resultingLevel, projectedLevel, inferredDailyBbl } from '@tester3x/water-hauling';
/** Fresh-water supply is a separate inventory from produced-water pull levels.
 * Each accepted delivery is one load. A shared gauge is used only after
 * multi-tank equalization has been explicitly verified.
 */
export type FreshWaterConfig = {
  enabled: true;
  tankCount: number;
  tankHeightFeet: number;
  bblPerFootPerTank: number;
  equalization: 'single-tank' | 'verified-equalized' | 'unverified';
  dailyUseBbl?: number | null;
};

export function supportsSharedFreshWaterLevel(config: FreshWaterConfig): boolean {
  return config.tankCount === 1
    ? config.equalization === 'single-tank'
    : config.equalization === 'verified-equalized';
}

/** A well's fresh-water demand belongs to exactly one physical tank group. */
export function overlappingFreshWaterGroup(
  groups: Record<string, { wellNames?: string[] }>, targetId: string, wellNames: string[],
): string | null {
  const members = new Set(wellNames);
  for (const [id, group] of Object.entries(groups)) {
    if (id !== targetId && group?.wellNames?.some(name => members.has(name))) return id;
  }
  return null;
}

export type FreshWaterDelivery = {
  deliveryId: string;
  driverId: string;
  deliveredAtUTC: string;
  deliveredBbl: number;
  measuredBeforeFeet?: number;
  ticketId?: string;
  /** Only an explicitly touched shared Well Down checkbox changes operating state. */
  wellDown?: boolean;
};

export type FreshWaterState = {
  seedLevelFeet: number;
  seedAtUTC: string;
  seedDailyUseBbl?: number | null;
  seedProvenance?: { levelSource: string; timeSource: string; rateSource: string };
  isDown?: boolean;
  rateSamples?: number[];
  levelFeet: number;
  asOfUTC: string;
  dailyUseBbl?: number | null;
  lastMeasuredFeet?: number;
  lastMeasuredAtUTC?: string;
  deliveredSinceMeasurementBbl: number;
  deliveries: Record<string, FreshWaterDelivery>;
};

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

export function validFreshWaterConfig(value: unknown): value is FreshWaterConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return config.enabled === true
    && Number.isInteger(config.tankCount) && Number(config.tankCount) >= 1 && Number(config.tankCount) <= 3
    && typeof config.tankHeightFeet === 'number' && Number.isFinite(config.tankHeightFeet) && config.tankHeightFeet > 0
    && typeof config.bblPerFootPerTank === 'number' && Number.isFinite(config.bblPerFootPerTank) && config.bblPerFootPerTank > 0
    && (config.equalization === 'single-tank' || config.equalization === 'verified-equalized'
      || config.equalization === 'unverified')
    && (config.tankCount === 1 ? config.equalization === 'single-tank' : config.equalization !== 'single-tank')
    && (config.dailyUseBbl == null || (typeof config.dailyUseBbl === 'number'
      && Number.isFinite(config.dailyUseBbl) && config.dailyUseBbl >= 0));
}

export function projectFreshWaterFeet(state: Pick<FreshWaterState, 'levelFeet' | 'asOfUTC' | 'dailyUseBbl' | 'isDown'>,
  config: FreshWaterConfig, atUTC: string): number | null {
  return projectedLevel('freshwater', state.levelFeet, state.asOfUTC, atUTC,
    state.isDown ? 0 : state.dailyUseBbl, config.tankCount * config.bblPerFootPerTank, config.tankHeightFeet);
}

export type FreshWaterDecision =
  | { ok: true; duplicate: boolean; state: FreshWaterState }
  | { ok: false; reason: 'invalid_config' | 'invalid_delivery' | 'id_collision' | 'initial_level_required'
    | 'stale_delivery' | 'tank_overflow' | 'equalization_unverified' | 'usage_rate_unknown' };

export function applyFreshWaterDelivery(current: FreshWaterState | null, config: FreshWaterConfig,
  delivery: FreshWaterDelivery): FreshWaterDecision {
  if (!validFreshWaterConfig(config)) return { ok: false, reason: 'invalid_config' };
  if (!supportsSharedFreshWaterLevel(config)) return { ok: false, reason: 'equalization_unverified' };
  const atMs = Date.parse(delivery.deliveredAtUTC);
  if (!delivery.deliveryId || !delivery.driverId || !Number.isFinite(atMs)
    || !Number.isFinite(delivery.deliveredBbl) || delivery.deliveredBbl < 0
    || (delivery.deliveredBbl === 0 && delivery.measuredBeforeFeet === undefined && delivery.wellDown === undefined)
    || (delivery.wellDown !== undefined && typeof delivery.wellDown !== 'boolean')
    || (delivery.measuredBeforeFeet !== undefined && (!Number.isFinite(delivery.measuredBeforeFeet)
      || delivery.measuredBeforeFeet < 0 || delivery.measuredBeforeFeet > config.tankHeightFeet))) {
    return { ok: false, reason: 'invalid_delivery' };
  }
  const existing = current?.deliveries?.[delivery.deliveryId];
  if (existing) {
    return existing.driverId === delivery.driverId
      && existing.deliveredAtUTC === delivery.deliveredAtUTC
      && existing.deliveredBbl === delivery.deliveredBbl
      && existing.measuredBeforeFeet === delivery.measuredBeforeFeet
      && existing.wellDown === delivery.wellDown
      ? { ok: true, duplicate: true, state: current! }
      : { ok: false, reason: 'id_collision' };
  }
  if (!current && delivery.measuredBeforeFeet === undefined) return { ok: false, reason: 'initial_level_required' };
  const bblPerFoot = config.tankCount * config.bblPerFootPerTank;
  const seedAtUTC = current?.seedAtUTC ?? delivery.deliveredAtUTC;
  const seedLevelFeet = current?.seedLevelFeet ?? delivery.measuredBeforeFeet!;
  const seedDailyUseBbl = current?.seedDailyUseBbl ?? config.dailyUseBbl ?? null;
  if (atMs < Date.parse(seedAtUTC)) return { ok: false, reason: 'stale_delivery' };
  const deliveries = { ...(current?.deliveries || {}), [delivery.deliveryId]: delivery };
  const ordered = Object.values(deliveries).sort((a, b) =>
    Date.parse(a.deliveredAtUTC) - Date.parse(b.deliveredAtUTC) || a.deliveryId.localeCompare(b.deliveryId));
  let levelFeet = seedLevelFeet;
  let asOfUTC = seedAtUTC;
  let rate = seedDailyUseBbl;
  let lastMeasuredFeet: number | undefined = seedLevelFeet;
  let lastMeasuredAtUTC: string | undefined = seedAtUTC;
  let deliveredSinceMeasurementBbl = 0;
  let isDown = false;
  let activeMsSinceMeasurement = 0;
  let samples: number[] = [];
  for (const event of ordered) {
    if (Date.parse(event.deliveredAtUTC) < Date.parse(asOfUTC)) return { ok: false, reason: 'stale_delivery' };
    activeMsSinceMeasurement += isDown ? 0 : Date.parse(event.deliveredAtUTC) - Date.parse(asOfUTC);
    const projected = projectFreshWaterFeet({ levelFeet, asOfUTC, dailyUseBbl: rate, isDown }, config, event.deliveredAtUTC);
    if (projected === null && event.measuredBeforeFeet === undefined) {
      return { ok: false, reason: rate === null ? 'usage_rate_unknown' : 'stale_delivery' };
    }
    const before = event.measuredBeforeFeet ?? projected!;
    const after = event.deliveredBbl === 0 ? before : resultingLevel('freshwater', before, event.deliveredBbl, bblPerFoot, config.tankHeightFeet);
    if (after === null) return { ok: false, reason: 'tank_overflow' };
    if (event.measuredBeforeFeet !== undefined) {
      if (lastMeasuredFeet !== undefined && lastMeasuredAtUTC) {
        const inferred = inferredDailyBbl('freshwater', lastMeasuredFeet, lastMeasuredAtUTC, before,
          new Date(Date.parse(lastMeasuredAtUTC) + activeMsSinceMeasurement).toISOString(), deliveredSinceMeasurementBbl, bblPerFoot);
        if (inferred !== null && inferred > 0) {
          // Existing AFR convention: average the last five minutes-per-foot samples.
          samples = [...samples, 1440 * bblPerFoot / inferred].slice(-5);
          rate = 1440 * bblPerFoot / (samples.reduce((a,b)=>a+b,0) / samples.length);
        } else if (inferred === 0) rate = 0;
      }
      lastMeasuredFeet = before;
      lastMeasuredAtUTC = event.deliveredAtUTC;
      deliveredSinceMeasurementBbl = 0;
      activeMsSinceMeasurement = 0;
    }
    deliveredSinceMeasurementBbl += event.deliveredBbl;
    levelFeet = round(after);
    asOfUTC = event.deliveredAtUTC;
    if (event.wellDown !== undefined) isDown = event.wellDown;
  }
  return {
    ok: true,
    duplicate: false,
    state: {
      seedLevelFeet, seedAtUTC, seedDailyUseBbl,
      ...(current?.seedProvenance ? { seedProvenance: current.seedProvenance } : {}),
      isDown, rateSamples: samples,
      levelFeet,
      asOfUTC,
      dailyUseBbl: rate,
      lastMeasuredFeet, lastMeasuredAtUTC, deliveredSinceMeasurementBbl,
      deliveries,
    },
  };
}

/** Reconstruct a late observation's selected instant, excluding later deliveries. */
export function freshWaterAt(current: FreshWaterState, config: FreshWaterConfig, atUTC: string) {
  if (!Number.isFinite(Date.parse(atUTC)) || Date.parse(atUTC) < Date.parse(current.seedAtUTC)) return null;
  let state: FreshWaterState = { ...current, levelFeet: current.seedLevelFeet, asOfUTC: current.seedAtUTC,
    dailyUseBbl: current.seedDailyUseBbl ?? null, isDown: false, deliveries: {} };
  for (const event of Object.values(current.deliveries || {}).filter(e=>Date.parse(e.deliveredAtUTC)<=Date.parse(atUTC))
    .sort((a,b)=>Date.parse(a.deliveredAtUTC)-Date.parse(b.deliveredAtUTC)||a.deliveryId.localeCompare(b.deliveryId))) {
    const decision=applyFreshWaterDelivery(state,config,event);
    if (!decision.ok) return null;
    state=decision.state;
  }
  return { ...state, projectedFeet: projectFreshWaterFeet(state,config,atUTC) };
}

/** Explicit initial observation only; never replaces an existing ledger or reading. */
export function seedFreshWaterBaseline(current: FreshWaterState | null, config: FreshWaterConfig,
  baseline: { levelFeet: number; atUTC: string; dailyUseBbl: number; provenance: NonNullable<FreshWaterState['seedProvenance']> }): FreshWaterState {
  if (current) throw new Error('inventory_already_initialized');
  if (!validFreshWaterConfig(config) || !supportsSharedFreshWaterLevel(config)
    || !Number.isFinite(baseline.levelFeet) || baseline.levelFeet < 0 || baseline.levelFeet > config.tankHeightFeet
    || !Number.isFinite(Date.parse(baseline.atUTC)) || !Number.isFinite(baseline.dailyUseBbl) || baseline.dailyUseBbl < 0) throw new Error('invalid_baseline');
  return { seedLevelFeet: baseline.levelFeet,seedAtUTC: baseline.atUTC,seedDailyUseBbl:baseline.dailyUseBbl,
    seedProvenance:baseline.provenance,levelFeet:baseline.levelFeet,asOfUTC:baseline.atUTC,dailyUseBbl:baseline.dailyUseBbl,
    isDown:false,lastMeasuredFeet:baseline.levelFeet,lastMeasuredAtUTC:baseline.atUTC,deliveredSinceMeasurementBbl:0,deliveries:{} };
}
