/** Fresh-water supply is a separate inventory from produced-water pull levels.
 * Each accepted delivery is one load. Tanks on a pad are treated as equalized.
 */
export type FreshWaterConfig = {
  enabled: true;
  tankCount: number;
  tankHeightFeet: number;
  bblPerFootPerTank: number;
  dailyUseBbl: number;
};

export type FreshWaterDelivery = {
  deliveryId: string;
  driverId: string;
  deliveredAtUTC: string;
  deliveredBbl: number;
  measuredBeforeFeet?: number;
  ticketId?: string;
};

export type FreshWaterState = {
  seedLevelFeet: number;
  seedAtUTC: string;
  seedDailyUseBbl: number;
  levelFeet: number;
  asOfUTC: string;
  dailyUseBbl: number;
  lastMeasuredFeet?: number;
  lastMeasuredAtUTC?: string;
  deliveredSinceMeasurementBbl: number;
  deliveries: Record<string, FreshWaterDelivery>;
};

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const dayMs = 86_400_000;

export function validFreshWaterConfig(value: unknown): value is FreshWaterConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return config.enabled === true
    && Number.isInteger(config.tankCount) && Number(config.tankCount) >= 1 && Number(config.tankCount) <= 3
    && typeof config.tankHeightFeet === 'number' && Number.isFinite(config.tankHeightFeet) && config.tankHeightFeet > 0
    && typeof config.bblPerFootPerTank === 'number' && Number.isFinite(config.bblPerFootPerTank) && config.bblPerFootPerTank > 0
    && typeof config.dailyUseBbl === 'number' && Number.isFinite(config.dailyUseBbl) && config.dailyUseBbl >= 0;
}

export function projectFreshWaterFeet(state: Pick<FreshWaterState, 'levelFeet' | 'asOfUTC' | 'dailyUseBbl'>,
  config: FreshWaterConfig, atUTC: string): number | null {
  const elapsed = Date.parse(atUTC) - Date.parse(state.asOfUTC);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const bblPerFoot = config.tankCount * config.bblPerFootPerTank;
  return round(Math.max(0, state.levelFeet - state.dailyUseBbl * elapsed / dayMs / bblPerFoot));
}

export type FreshWaterDecision =
  | { ok: true; duplicate: boolean; state: FreshWaterState }
  | { ok: false; reason: 'invalid_config' | 'invalid_delivery' | 'id_collision' | 'initial_level_required' | 'stale_delivery' | 'tank_overflow' };

export function applyFreshWaterDelivery(current: FreshWaterState | null, config: FreshWaterConfig,
  delivery: FreshWaterDelivery): FreshWaterDecision {
  if (!validFreshWaterConfig(config)) return { ok: false, reason: 'invalid_config' };
  const atMs = Date.parse(delivery.deliveredAtUTC);
  if (!delivery.deliveryId || !delivery.driverId || !Number.isFinite(atMs)
    || !Number.isFinite(delivery.deliveredBbl) || delivery.deliveredBbl <= 0
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
      ? { ok: true, duplicate: true, state: current! }
      : { ok: false, reason: 'id_collision' };
  }
  if (!current && delivery.measuredBeforeFeet === undefined) return { ok: false, reason: 'initial_level_required' };
  const bblPerFoot = config.tankCount * config.bblPerFootPerTank;
  const seedAtUTC = current?.seedAtUTC ?? delivery.deliveredAtUTC;
  const seedLevelFeet = current?.seedLevelFeet ?? delivery.measuredBeforeFeet!;
  const seedDailyUseBbl = current?.seedDailyUseBbl ?? config.dailyUseBbl;
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
  for (const event of ordered) {
    const projected = projectFreshWaterFeet({ levelFeet, asOfUTC, dailyUseBbl: rate }, config, event.deliveredAtUTC);
    if (projected === null) return { ok: false, reason: 'stale_delivery' };
    const before = event.measuredBeforeFeet ?? projected;
    const after = before + event.deliveredBbl / bblPerFoot;
    if (after > config.tankHeightFeet + 0.000001) return { ok: false, reason: 'tank_overflow' };
    if (event.measuredBeforeFeet !== undefined && lastMeasuredAtUTC && lastMeasuredFeet !== undefined) {
      const days = (Date.parse(event.deliveredAtUTC) - Date.parse(lastMeasuredAtUTC)) / dayMs;
      if (days >= 0.5) {
        const consumed = lastMeasuredFeet * bblPerFoot + deliveredSinceMeasurementBbl - before * bblPerFoot;
        if (consumed >= 0 && Number.isFinite(consumed)) {
          const observed = consumed / days;
          rate = round(rate === 0 ? observed : 0.7 * rate + 0.3 * observed);
        }
      }
      lastMeasuredFeet = before;
      lastMeasuredAtUTC = event.deliveredAtUTC;
      deliveredSinceMeasurementBbl = 0;
    }
    deliveredSinceMeasurementBbl += event.deliveredBbl;
    levelFeet = round(after);
    asOfUTC = event.deliveredAtUTC;
  }
  return {
    ok: true,
    duplicate: false,
    state: {
      seedLevelFeet, seedAtUTC, seedDailyUseBbl,
      levelFeet,
      asOfUTC,
      dailyUseBbl: rate,
      lastMeasuredFeet, lastMeasuredAtUTC, deliveredSinceMeasurementBbl,
      deliveries,
    },
  };
}
