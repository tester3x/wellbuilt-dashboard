"use client";
import React, { useEffect, useRef, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import { getFirestoreDb, getFirebaseFunctions } from "@/lib/firebase";
import { httpsCallable } from "firebase/functions";
import { loadWellsForOperator, loadDisposals, searchWellsByName, type NdicWell } from "@/lib/firestoreWells";
import { BuilderAutocomplete } from "@/components/BuilderAutocomplete";
import { WaterOrderPlanReview } from "@/components/WaterOrderPlanReview";
import { releasableWaterTrips } from "@/lib/waterOrderProgress";
import { operationalDriverName } from "@/lib/operationalDriverName";
import { assignmentIdentityForDriver } from "@/lib/dispatchWriterIdentity";
import type { DriverIdentity } from "@/lib/dispatchDriverIdentity";
import type { ShiftDotView } from "@/lib/shiftDotCore";
import { DispatchDriverPicker, type PickerDriver, type PlannedShift } from "@/components/DispatchDriverPicker";
import { preDispatchBlocked } from "@/lib/driverWeeklySchedule";
import type { WellResponse } from "@/lib/wellPoolCore";
import {
  estimateCycleMinutes,
  planWaterOrder,
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
type WaterOrderDriver = DriverIdentity & PickerDriver;
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
  truckSettings?: Record<string,{capacity?:number;hours?:number}>;
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
  tanks: [],
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
const id = () => "water_" + crypto.randomUUID();
const field =
  "min-w-0 w-full rounded border border-gray-600 bg-gray-900 px-2 py-1.5 text-sm text-white";

export function WaterOrderBuilder({
  companyId,
  userId,
  wells,
  drivers,
  jobs,
  ready,
  canWrite,
  createDispatch,
  shiftForDriver,
  shiftDate,
  onShiftDateChange,
  onShiftChange,
  readOnlyShifts,
}: {
  companyId?: string;
  userId: string;
  wells: WellResponse[];
  drivers: WaterOrderDriver[];
  jobs: Job[];
  ready: boolean;
  canWrite: boolean;
  shiftForDriver?: (driver:DriverIdentity)=>ShiftDotView;
  shiftDate: string;
  onShiftDateChange: (date: string) => void;
  onShiftChange: (driver: WaterOrderDriver, date: string, shift: PlannedShift) => Promise<void>;
  readOnlyShifts?: boolean;
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
  const authority=useRef({companyId,userId,canWrite});
  authority.current={companyId,userId,canWrite};
  const [sourceSearch,setSourceSearch]=useState(''),[destinationRows,setDestinationRows]=useState<NdicWell[]>([]),
    [destinationState,setDestinationState]=useState(''),[dispatchProgress,setDispatchProgress]=useState('');
  const [fleetSearch,setFleetSearch]=useState('');
  const destinationRequest=useRef(0);
  const destinationCatalog=useRef<Promise<PromiseSettledResult<NdicWell[]>[]>|null>(null);
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
  const visibleSources=scopeWells.filter(w=>`${w.wellName} ${w.operator||''}`.toLowerCase().includes(sourceSearch.trim().toLowerCase()));
  const requireScope = () => {
    if (
      !alive.current ||
      !companyId ||
      companyId === "__no_company_access__" ||
      !canWrite || !authority.current.canWrite || authority.current.companyId!==companyId || authority.current.userId!==userId
    )
      throw Error("Choose a company with dispatch permission");
  };
  async function searchDestination(value:string) {
    update({destination:value,latitude:'',longitude:''});
    const request=++destinationRequest.current;
    setDestinationRows([]);
    if(value.trim().length<2){setDestinationState('Type at least two characters to search locations.');return;}
    setDestinationState('Searching locations…');
    try {
      const pending=destinationCatalog.current ||= Promise.allSettled([
        loadDisposals(),
        ...[...new Set(scopeWells.map(w=>w.operator).filter((o):o is string=>!!o))].map(loadWellsForOperator),
      ]);
      const groups=await pending;
      if(groups.some(g=>g.status==='rejected'))destinationCatalog.current=null;
      if(!alive.current||request!==destinationRequest.current)return;
      const unique=new Map<string,NdicWell>();
      groups.forEach(g=>{if(g.status==='fulfilled')g.value.forEach(w=>unique.set(`${w.operator}:${w.well_name}`,w));});
      const matches=searchWellsByName(value,[...unique.values()],30);
      setDestinationRows(matches);
      setDestinationState(groups.some(g=>g.status==='rejected')?'Some locations could not be loaded. You can enter a destination name and use the fallback turnaround.':matches.length?'Choose a matching location, or keep your typed destination.':'No catalog match. You can keep this name and use the fallback turnaround.');
    } catch {
      if(alive.current&&request===destinationRequest.current)setDestinationState('Location search unavailable. Enter the name and use the fallback turnaround.');
    }
  }
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
      if(!draft.tanks.length) throw Error('Add the tank types needed for this order');
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
          name: operationalDriverName(d),
          capacity: draft.truckSettings?.[key]?.capacity ?? draft.capacity,
          hoursPerDay: draft.truckSettings?.[key]?.hours ?? draft.hours,
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
      );
    if(new TextEncoder().encode(JSON.stringify(value)).length>900000)
      throw Error('This order is too large to save safely. Split it into smaller orders.');
    const response=await httpsCallable(getFirebaseFunctions(),'staffWriteWaterOrder')({op:'save',orderId,companyId,value});
    requireScope();
    const result=(response.data as {order:Saved}).order;
    if(result?.id!==orderId||result?.companyId!==companyId)throw Error('Order confirmation did not match this company');
    if (alive.current) setSaved(result);
    return result;
  }
  function eligible(order: Saved, at: number) {
    return releasableWaterTrips(order.plan,order.sent,at,closed,linked);
  }
  async function dispatch() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    setDispatchProgress('Saving order…');
    let sent = 0;
    try {
      requireScope();
      if (!ready) throw Error("Wait for live dispatch data");
      if (saved && !orderJobsReady)
        throw Error("Wait for this order’s live job status");
      const order = await persist();
      const trips=eligible(order,Date.now());
      const committed: Record<string, number> = {};
      for (const trip of trips) {
        if(alive.current)setDispatchProgress(`Sending job ${sent+1} of ${trips.length} · ${sent} confirmed`);
        requireScope();
        const tripDriver = scopeDrivers.find(driver => driver.key === trip.driverKey);
        if (!tripDriver) throw Error('A planned driver is no longer available');
        const pickupDate = new Date(trip.pickupAt);
        const localPickupDate = `${pickupDate.getFullYear()}-${String(pickupDate.getMonth() + 1).padStart(2, '0')}-${String(pickupDate.getDate()).padStart(2, '0')}`;
        if (preDispatchBlocked(tripDriver, localPickupDate, shiftForDriver?.(tripDriver).title || 'Shift status unavailable')) {
          throw Error(`${operationalDriverName(tripDriver)} has a regular or planned day off on ${localPickupDate}. Wait for the driver to clock on shift.`);
        }
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
        const response=await httpsCallable(getFirebaseFunctions(),'staffWriteWaterOrder')({op:'acknowledge',orderId:order.id,companyId,dispatchId:trip.id});
        requireScope();
        const confirmed=(response.data as {order:Saved}).order;
        if(confirmed?.id!==order.id||confirmed.companyId!==companyId||!confirmed.sent?.includes(trip.id))throw Error('Server has not confirmed this order job');
        sent++;
        if(alive.current)setSaved(current=>current?.id===order.id?{...current,sent:[...new Set([...current.sent,trip.id])]}:current);
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
            ? `${sent ? `${sent} jobs confirmed before this stopped. ` : ''}${e.message} Retry keeps the same job identities.`
            : "Dispatch failed; retry uses the same job identities",
        );
    } finally {
      running.current = false;
      if (alive.current) {setBusy(false);setDispatchProgress('');}
    }
  }
  const activePlan = saved?.plan || plan,
    due = saved
      ? eligible(saved, now).length
      : plan
        ? releasableWaterTrips(plan, [], now, {}, {}).length
        : 0;
  return (
    <section className="space-y-4 text-gray-200 min-w-0">
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
              destinationRequest.current++;setDestinationRows([]);setDestinationState('');setSourceSearch('');setFleetSearch('');
              setSaved(o);
              setDraft(o.draft);
              setPlan(o.plan);
              setOrderId(o.id);
              setMessage("");
            }
          }}
        >
          <option value="">Saved orders…</option>
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
            destinationRequest.current++;setDestinationRows([]);setDestinationState('');setSourceSearch('');setFleetSearch('');
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
        className="min-w-0 space-y-3 disabled:opacity-75"
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
          <label className="text-xs min-w-0">
            Destination
            <BuilderAutocomplete ariaLabel="Order destination" value={draft.destination} onValueChange={value=>void searchDestination(value)}
              items={destinationRows} minChars={2} inputClassName={field} placeholder="Search well or drop-off name"
              listClassName="max-h-52 overflow-y-auto rounded border border-gray-600 bg-gray-900" optionClassName="wb-option-row block w-full px-2 py-2 text-left text-xs"
              getItemKey={w=>`${w.operator}:${w.well_name}`} renderItem={w=><>{w.well_name}<span className="block text-gray-400">{w.operator}</span></>}
              onSelect={w=>{destinationRequest.current++;setDestinationRows([]);const valid=typeof w.latitude==='number'&&Number.isFinite(w.latitude)&&Math.abs(w.latitude)<=90&&typeof w.longitude==='number'&&Number.isFinite(w.longitude)&&Math.abs(w.longitude)<=180;update({destination:w.well_name,latitude:valid?String(w.latitude):'',longitude:valid?String(w.longitude):''});setDestinationState(valid?'Location selected. Travel estimates use its catalog coordinates.':'Location selected; no catalog coordinates. Fallback turnaround will be used.');}}/>
            <span role="status" className="block mt-1 text-gray-400">{destinationState}</span>
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
            Travel estimates / optional coordinate override
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
            With coordinates, travel uses distance × 1.25 at the chosen speed.
            Enter a known turnaround below to override it.
          </p>
        </details>
        {!draft.tanks.length&&<p className="text-sm text-gray-400">Choose the tank types needed below. No tanks are selected yet.</p>}
        <div className="max-h-80 overflow-auto">
          <table className="w-full min-w-[520px] text-xs">
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
                      ×
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
              disabled={draft.tanks.length>=120}
              onClick={() =>
                update({
                  tanks: [
                    ...draft.tanks,
                    {
                      id: crypto.randomUUID(),
                      name: `${kind} ${Math.max(0,...draft.tanks.filter(t=>t.name.startsWith(kind+' ')).map(t=>Number(t.name.split(' ').at(-1))||0))+1}`,
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
        <p className="text-xs text-gray-400">{draft.tanks.length} tanks · {draft.tanks.reduce((sum,t)=>sum+Math.max(0,t.capacity-t.buffer-t.current),0)} BBL needed. Capacities, buffers and current water remain editable.</p>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs">
            Default truck load capacity, BBL
            <input
              className={field}
              type="number"
              value={draft.capacity}
              onChange={(e) => update({ capacity: Number(e.target.value) })}
            />
          </label>
          <label className="text-xs">
            Default hours available / truck / day
            <input
              className={field}
              type="number"
              value={draft.hours}
              onChange={(e) => update({ hours: Number(e.target.value) })}
            />
          </label>
        </div>
        <DispatchDriverPicker drivers={scopeDrivers} selection="multiple" selectedKeys={new Set(draft.truckKeys)}
          onSelect={key => update({truckKeys: draft.truckKeys.includes(key) ? draft.truckKeys.filter(value => value !== key) : [...draft.truckKeys, key]})}
          onSelectMany={truckKeys => update({truckKeys})} disabledSelection={busy || !!saved || !canWrite}
          shiftDate={shiftDate} onShiftDateChange={onShiftDateChange} onShiftChange={onShiftChange}
          shiftDot={shiftForDriver || (() => ({symbol: '○', title: 'Shift unverified'}))} readOnlyShifts={readOnlyShifts} />
        {draft.truckKeys.length>0&&<details>
          <summary className="cursor-pointer py-2 text-xs">Individual truck settings · {draft.truckKeys.length} drivers</summary>
          <p className="text-xs text-gray-400">Defaults apply unless overridden here. Enter the truck’s load capacity and hours available to this order; these are not HOS balances.</p>
          <input type="search" aria-label="Search truck settings" className={`${field} mt-2`} value={fleetSearch} onChange={e=>setFleetSearch(e.target.value)} placeholder="Find selected driver"/>
          <div className="max-h-64 overflow-auto"><table className="w-full min-w-[400px] text-xs"><thead><tr><th className="text-left">Driver</th><th>Capacity, BBL</th><th>Hours / day</th></tr></thead><tbody>
            {draft.truckKeys.map(key=>scopeDrivers.find(d=>d.key===key)).filter((d):d is WaterOrderDriver=>!!d).filter(d=>operationalDriverName(d).toLowerCase().includes(fleetSearch.trim().toLowerCase())).map(d=><tr key={d.key}><td className="p-2">{operationalDriverName(d)}</td>{(['capacity','hours'] as const).map(setting=><td key={setting} className="p-1"><input aria-label={`${operationalDriverName(d)} ${setting}`} className={`${field} max-w-24`} type="number" min="0" placeholder={String(setting==='capacity'?draft.capacity:draft.hours)} value={draft.truckSettings?.[d.key]?.[setting]??''} onChange={e=>update({truckSettings:{...draft.truckSettings,[d.key]:{...draft.truckSettings?.[d.key],[setting]:e.target.value===''?undefined:Number(e.target.value)}}})}/></td>)}</tr>)}
          </tbody></table></div>
        </details>}
        <details>
          <summary className="text-xs cursor-pointer">
            Source wells · choose sources allowed for this order
          </summary>
          <input type="search" aria-label="Search source wells" className={`${field} mt-2`} placeholder="Search source or operator" value={sourceSearch} onChange={e=>setSourceSearch(e.target.value)}/>
          <p className="text-xs text-gray-400">{scopeWells.filter(w=>!draft.excluded.includes(w.wellName)).length} of {scopeWells.length} allowed. Planning excludes sources without verified tank data.</p>
          <div className="flex flex-wrap gap-3 py-2 text-xs">
            <button type="button" disabled={!visibleSources.length} className="text-cyan-300 underline disabled:opacity-40" onClick={()=>update({excluded:scopeWells.filter(w=>!visibleSources.some(v=>v.wellName===w.wellName)).map(w=>w.wellName)})}>Use only shown sources</button>
            <button type="button" disabled={!visibleSources.length} className="text-cyan-300 underline disabled:opacity-40" onClick={()=>update({excluded:draft.excluded.filter(name=>!visibleSources.some(w=>w.wellName===name))})}>Allow shown sources</button>
            <button type="button" disabled={!visibleSources.length} className="text-gray-300 underline disabled:opacity-40" onClick={()=>update({excluded:[...new Set([...draft.excluded,...visibleSources.map(w=>w.wellName)])]})}>Exclude shown sources</button>
          </div>
          <div className="max-h-52 overflow-auto mt-2 space-y-1">
            {visibleSources.map((w) => (
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
                <span className="flex-1 min-w-0 break-words">
                  {w.wellName}
                  <span className="text-gray-500">
                    {" "}
                    · {w.operator || "Operator missing"}
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
            {!visibleSources.length&&<p className="text-xs text-gray-400">No sources match this search.</p>}
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
          Dispatch{due ? ` · ${due} ready` : ""}
        </button>
      </div>
      <p role="status" className="text-sm text-amber-300">
        {busy ? dispatchProgress||"Planning supply…" : message}
      </p>
      {activePlan && <WaterOrderPlanReview key={saved?.id||activePlan.createdAt} plan={activePlan} drivers={scopeDrivers} selectedKeys={draft.truckKeys} tanks={draft.tanks} sent={saved?.sent||[]} closed={closed} linked={linked} now={now}/>}
    </section>
  );
}
