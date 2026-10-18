import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planWaterOrder,
  readyWaterTrips,
  reservedWater,
  waterSourceFromWell,
  estimateCycleMinutes,
} from "../waterOrderPlanner.ts";
const now = Date.parse("2026-10-18T12:00:00Z");
const tank = { id: "a", name: "Frac", capacity: 500, buffer: 40, current: 0 };
const well = {
  wellName: "Near",
  operator: "Operator",
  available: 1000,
  daily: 0,
  capacity: 1000,
  cycleMinutes: 60,
  asOf: new Date(now).toISOString(),
  reserved: 0,
};
const truck = { key: "driver", name: "Driver", capacity: 185, hoursPerDay: 10 };
const plan = (patch = {}) =>
  planWaterOrder({
    orderId: "test",
    tanks: [tank],
    sources: [well],
    trucks: [truck],
    now,
    deadline: now + 3 * 86400000,
    ...patch,
  });
test("buffers and existing water produce an exact final partial load", () => {
  const p = plan({
    tanks: [
      { ...tank, current: 100 },
      { id: "b", name: "Upright", capacity: 400, buffer: 40, current: 20 },
    ],
  });
  assert.equal(p.target, 820);
  assert.equal(p.needed, 700);
  assert.equal(p.planned, 700);
  assert.equal(p.trips.at(-1)?.bbl, 145);
  assert.equal(
    p.trips.flatMap((t) => t.tanks).reduce((s, t) => s + t.bbl, 0),
    700,
  );
});
test("earliest delivery chooses nearby supply", () => {
  const p = plan({
    sources: [{ ...well, wellName: "Far", cycleMinutes: 180 }, well],
  });
  assert.equal(p.trips[0].wellName, "Near");
});
test("two trucks cannot promise the same inventory", () => {
  const p = plan({
    sources: [{ ...well, available: 200, capacity: 200 }],
    trucks: [truck, { ...truck, key: "second" }],
  });
  assert.equal(p.planned, 200);
  assert.equal(p.shortfall, 260);
});
test("production refills once and obeys truck work windows", () => {
  const p = plan({
    sources: [{ ...well, available: 185, capacity: 185, daily: 185 }],
    trucks: [{ ...truck, hoursPerDay: 1 }],
    deadline: now + 3 * 86400000,
  });
  assert.equal(p.planned, 460);
  assert.equal(new Set(p.trips.map((t) => t.startAt.slice(0, 10))).size, 3);
  for (const t of p.trips)
    assert.ok(Date.parse(t.deliveryAt) <= Date.parse(p.deadline));
});
test("insufficient turnaround time reports a shortfall", () => {
  const p = plan({ deadline: now + 30 * 60000 });
  assert.equal(p.shortfall, 460);
  assert.equal(p.trips.length, 0);
});
test("stable identities survive retries and expired orders never dispatch", () => {
  const p = plan();
  assert.deepEqual(
    p.trips.map((t) => t.id),
    plan().trips.map((t) => t.id),
  );
  assert.equal(readyWaterTrips(p, [p.trips[0].id], now).length, 0);
  assert.equal(readyWaterTrips(p, [], Date.parse(p.deadline) + 1).length, 0);
});
test("accepted stack reserves current plus remaining; loaded current is excluded", () => {
  assert.equal(
    reservedWater(
      [
        {
          wellName: "Near",
          status: "accepted",
          loadCount: 3,
          loadsCompleted: 1,
          bbls: 185,
        },
      ],
      "Near",
      140,
    ),
    555,
  );
  assert.equal(
    reservedWater(
      [
        {
          wellName: "Near",
          status: "accepted",
          driverStage: "on_site_dropoff",
          loadCount: 3,
          loadsCompleted: 1,
          bbls: 185,
        },
      ],
      "Near",
      140,
    ),
    370,
  );
  assert.equal(
    reservedWater(
      [{ wellName: "Near", status: "cancelled", bbls: 185 }],
      "Near",
      140,
    ),
    0,
  );
});
test("unknown well geometry is excluded; down wells do not forecast production", () => {
  const w = {
    wellName: "Near",
    currentLevel: "10",
    flowRate: "1:00:00",
    timestamp: "",
    etaToMax: "",
    lastPullBottomLevel: "10",
    lastPullDateTimeUTC: new Date(now).toISOString(),
    bottomLevel: 3,
    bblPerFoot: 20,
    maxLevel: 18,
    wellDown: true,
  };
  const s = waterSourceFromWell(w, now, 60)!;
  assert.equal(s.available, 140);
  assert.equal(s.daily, 0);
  assert.equal(
    waterSourceFromWell({ ...w, bottomLevel: undefined }, now, 60),
    null,
  );
});
test("bad inputs fail before a plan is created", () => {
  assert.throws(() => plan({ tanks: [{ ...tank, buffer: 600 }] }));
  assert.throws(() => plan({ trucks: [truck, truck] }));
  assert.throws(() => plan({ sources: [{ ...well, available: NaN }] }));
  assert.equal(
    estimateCycleMinutes(
      { latitude: 200, longitude: 0 },
      { latitude: 0, longitude: 0 },
      50,
      40,
    ),
    null,
  );
});
