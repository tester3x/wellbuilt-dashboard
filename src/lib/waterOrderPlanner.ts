import { projectWellLevel, wbmInputsFromWell } from "./wellLevelProjection.ts";
import type { WellResponse } from "./wellPoolCore";

export interface WaterTank {
  id: string;
  name: string;
  capacity: number;
  buffer: number;
  current: number;
}
export interface WaterSource {
  wellName: string;
  operator: string;
  route?: string;
  ndicName?: string;
  available: number;
  daily: number;
  capacity: number;
  cycleMinutes: number;
  asOf: string;
  reserved: number;
}
export interface WaterTruck {
  key: string;
  name: string;
  capacity: number;
  hoursPerDay: number;
}
export interface WaterTrip {
  id: string;
  wellName: string;
  driverKey: string;
  bbl: number;
  startAt: string;
  pickupAt: string;
  deliveryAt: string;
  cycleMinutes: number;
  tanks: { id: string; bbl: number }[];
}
export interface WaterPlan {
  version: 1;
  createdAt: string;
  deadline: string;
  target: number;
  existing: number;
  needed: number;
  planned: number;
  shortfall: number;
  trips: WaterTrip[];
  sources: WaterSource[];
}
const number = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : NaN;
const round = (n: number) => Math.round(n * 100) / 100;

/** Existing dispatches reserve supply once. Already-loaded water is in WB M's baseline. */
export function reservedWater(
  jobs: ReadonlyArray<{
    wellName: string;
    status: string;
    loadCount?: number;
    loadsCompleted?: number;
    bbls?: number;
    driverStage?: string;
  }>,
  wellName: string,
  defaultLoad: number,
): number {
  return jobs
    .filter(
      (j) =>
        j.wellName === wellName &&
        ["pending", "accepted", "in_progress", "paused"].includes(j.status),
    )
    .reduce((sum, j) => {
      const future = Math.max(0, (j.loadCount || 1) - (j.loadsCompleted || 0));
      const active =
        j.status !== "pending" &&
        Number(j.loadsCompleted) > 0 &&
        !["en_route_dropoff", "on_site_dropoff"].includes(j.driverStage || "")
          ? 1
          : 0;
      return (
        sum +
        (future + active) * (Number(j.bbls) > 0 ? Number(j.bbls) : defaultLoad)
      );
    }, 0);
}

/** Uses exactly the same current level as the Dispatch Well Queue; no double recovery. */
export function waterSourceFromWell(
  well: WellResponse,
  now: number,
  cycleMinutes: number,
  reserved = 0,
): WaterSource | null {
  const level = projectWellLevel(well, now),
    bank = well.bblPerFoot || (well.tanks ? 20 * well.tanks : NaN);
  const bottom = number(well.bottomLevel),
    height = well.tankHeight || 20,
    ceiling = Math.min(height, well.maxLevel || height);
  if (
    !level.available ||
    level.estFeet === null ||
    !(bank > 0) ||
    !Number.isFinite(bottom) ||
    bottom < 0 ||
    ceiling <= bottom ||
    !(cycleMinutes > 0) ||
    !Number.isFinite(cycleMinutes)
  )
    return null;
  const capacity = Math.max(0, (ceiling - bottom) * bank - reserved);
  const available =
    Math.max(0, Math.min(ceiling, level.estFeet) - bottom) * bank - reserved;
  const rawRate = Number(well.windowBblsDay || well.bbls24hrs),
    inputs = wbmInputsFromWell(well);
  const daily = level.wellDown
    ? 0
    : rawRate > 0 && Number.isFinite(rawRate)
      ? rawRate
      : inputs.flowMinutesPerFoot && inputs.flowMinutesPerFoot > 0
        ? (bank * 1440) / inputs.flowMinutesPerFoot
        : 0;
  return {
    wellName: well.wellName,
    ndicName: well.ndicName,
    operator: well.operator || "",
    route: well.route,
    available: round(Math.max(0, Math.min(capacity, available))),
    daily: round(daily),
    capacity: round(capacity),
    cycleMinutes,
    asOf: new Date(now).toISOString(),
    reserved: round(reserved),
  };
}

export function estimateCycleMinutes(
  source: { latitude?: number; longitude?: number },
  destination: { latitude?: number; longitude?: number },
  mph: number,
  handlingMinutes: number,
): number | null {
  const coords = [
    source.latitude,
    source.longitude,
    destination.latitude,
    destination.longitude,
  ];
  if (
    !coords.every((v) => typeof v === "number" && Number.isFinite(v)) ||
    !(mph > 0) ||
    handlingMinutes < 0
  )
    return null;
  if (
    Math.abs(source.latitude!) > 90 ||
    Math.abs(destination.latitude!) > 90 ||
    Math.abs(source.longitude!) > 180 ||
    Math.abs(destination.longitude!) > 180
  )
    return null;
  const rad = (v: number) => (v * Math.PI) / 180,
    a =
      Math.sin(rad(destination.latitude! - source.latitude!) / 2) ** 2 +
      Math.cos(rad(source.latitude!)) *
        Math.cos(rad(destination.latitude!)) *
        Math.sin(rad(destination.longitude! - source.longitude!) / 2) ** 2;
  const miles =
    3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return Math.max(
    handlingMinutes,
    Math.ceil(((miles * 1.25 * 2) / mph) * 60 + handlingMinutes),
  );
}

/** Greedy earliest-delivery plan. Each well has a capped inventory clock and each
 * truck its own daily work budget. Forecast production is never counted twice. */
export function planWaterOrder(input: {
  orderId: string;
  tanks: WaterTank[];
  sources: WaterSource[];
  trucks: WaterTruck[];
  now: number;
  deadline: number;
}): WaterPlan {
  const { tanks, sources, trucks, now, deadline, orderId } = input;
  if (
    !orderId ||
    !Number.isFinite(now) ||
    !Number.isFinite(deadline) ||
    deadline <= now ||
    deadline - now > 31 * 86400000
  )
    throw Error("Choose a deadline within the next 31 days");
  if (
    !tanks.length ||
    tanks.length > 120 ||
    tanks.some(
      (t) =>
        ![t.capacity, t.buffer, t.current].every(Number.isFinite) ||
        t.capacity <= 0 ||
        t.buffer < 0 ||
        t.buffer >= t.capacity ||
        t.current < 0 ||
        t.current > t.capacity,
    )
  )
    throw Error("Check tank capacity, buffer and current water");
  if (new Set(tanks.map((t) => t.id)).size !== tanks.length)
    throw Error("Tank identities must be unique");
  if (
    !trucks.length ||
    trucks.some(
      (t) =>
        !t.key ||
        !Number.isFinite(t.capacity) ||
        t.capacity <= 0 ||
        t.capacity > 1000 ||
        !Number.isFinite(t.hoursPerDay) ||
        t.hoursPerDay <= 0 ||
        t.hoursPerDay > 24,
    ) ||
    new Set(trucks.map((t) => t.key)).size !== trucks.length
  )
    throw Error("Choose trucks with valid capacities and daily hours");
  if (
    !sources.length ||
    sources.some(
      (s) =>
        ![s.available, s.daily, s.capacity, s.cycleMinutes].every(
          Number.isFinite,
        ) ||
        s.available < 0 ||
        s.daily < 0 ||
        s.capacity <= 0 ||
        s.available > s.capacity ||
        s.cycleMinutes <= 0,
    ) ||
    new Set(sources.map((s) => s.wellName)).size !== sources.length
  )
    throw Error(
      "Choose eligible wells with valid water and turnaround estimates",
    );
  const target = tanks.reduce((s, t) => s + t.capacity - t.buffer, 0),
    existing = tanks.reduce(
      (s, t) => s + Math.min(t.current, t.capacity - t.buffer),
      0,
    );
  const remaining = tanks.map((t) => ({
    id: t.id,
    bbl: Math.max(0, t.capacity - t.buffer - t.current),
  }));
  let needed = round(target - existing),
    left = needed;
  const water = sources.map((s) => ({
      source: s,
      at: now,
      volume: s.available,
    })),
    fleet = trucks.map((truck) => ({ truck, at: now }));
  const trips: WaterTrip[] = [];
  while (left > 0.001 && trips.length < 300) {
    const options: {
      driver: number;
      well: number;
      start: number;
      pickup: number;
      finish: number;
      qty: number;
      volume: number;
    }[] = [];
    for (let d = 0; d < fleet.length; d++)
      for (let w = 0; w < water.length; w++) {
        const truck = fleet[d].truck,
          stock = water[w],
          s = stock.source,
          cycle = s.cycleMinutes * 60000;
        const qty = Math.min(
          truck.capacity,
          left,
          s.capacity,
          s.daily > 0 ? Infinity : stock.volume,
        );
        if (qty <= 0.001 || cycle > truck.hoursPerDay * 3600000) continue;
        let start = Math.max(now, fleet[d].at),
          pickup = 0,
          finish = 0,
          volume = 0;
        for (let day = 0; day < 33; day++) {
          const window = Math.floor((start - now) / 86400000),
            windowStart = now + window * 86400000,
            windowEnd = windowStart + truck.hoursPerDay * 3600000;
          if (start >= windowEnd) {
            start = windowStart + 86400000;
            continue;
          }
          pickup = Math.max(start + cycle / 2, stock.at);
          volume = Math.min(
            s.capacity,
            stock.volume + ((pickup - stock.at) * s.daily) / 86400000,
          );
          if (volume + 0.001 < qty) {
            if (!s.daily) break;
            pickup += ((qty - volume) * 86400000) / s.daily;
            volume = qty;
          }
          start = Math.max(start, pickup - cycle / 2);
          finish = pickup + cycle / 2;
          if (finish <= windowEnd && finish <= deadline) {
            options.push({
              driver: d,
              well: w,
              start,
              pickup,
              finish,
              qty,
              volume,
            });
            break;
          }
          if (finish > deadline) break;
          start = windowStart + 86400000;
        }
      }
    options.sort(
      (a, b) =>
        a.finish - b.finish ||
        sources[a.well].cycleMinutes - sources[b.well].cycleMinutes ||
        a.driver - b.driver ||
        a.well - b.well,
    );
    const best = options[0];
    if (!best) break;
    let allocate = best.qty;
    const allocations: { id: string; bbl: number }[] = [];
    for (const tank of remaining) {
      const qty = Math.min(tank.bbl, allocate);
      if (qty > 0) {
        allocations.push({ id: tank.id, bbl: round(qty) });
        tank.bbl -= qty;
        allocate -= qty;
      }
      if (allocate < 0.001) break;
    }
    const s = water[best.well];
    s.volume = Math.max(0, best.volume - best.qty);
    s.at = best.pickup;
    fleet[best.driver].at = best.finish;
    trips.push({
      id: `wo_${orderId}_${trips.length + 1}`,
      wellName: s.source.wellName,
      driverKey: fleet[best.driver].truck.key,
      bbl: round(best.qty),
      startAt: new Date(best.start).toISOString(),
      pickupAt: new Date(best.pickup).toISOString(),
      deliveryAt: new Date(best.finish).toISOString(),
      cycleMinutes: s.source.cycleMinutes,
      tanks: allocations,
    });
    left = Math.max(0, left - best.qty);
  }
  return {
    version: 1,
    createdAt: new Date(now).toISOString(),
    deadline: new Date(deadline).toISOString(),
    target: round(target),
    existing: round(existing),
    needed,
    planned: round(needed - left),
    shortfall: round(left),
    trips,
    sources,
  };
}

export function readyWaterTrips(
  plan: WaterPlan,
  sent: readonly string[],
  now: number,
) {
  if (now > Date.parse(plan.deadline)) return [];
  const done = new Set(sent);
  return plan.trips.filter(
    (t) =>
      !done.has(t.id) &&
      Date.parse(t.startAt) <= now &&
      now + t.cycleMinutes * 60000 <= Date.parse(plan.deadline),
  );
}
