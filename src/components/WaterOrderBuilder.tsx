"use client";
import React, { useEffect, useRef, useState } from "react";
import {
  collection,
  doc,
  onSnapshot,
  query,
  runTransaction,
  where,
} from "firebase/firestore";
import { getFirestoreDb } from "@/lib/firebase";
import { loadWellsForOperator } from "@/lib/firestoreWells";
import { assignmentIdentityForDriver } from "@/lib/dispatchWriterIdentity";
import type { DriverIdentity } from "@/lib/dispatchDriverIdentity";
import type { WellResponse } from "@/lib/wellPoolCore";
import {
  estimateCycleMinutes,
  planWaterOrder,
  readyWaterTrips,
  reservedWater,
  waterSourceFromWell,
  type WaterPlan,
  type WaterTank,
  type WaterTruck,
} from "@/lib/waterOrderPlanner";

type Job = {
  id?: string;
  wellName: string;
  status: string;
  driverStage?: string;
  loadCount?: number;
  loadsCompleted?: number;
  bbls?: number;
};
type Draft = {
  name: string;
  destination: string;
  latitude: string;
  longitude: string;
  deadline: string;
  notes: string;
  tanks: WaterTank[];
  truckKeys: string[];
  capacity: number;
  hours: number;
  fallback: number;
  mph: number;
  handling: number;
  excluded: string[];
  cycles: Record<string, string>;
};
type Saved = {
  id: string;
  companyId: string;
  draft: Draft;
  plan: WaterPlan;
  records: Record<string, Record<string, unknown>>;
  sent: string[];
};
const localTime = (at: number) =>
  new Date(at - new Date(at).getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
const blank = (): Draft => ({
  name: "",
  destination: "",
  latitude: "",
  longitude: "",
  deadline: localTime(Date.now() + 3 * 86400000),
  notes: "",
  tanks: [
    {
      id: "upright-1",
      name: "Upright 1",
      capacity: 400,
      buffer: 40,
      current: 0,
    },
    {
      id: "upright-2",
      name: "Upright 2",
      capacity: 400,
      buffer: 40,
      current: 0,
    },
  ],
  truckKeys: [],
  capacity: 185,
  hours: 10,
  fallback: 180,
  mph: 50,
  handling: 40,
  excluded: [],
  cycles: {},
});
const display = (at: string) =>
  new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
        )
      : value,
  );
const id = () => "water_" + crypto.randomUUID();
const field =
  "w-full rounded border border-gray-600 bg-gray-900 px-2 py-1.5 text-sm text-white";

export function WaterOrderBuilder({
  companyId,
  userId,
  wells,
  drivers,
  jobs,
  ready,
  canWrite,
  createDispatch,
}: {
  companyId?: string;
  userId: string;
  wells: WellResponse[];
  drivers: DriverIdentity[];
  jobs: Job[];
  ready: boolean;
  canWrite: boolean;
  createDispatch: (
    record: Record<string, unknown>,
    options: { actionId: string; actionScope: string; unitId: string },
  ) => Promise<{ dispatchId: string }>;
}) {
  const [draft, setDraft] = useState<Draft>(blank),
    [orderId, setOrderId] = useState(id),
    [plan, setPlan] = useState<WaterPlan | null>(null),
    [saved, setSaved] = useState<Saved | null>(null),
    [orders, setOrders] = useState<Saved[]>([]);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [now, setNow] = useState(Date.now()),
    [closed, setClosed] = useState<Record<string, number>>({}),
    [linked, setLinked] = useState<Record<string, string>>({}),
    [orderJobsReady, setOrderJobsReady] = useState(false);
  const alive = useRef(true),
    running = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!companyId) return;
    return onSnapshot(
      query(
        collection(getFirestoreDb(), "projects"),
        where("companyId", "==", companyId),
      ),
      (snap) => {
        const result = snap.docs
          .map((d) => ({ ...d.data().waterOrder, id: d.id }) as Saved)
          .filter((o) => o.plan?.version === 1 && o.companyId === companyId);
        setOrders(result);
        setSaved((current) =>
          current
            ? result.find((o) => o.id === current.id) || current
            : current,
        );
      },
      () =>
        setMessage(
          "Could not load saved water orders. Try again before dispatching.",
        ),
    );
  }, [companyId]);
  useEffect(() => {
    setClosed({});
    setLinked({});
    setOrderJobsReady(false);
    if (!saved || !companyId) return;
    const db = getFirestoreDb(),
      filters = [
        where("companyId", "==", companyId),
        where("projectId", "==", saved.id),
      ];
    const a = onSnapshot(
      query(collection(db, "invoices"), ...filters),
      (snapshot) => {
        const totals: Record<string, number> = {};
        snapshot.docs.forEach((d) => {
          const i = d.data();
          if (
            i.status === "closed" &&
            i.dispatchId &&
            Number.isFinite(Number(i.totalBBL))
          )
            totals[i.dispatchId] = Math.max(
              totals[i.dispatchId] || 0,
              Number(i.totalBBL),
            );
        });
        setClosed(totals);
      },
      () =>
        setMessage(
          "Delivery totals unavailable; verify order progress before dispatch.",
        ),
    );
    const b = onSnapshot(
      query(collection(db, "dispatches"), ...filters),
      (snapshot) => {
        setLinked(
          Object.fromEntries(snapshot.docs.map((d) => [d.id, d.data().status])),
        );
        setOrderJobsReady(true);
      },
      () => {
        setOrderJobsReady(false);
        setMessage("Order job status unavailable; retry before dispatch.");
      },
    );
    return () => {
      a();
      b();
    };
  }, [saved?.id, companyId]);
  const update = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setPlan(null);
  };
  const scopeWells = wells.filter((w) =>
    w.companyId ? w.companyId === companyId : companyId === "liquid-gold",
  );
  const scopeDrivers = drivers.filter((d) =>
    d.companyId ? d.companyId === companyId : companyId === "liquid-gold",
  );
  const requireScope = () => {
    if (
      !alive.current ||
      !companyId ||
      companyId === "__no_company_access__" ||
      !canWrite
    )
      throw Error("Choose a company with dispatch permission");
  };
  async function makePlan() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    try {
      requireScope();
      if (!ready)
        throw Error(
          "Wait for current wells, drivers and dispatch commitments to load",
        );
      if (!draft.name.trim() || !draft.destination.trim())
        throw Error("Enter the order name and destination");
      if (
        ![draft.fallback, draft.mph, draft.handling].every(Number.isFinite) ||
        draft.fallback <= 0 ||
        draft.mph <= 0 ||
        draft.handling < 0
      )
        throw Error("Check travel and handling times");
      const latitude = draft.latitude.trim()
          ? Number(draft.latitude)
          : undefined,
        longitude = draft.longitude.trim()
          ? Number(draft.longitude)
          : undefined;
      if (
        (latitude === undefined) !== (longitude === undefined) ||
        (latitude !== undefined &&
          (!Number.isFinite(latitude) ||
            Math.abs(latitude) > 90 ||
            !Number.isFinite(longitude) ||
            Math.abs(longitude!) > 180))
      )
        throw Error("Enter both destination coordinates, or leave both blank");
      const candidates = scopeWells.filter(
        (w) => !draft.excluded.includes(w.wellName),
      );
      const catalog = new Map<
        string,
        { latitude?: number; longitude?: number }
      >();
      if (latitude !== undefined) {
        for (const operator of [
          ...new Set(candidates.map((w) => w.operator).filter(Boolean)),
        ]) {
          try {
            for (const well of await loadWellsForOperator(operator!))
              catalog.set(well.well_name.toLowerCase(), well);
          } catch {
            /* Fallback time is explicitly editable. */
          }
        }
      }
      requireScope();
      const at = Date.now(),
        sources = candidates
          .map((w) => {
            const geo = catalog.get((w.ndicName || w.wellName).toLowerCase()),
              manual = draft.cycles[w.wellName]?.trim();
            const cycle = manual
              ? Number(manual)
              : geo && latitude !== undefined
                ? (estimateCycleMinutes(
                    geo,
                    { latitude, longitude },
                    draft.mph,
                    draft.handling,
                  ) ?? draft.fallback)
                : draft.fallback;
            return waterSourceFromWell(
              w,
              at,
              cycle,
              reservedWater(jobs, w.wellName, w.pullBbls || draft.capacity),
            );
          })
          .filter(
            (s): s is NonNullable<typeof s> =>
              !!s &&
              !!s.operator &&
              s.capacity > 0 &&
              (s.available > 0 || s.daily > 0),
          );
      const trucks: WaterTruck[] = draft.truckKeys.map((key) => {
        const d = scopeDrivers.find((d) => d.key === key);
        if (!d) throw Error("A selected driver is no longer available");
        return {
          key,
          name: d.legalName || d.displayName || "Driver",
          capacity: draft.capacity,
          hoursPerDay: draft.hours,
        };
      });
      const result = planWaterOrder({
        orderId,
        tanks: draft.tanks,
        sources,
        trucks,
        now: at,
        deadline: Date.parse(draft.deadline),
      });
      if (alive.current) {
        setPlan(result);
        setNow(at);
        setMessage(
          `${result.trips.length} loads planned${result.shortfall ? `; ${result.shortfall} BBL short of the target` : ""}.`,
        );
      }
    } catch (e) {
      if (alive.current)
        setMessage(e instanceof Error ? e.message : "Could not plan supply");
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function persist(): Promise<Saved> {
    requireScope();
    if (saved) return saved;
    if (!plan) throw Error("Plan Supply first");
    const records: Saved["records"] = {};
    for (const trip of plan.trips) {
      const driver = scopeDrivers.find((d) => d.key === trip.driverKey),
        source = plan.sources.find((s) => s.wellName === trip.wellName);
      if (!driver || !source)
        throw Error("Driver or source changed; plan again");
      records[trip.id] = {
        dispatchId: trip.id,
        ...assignmentIdentityForDriver(driver),
        driverFirstName: (
          driver.legalName ||
          driver.displayName ||
          "Driver"
        ).split(" ")[0],
        wellName: source.wellName,
        ndicWellName: source.ndicName || source.wellName,
        operator: source.operator,
        route: source.route || "",
        jobType: "pw",
        jobTypeId: "pw",
        packageId: "water-hauling",
        packetRevision: 4,
        status: "pending",
        priority: 500,
        assignedBy: userId,
        projectId: orderId,
        loadCount: 1,
        bbls: trip.bbl,
        disposal: draft.destination.trim(),
        ...(draft.latitude.trim()
          ? {
              disposalLat: Number(draft.latitude),
              disposalLng: Number(draft.longitude),
            }
          : {}),
        estimatedPullTime: trip.pickupAt,
        notes: `Water Order: ${draft.name.trim()}\nPlanned ${trip.bbl} BBL. Pickup ${display(trip.pickupAt)}; deliver by ${display(trip.deliveryAt)}.\n${trip.tanks.map((t) => `${draft.tanks.find((tank) => tank.id === t.id)?.name || t.id}: ${t.bbl} BBL`).join("; ")}\n${draft.notes.trim()}`,
      };
    }
    const value: Saved = JSON.parse(
        JSON.stringify({
          id: orderId,
          companyId: companyId!,
          draft,
          plan,
          records,
          sent: [],
        }),
      ),
      ref = doc(getFirestoreDb(), "projects", orderId);
    const result = await runTransaction(getFirestoreDb(), async (tx) => {
      const snap = await tx.get(ref);
      requireScope();
      if (snap.exists()) {
        const existing = snap.data().waterOrder as Saved;
        if (
          snap.data().companyId !== companyId ||
          !existing ||
          canonical(existing.plan) !== canonical(plan)
        )
          throw Error("Saved order changed; reopen it before dispatch");
        return { ...existing, id: orderId };
      }
      tx.set(ref, {
        name: `Water Order Â· ${draft.name.trim()}`,
        companyId,
        createdBy: userId,
        createdAt: new Date().toISOString(),
        startDate: plan.createdAt.slice(0, 10),
        projectedEndDate: plan.deadline.slice(0, 10),
        wellNames: [...new Set(plan.trips.map((t) => t.wellName))],
        operatorName: [...new Set(plan.sources.map((s) => s.operator))].join(
          "; ",
        ),
        jobType: "pw",
        status: "active",
        driverSchedule: {},
        notes: draft.notes,
        waterOrder: value,
      });
      return value;
    });
    if (alive.current) setSaved(result);
    return result;
  }
  function eligible(order: Saved, at: number) {
    return readyWaterTrips(order.plan, order.sent, at).filter((t) =>
      order.plan.trips
        .filter(
          (p) =>
            p.driverKey === t.driverKey &&
            Date.parse(p.startAt) < Date.parse(t.startAt),
        )
        .every(
          (p) =>
            closed[p.id] !== undefined ||
            linked[p.id] === "completed" ||
            linked[p.id] === "cancelled" ||
            linked[p.id] === "dismissed",
        ),
    );
  }
  async function dispatch() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    let sent = 0;
    try {
      requireScope();
      if (!ready) throw Error("Wait for live dispatch data");
      if (saved && !orderJobsReady)
        throw Error("Wait for this order’s live job status");
      const order = await persist();
      const committed: Record<string, number> = {};
      for (const trip of eligible(order, Date.now())) {
        requireScope();
        const well = scopeWells.find((w) => w.wellName === trip.wellName);
        if (!well) throw Error("Source is no longer available");
        const source = waterSourceFromWell(
          well,
          Date.now(),
          trip.cycleMinutes,
          reservedWater(jobs, well.wellName, well.pullBbls || draft.capacity) +
            (committed[well.wellName] || 0),
        );
        if (!linked[trip.id] && (!source || source.available + 0.01 < trip.bbl))
          throw Error(
            `${trip.wellName} no longer has the planned water available. Earlier successful jobs were retained.`,
          );
        const result = await createDispatch(order.records[trip.id], {
          actionId: order.id,
          actionScope: "water-order",
          unitId: trip.id,
        });
        if (result.dispatchId !== trip.id)
          throw Error("Dispatch identity changed");
        requireScope();
        await runTransaction(getFirestoreDb(), async (tx) => {
          const ref = doc(getFirestoreDb(), "projects", order.id),
            snap = await tx.get(ref);
          requireScope();
          if (
            snap.data()?.companyId !== companyId ||
            snap.data()?.waterOrder?.id !== order.id
          )
            throw Error("Order ownership changed");
          tx.update(ref, {
            "waterOrder.sent": [
              ...new Set([...(snap.data()!.waterOrder.sent || []), trip.id]),
            ],
          });
        });
        sent++;
        if (!linked[trip.id])
          committed[trip.wellName] = (committed[trip.wellName] || 0) + trip.bbl;
      }
      if (alive.current)
        setMessage(
          sent
            ? `${sent} jobs sent. Future pickups stay scheduled in this order.`
            : "Order saved. Future pickups stay here; use Dispatch when a planned load is ready.",
        );
    } catch (e) {
      if (alive.current)
        setMessage(
          e instanceof Error
            ? e.message
            : "Dispatch failed; retry uses the same job identities",
        );
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const activePlan = saved?.plan || plan,
    delivered = Object.values(closed).reduce((a, b) => a + b, 0),
    due = saved
      ? eligible(saved, now).length
      : plan
        ? readyWaterTrips(plan, [], now).length
        : 0;
  return (
    <section className="space-y-4 text-gray-200 min-w-0 overflow-y-auto">
      <div>
        <h2 className="text-lg font-semibold text-cyan-300">Water Orders</h2>
        <p className="text-xs text-gray-400">
          Fill targets, source water and truck time in one plan.
        </p>
      </div>
      <div className="flex gap-2">
        <select
          aria-label="Saved water order"
          className={field}
          disabled={busy}
          value={saved?.id || ""}
          onChange={(e) => {
            const o = orders.find((o) => o.id === e.target.value);
            if (o) {
              setSaved(o);
              setDraft(o.draft);
              setPlan(o.plan);
              setOrderId(o.id);
              setMessage("");
            }
          }}
        >
          <option value="">Saved ordersâ€¦</option>
          {orders.map((o) => (
            <option key={o.id} value={o.id}>
              {o.draft.name}
            </option>
          ))}
        </select>
        <button
          className="rounded border border-gray-600 px-3"
          disabled={busy}
          onClick={() => {
            setSaved(null);
            setPlan(null);
            setDraft(blank());
            setOrderId(id());
            setMessage("");
          }}
        >
          New
        </button>
      </div>
      <fieldset
        disabled={busy || !!saved || !canWrite}
        className="space-y-3 disabled:opacity-75"
      >
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs">
            Order name
            <input
              className={field}
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
            />
          </label>
          <label className="text-xs">
            Destination
            <input
              className={field}
              value={draft.destination}
              onChange={(e) => update({ destination: e.target.value })}
            />
          </label>
          <label className="text-xs">
            Deadline
            <input
              type="datetime-local"
              className={field}
              value={draft.deadline}
              onChange={(e) => update({ deadline: e.target.value })}
            />
          </label>
          <label className="text-xs">
            Fallback turnaround, minutes
            <input
              type="number"
              min="1"
              className={field}
              value={draft.fallback}
              onChange={(e) => update({ fallback: Number(e.target.value) })}
            />
          </label>
        </div>
        <details>
          <summary className="text-xs cursor-pointer">
            Destination coordinates and travel estimates
          </summary>
          <div className="grid grid-cols-2 gap-2 mt-2">
            {(
              [
                ["latitude", "Latitude"],
                ["longitude", "Longitude"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="text-xs">
                {label}
                <input
                  className={field}
                  value={draft[key]}
                  onChange={(e) => update({ [key]: e.target.value })}
                />
              </label>
            ))}
            <label className="text-xs">
              Average driving MPH
              <input
                className={field}
                type="number"
                value={draft.mph}
                onChange={(e) => update({ mph: Number(e.target.value) })}
              />
            </label>
            <label className="text-xs">
              Load + unload minutes
              <input
                className={field}
                type="number"
                value={draft.handling}
                onChange={(e) => update({ handling: Number(e.target.value) })}
              />
            </label>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            With coordinates, travel uses distance Ã— 1.25 at the chosen speed.
            Enter a known turnaround below to override it.
          </p>
        </details>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th className="text-left">Tank</th>
                <th>Capacity</th>
                <th>Buffer</th>
                <th>Already in tank</th>
                <th>Fill target</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {draft.tanks.map((tank, index) => (
                <tr key={tank.id}>
                  <td>{tank.name}</td>
                  {(["capacity", "buffer", "current"] as const).map((key) => (
                    <td key={key}>
                      <input
                        aria-label={`${tank.name} ${key}`}
                        className={field}
                        type="number"
                        min="0"
                        value={tank[key]}
                        onChange={(e) =>
                          update({
                            tanks: draft.tanks.map((t, i) =>
                              i === index
                                ? { ...t, [key]: Number(e.target.value) }
                                : t,
                            ),
                          })
                        }
                      />
                    </td>
                  ))}
                  <td className="text-center">{tank.capacity - tank.buffer}</td>
                  <td>
                    <button
                      aria-label={`Remove ${tank.name}`}
                      onClick={() =>
                        update({
                          tanks: draft.tanks.filter((t) => t.id !== tank.id),
                        })
                      }
                    >
                      Ã—
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex gap-2">
          {(["Frac", "Upright"] as const).map((kind) => (
            <button
              className="rounded border border-gray-600 px-3 py-1 text-xs"
              key={kind}
              onClick={() =>
                update({
                  tanks: [
                    ...draft.tanks,
                    {
                      id: crypto.randomUUID(),
                      name: `${kind} ${draft.tanks.filter((t) => t.name.startsWith(kind)).length + 1}`,
                      capacity: kind === "Frac" ? 500 : 400,
                      buffer: 40,
                      current: 0,
                    },
                  ],
                })
              }
            >
              + {kind} tank
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs">
            Truck load capacity, BBL
            <input
              className={field}
              type="number"
              value={draft.capacity}
              onChange={(e) => update({ capacity: Number(e.target.value) })}
            />
          </label>
          <label className="text-xs">
            Hours available for this order / truck / day
            <input
              className={field}
              type="number"
              value={draft.hours}
              onChange={(e) => update({ hours: Number(e.target.value) })}
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-3">
          {scopeDrivers.map((driver) => (
            <label className="text-xs flex gap-1 items-center" key={driver.key}>
              <input
                type="checkbox"
                checked={draft.truckKeys.includes(driver.key)}
                onChange={(e) =>
                  update({
                    truckKeys: e.target.checked
                      ? [...draft.truckKeys, driver.key]
                      : draft.truckKeys.filter((k) => k !== driver.key),
                  })
                }
              />
              {driver.legalName || driver.displayName || "Driver"}
            </label>
          ))}
        </div>
        <details>
          <summary className="text-xs cursor-pointer">
            Eligible source wells Â· choose sources allowed for this order
          </summary>
          <div className="max-h-52 overflow-auto mt-2 space-y-1">
            {scopeWells.map((w) => (
              <div className="flex items-center gap-2 text-xs" key={w.wellName}>
                <input
                  aria-label={`Use ${w.wellName}`}
                  type="checkbox"
                  checked={!draft.excluded.includes(w.wellName)}
                  onChange={(e) =>
                    update({
                      excluded: e.target.checked
                        ? draft.excluded.filter((n) => n !== w.wellName)
                        : [...draft.excluded, w.wellName],
                    })
                  }
                />
                <span className="flex-1">
                  {w.wellName}
                  <span className="text-gray-500">
                    {" "}
                    Â· {w.operator || "Operator missing"}
                  </span>
                </span>
                <input
                  aria-label={`${w.wellName} turnaround minutes`}
                  className="w-24 rounded bg-gray-900 border border-gray-600 px-2 py-1"
                  type="number"
                  min="1"
                  placeholder="Auto / fallback"
                  value={draft.cycles[w.wellName] || ""}
                  onChange={(e) =>
                    update({
                      cycles: { ...draft.cycles, [w.wellName]: e.target.value },
                    })
                  }
                />
              </div>
            ))}
          </div>
        </details>
        <label className="block text-xs">
          Water requirements / dispatch instructions
          <textarea
            className={field}
            value={draft.notes}
            onChange={(e) => update({ notes: e.target.value })}
          />
        </label>
      </fieldset>
      <div className="flex gap-3">
        <button
          disabled={busy || !!saved || !canWrite || !ready}
          className="rounded bg-cyan-700 px-4 py-2 font-semibold disabled:opacity-40"
          onClick={() => void makePlan()}
        >
          Plan Supply
        </button>
        <button
          disabled={
            busy ||
            !activePlan ||
            !canWrite ||
            !ready ||
            (!!saved && !orderJobsReady)
          }
          className="rounded bg-blue-600 px-4 py-2 font-semibold disabled:opacity-40"
          onClick={() => void dispatch()}
        >
          Dispatch{due ? ` Â· ${due} ready` : ""}
        </button>
      </div>
      <p role="status" className="text-sm text-amber-300">
        {busy ? "Workingâ€¦" : message}
      </p>
      {activePlan && (
        <>
          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            {[
              ["Fill targets", activePlan.target],
              ["Already present", activePlan.existing],
              ["Needed", activePlan.needed],
              ["Planned", activePlan.planned],
              ["Delivered", delivered],
              ["Still needed", Math.max(0, activePlan.needed - delivered)],
            ].map(([label, value]) => (
              <div key={label} className="rounded bg-gray-900 p-2">
                <div className="text-gray-400">{label}</div>
                <strong>{value} BBL</strong>
              </div>
            ))}
          </div>
          {activePlan.shortfall > 0 && (
            <p className="text-amber-300 text-sm">
              {activePlan.shortfall} BBL cannot be supplied within the deadline
              and current truck hours.
            </p>
          )}
          <p className="text-xs text-gray-400">
            Dispatch sends ready loads with stable job identities. Future
            pickups stay with this order; reopen it and use Dispatch when ready.
            Later loads wait for that driver's earlier load to finish. Forecasts
            are estimates, not tank measurements.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left">Source / operator</th>
                  <th>Available*</th>
                  <th>BBL/day</th>
                  <th>Reserved</th>
                  <th>Cycle</th>
                </tr>
              </thead>
              <tbody>
                {activePlan.sources.map((s) => (
                  <tr key={s.wellName} className="border-t border-gray-700">
                    <td className="py-2">
                      {s.wellName}
                      <div className="text-gray-500">{s.operator}</div>
                    </td>
                    <td className="text-center">{s.available}</td>
                    <td className="text-center">{s.daily}</td>
                    <td className="text-center">{s.reserved}</td>
                    <td className="text-center">{s.cycleMinutes} min</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-gray-500 text-xs">
              *Estimated above the minimum level, after existing dispatch
              commitments; as of {display(activePlan.createdAt)}.
            </p>
          </div>
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left">Pickup / delivery</th>
                  <th>Driver / source</th>
                  <th>BBL / tank</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {activePlan.trips.map((t) => (
                  <tr key={t.id} className="border-t border-gray-700">
                    <td className="py-2">
                      {display(t.pickupAt)}
                      <div className="text-gray-500">
                        â†’ {display(t.deliveryAt)}
                      </div>
                    </td>
                    <td>
                      {scopeDrivers.find((d) => d.key === t.driverKey)
                        ?.legalName ||
                        scopeDrivers.find((d) => d.key === t.driverKey)
                          ?.displayName ||
                        "Driver"}
                      <div className="text-gray-500">{t.wellName}</div>
                    </td>
                    <td>
                      {t.bbl}
                      <div className="text-gray-500">
                        {t.tanks
                          .map(
                            (a) =>
                              `${draft.tanks.find((tank) => tank.id === a.id)?.name || a.id}: ${a.bbl}`,
                          )
                          .join("; ")}
                      </div>
                    </td>
                    <td>
                      {closed[t.id] !== undefined
                        ? `Delivered ${closed[t.id]}`
                        : saved?.sent.includes(t.id)
                          ? linked[t.id] || "Sent"
                          : Date.parse(t.startAt) > now
                            ? "Scheduled"
                            : "Ready"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
