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
};

export type FreshWaterState = {
  seedLevelFeet: number;
  seedAtUTC: string;
  seedDailyUseBbl?: number | null;
  levelFeet: number;
  asOfUTC: string;
  dailyUseBbl?: number | null;
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
    && (config.equalization === 'single-tank' || config.equalization === 'verified-equalized'
      || config.equalization === 'unverified')
    && (config.tankCount === 1 ? config.equalization === 'single-tank' : config.equalization !== 'single-tank')
    && (config.dailyUseBbl == null || (typeof config.dailyUseBbl === 'number'
      && Number.isFinite(config.dailyUseBbl) && config.dailyUseBbl >= 0));
}

export function projectFreshWaterFeet(state: Pick<FreshWaterState, 'levelFeet' | 'asOfUTC' | 'dailyUseBbl'>,
  config: FreshWaterConfig, atUTC: string): number | null {
  const elapsed = Date.parse(atUTC) - Date.parse(state.asOfUTC);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const dailyUseBbl = state.dailyUseBbl ?? null;
  if (elapsed > 0 && dailyUseBbl === null) return null;
  const bblPerFoot = config.tankCount * config.bblPerFootPerTank;
  return round(Math.max(0, state.levelFeet - (dailyUseBbl || 0) * elapsed / dayMs / bblPerFoot));
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
  const seedDailyUseBbl = current?.seedDailyUseBbl ?? config.dailyUseBbl ?? null;
  if (atMs < Date.parse(seedAtUTC)) return { ok: false, reason: 'stale_delivery' };
  const deliveries = { ...(current?.deliveries || {}), [delivery.deliveryId]: delivery };
  const ordered = Object.values(deliveries).sort((a, b) =>
    Date.parse(a.deliveredAtUTC) - Date.parse(b.deliveredAtUTC) || a.deliveryId.localeCompare(b.deliveryId));
  let levelFeet = seedLevelFeet;
  let asOfUTC = seedAtUTC;
  const rate = seedDailyUseBbl;
  let lastMeasuredFeet: number | undefined = seedLevelFeet;
  let lastMeasuredAtUTC: string | undefined = seedAtUTC;
  let deliveredSinceMeasurementBbl = 0;
  for (const event of ordered) {
    if (Date.parse(event.deliveredAtUTC) < Date.parse(asOfUTC)) return { ok: false, reason: 'stale_delivery' };
    const projected = projectFreshWaterFeet({ levelFeet, asOfUTC, dailyUseBbl: rate }, config, event.deliveredAtUTC);
    if (projected === null && event.measuredBeforeFeet === undefined) {
      return { ok: false, reason: rate === null ? 'usage_rate_unknown' : 'stale_delivery' };
    }
    const before = event.measuredBeforeFeet ?? projected!;
    const after = before + event.deliveredBbl / bblPerFoot;
    if (after > config.tankHeightFeet + 0.000001) return { ok: false, reason: 'tank_overflow' };
    if (event.measuredBeforeFeet !== undefined) {
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
