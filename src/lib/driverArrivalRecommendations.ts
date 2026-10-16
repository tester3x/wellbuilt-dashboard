import { resolveDispatchDriver, type DriverIdentity, type DispatchIdentity } from './dispatchDriverIdentity.ts';

export type ArrivalPoint = { lat: number; lng: number };
export type ArrivalStage = 'en_route_pickup' | 'on_site_pickup' | 'en_route_dropoff' | 'on_site_dropoff';
export type ArrivalJob = DispatchIdentity & {
  id?: string; status: string; wellName?: string; ndicWellName?: string;
  driverStage?: string; driverDest?: string; stageUpdatedAt?: unknown;
  driverLat?: number; driverLng?: number; driverGpsAt?: string;
  disposal?: string; hauledTo?: string; disposalLat?: number; disposalLng?: number;
  invoiceDocId?: string; jobType?: string; loadCount?: number; loadsCompleted?: number;
  splitGroupId?: string; splitSequence?: number; splitTotal?: number;
};
export type ArrivalEvent = { type: string; timestamp: string; lat?: number | null; lng?: number | null; locationName?: string | null };
export type ArrivalInvoice = DispatchIdentity & {
  id: string; dispatchId?: string; status?: string; commodityType?: string;
  wellName?: string; hauledTo?: string; haulGroupId?: string; timeline?: ArrivalEvent[];
};
export type ArrivalSample = { kind: 'load' | 'unload' | 'drive'; driverId: string; location: string;
  minutes: number; from?: ArrivalPoint; to?: ArrivalPoint };
export type ArrivalTravel = { minutes: number; miles?: number; source: 'road' | 'history'; samples?: number };
export type ArrivalRecommendation = {
  driverKey: string; arrivalMinutes: number | null; releaseMinutes: number | null;
  travelMinutes: number | null; miles?: number; queueCount: number;
  confidence: 'estimated' | 'unknown'; reasons: string[];
};
export const DRIVER_GPS_MAX_AGE_MS = 15 * 60000;
const key = (s: string | undefined | null) => (s || '').trim().toLowerCase();
export function arrivalTimestampMs(value: any): number {
  const n = typeof value?.toMillis === 'function' ? value.toMillis()
    : typeof value?.seconds === 'number' ? value.seconds * 1000
    : typeof value?.toDate === 'function' ? value.toDate().getTime()
    : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) ? n : 0;
}
export function arrivalPoint(lat: unknown, lng: unknown): ArrivalPoint | null {
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0) ? { lat, lng } : null;
}
function km(a: ArrivalPoint, b: ArrivalPoint): number {
  const r = Math.PI / 180, dlat = (b.lat - a.lat) * r, dlng = (b.lng - a.lng) * r;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dlng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
const median = (values: number[]) => { const a = [...values].sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

/** Adjacent real events only: pauses and incomplete legs never become service samples. */
export function buildArrivalHistory(invoices: readonly ArrivalInvoice[], companyId: string, nowMs: number): ArrivalSample[] {
  const samples: ArrivalSample[] = [], seen = new Set<string>();
  for (const invoice of invoices) {
    if (invoice.companyId !== companyId || companyId === 'wellbuilt-demo'
      || !['closed', 'submitted', 'approved', 'paid'].includes(invoice.status || '')
      || !/^production water/i.test(invoice.commodityType || '') || !invoice.driverId) continue;
    const events = [...(invoice.timeline || [])].filter(e => arrivalTimestampMs(e.timestamp) > 0)
      .sort((a, b) => arrivalTimestampMs(a.timestamp) - arrivalTimestampMs(b.timestamp));
    for (let i = 0; i < events.length - 1; i++) {
      const a = events[i], b = events[i + 1], end = arrivalTimestampMs(b.timestamp);
      const minutes = (end - arrivalTimestampMs(a.timestamp)) / 60000;
      if (minutes < 1 || minutes > 180 || end > nowMs || end < nowMs - 14 * 86400000) continue;
      let kind: ArrivalSample['kind'] | null = null;
      if ((a.type === 'depart' || a.type === 'depart_site') && b.type === 'arrive') kind = 'drive';
      if (a.type === 'arrive' && b.type === 'depart_site' && key(a.locationName) === key(invoice.wellName) && key(a.locationName)) kind = 'load';
      if (a.type === 'arrive' && b.type === 'close' && key(a.locationName) === key(invoice.hauledTo) && key(a.locationName)) kind = 'unload';
      if (!kind) continue;
      const identity = [invoice.driverId, kind, a.timestamp, b.timestamp, key(a.locationName)].join('|');
      if (seen.has(identity)) continue; seen.add(identity);
      samples.push({ kind, driverId: invoice.driverId, location: key(a.locationName), minutes,
        from: arrivalPoint(a.lat, a.lng) || undefined, to: arrivalPoint(b.lat, b.lng) || undefined });
    }
  }
  return samples;
}

export function historicalArrivalTravel(samples: readonly ArrivalSample[], from: ArrivalPoint, to: ArrivalPoint): ArrivalTravel | null {
  const matching = samples.filter(s => s.kind === 'drive' && s.from && s.to && km(s.from, from) <= 0.5 && km(s.to, to) <= 0.5);
  return matching.length >= 3 ? { minutes: median(matching.map(s => s.minutes)), source: 'history', samples: matching.length } : null;
}
function onsiteEstimate(samples: readonly ArrivalSample[], kind: 'load' | 'unload', driver: DriverIdentity, location: string) {
  const all = samples.filter(s => s.kind === kind);
  const groups = [all.filter(s => s.driverId === driver.driverId && s.location === key(location)),
    all.filter(s => s.location === key(location)), all.filter(s => s.driverId === driver.driverId), all];
  const labels = ['driver + site', 'site', 'driver', 'company'];
  const at = groups.findIndex(g => g.length >= 3);
  return at < 0 ? null : { minutes: median(groups[at].map(s => s.minutes)), count: groups[at].length, label: labels[at] };
}

export async function recommendDriverArrivals(input: {
  drivers: readonly DriverIdentity[]; jobs: readonly ArrivalJob[]; invoices: readonly ArrivalInvoice[];
  companyId: string; target: ArrivalPoint | null; nowMs: number; jobsComplete: boolean;
  history: readonly ArrivalSample[]; shift: (driver: DriverIdentity) => 'open' | 'none' | 'unknown';
  locate: (name: string) => ArrivalPoint | null;
  roadTime?: (from: ArrivalPoint, to: ArrivalPoint) => Promise<ArrivalTravel | null>;
}): Promise<ArrivalRecommendation[]> {
  const { companyId, nowMs, history } = input;
  const travel = async (from: ArrivalPoint, to: ArrivalPoint) => {
    if (km(from, to) < 0.1) return { minutes: 0, source: 'history' as const, samples: 0 };
    const recorded = historicalArrivalTravel(history, from, to);
    if (recorded) return recorded;
    let road: ArrivalTravel | null = null;
    try { road = await input.roadTime?.(from, to) || null; } catch { /* unknown, never invent a journey */ }
    return road && Number.isFinite(road.minutes) && road.minutes >= 0 ? road : null;
  };
  const result = await Promise.all(input.drivers.map(async driver => {
    const jobs = input.jobs.filter(j => (j.companyId === companyId || (!j.companyId && companyId === 'liquid-gold')) && resolveDispatchDriver(j, [...input.drivers])?.key === driver.key);
    const queueCount = jobs.filter(j => j.status === 'pending' || j.status === 'pending_approval').length;
    const reasons: string[] = [];
    const unknown = (reason: string): ArrivalRecommendation => ({ driverKey: driver.key, arrivalMinutes: null, releaseMinutes: null,
      travelMinutes: null, queueCount, confidence: 'unknown', reasons: [...reasons, reason] });
    if (driver.companyId && driver.companyId !== companyId) return unknown('Outside the selected company; not compared');
    if (!driver.companyId && companyId !== 'liquid-gold') return unknown('Driver company identity unavailable');
    if (!input.jobsComplete) return unknown('Current job feed unavailable; cannot assume this driver is free');
    if (!input.target) return unknown('Pickup coordinates unavailable or ambiguous');
    const shift = input.shift(driver);
    if (shift !== 'open') return unknown(shift === 'none' ? 'Off shift; next start time unknown' : 'Shift status unavailable');
    const active = jobs.filter(j => ['accepted', 'in_progress', 'paused'].includes(j.status));
    let origin: ArrivalPoint | null = null, release = 0;
    if (active.length) {
      const linked = active.map(j => input.invoices.find(i => i.id === j.invoiceDocId && i.dispatchId === j.id && i.companyId === companyId));
      if (active.length > 1) {
        const group = linked[0]?.haulGroupId;
        if (!group || linked.some(i => !i || i.status !== 'open' || i.haulGroupId !== group)
          || active.some(j => !['en_route_dropoff', 'on_site_dropoff'].includes(j.driverStage || ''))
          || new Set(active.map(j => key(j.hauledTo || j.disposal || j.driverDest))).size !== 1) {
          return unknown('Multiple active jobs; remaining pickup/split itinerary needs review');
        }
        reasons.push(`${active.length} multi-haul jobs share one remaining drive/unload`);
      }
      const job = [...active].sort((a, b) => arrivalTimestampMs(b.stageUpdatedAt) - arrivalTimestampMs(a.stageUpdatedAt))[0];
      if (job.status === 'paused' || job.driverStage === 'paused') return unknown('Paused; resume time unknown');
      if (job.splitGroupId && (job.splitTotal || 1) > (job.splitSequence || 1)) return unknown('Additional split stops remain; completion time unknown');
      if ((job.loadCount || 1) - (job.loadsCompleted || 0) > 1) return unknown('Multiple planned loads remain; full itinerary time unknown');
      if (job.jobType !== 'pw') return unknown('Service work finish time not recorded');
      const stage = job.driverStage, age = (nowMs - arrivalTimestampMs(job.stageUpdatedAt)) / 60000;
      if (!Number.isFinite(age) || age < -1 || age > 360) return unknown('Job stage timestamp is stale or unavailable');
      const dropName = job.hauledTo || job.disposal || (stage?.includes('dropoff') ? job.driverDest : '') || '';
      // A changed destination cannot borrow the original disposal's coordinates.
      const drop = input.locate(dropName) || (key(dropName) === key(job.disposal) ? arrivalPoint(job.disposalLat, job.disposalLng) : null);
      if (!drop) return unknown('Current drop-off location unavailable');
      origin = drop;
      const unload = onsiteEstimate(history, 'unload', driver, dropName);
      if (!unload) return unknown('Not enough clean unloading history (need 3 samples)');
      const addService = (kind: 'load' | 'unload', location: string, elapsed: number): number | null => {
        const sample = onsiteEstimate(history, kind, driver, location);
        if (!sample) return null;
        if (elapsed >= sample.minutes) return null;
        reasons.push(`${kind === 'load' ? 'Loading' : 'Unloading'} ~${Math.ceil(sample.minutes - elapsed)}m remaining (${sample.label}, ${sample.count} samples)`);
        return sample.minutes - elapsed;
      };
      const fresh = arrivalPoint(job.driverLat, job.driverLng);
      const gpsAge = nowMs - arrivalTimestampMs(job.driverGpsAt);
      if (stage === 'on_site_dropoff') {
        const remaining = addService('unload', dropName, Math.max(0, age));
        if (remaining === null) return unknown('Unload has exceeded its usual time; finish time uncertain');
        release = remaining;
      } else if (stage === 'en_route_dropoff' || stage === 'en_route_pickup') {
        if (!fresh || gpsAge < -60000 || gpsAge > DRIVER_GPS_MAX_AGE_MS) return unknown('Driving GPS is missing or older than 15 minutes');
        reasons.push(`GPS ${Math.max(0, Math.floor(gpsAge / 60000))}m old`);
        const next = stage === 'en_route_dropoff' ? drop : input.locate(job.ndicWellName || job.wellName || '');
        if (!next) return unknown('Current pickup coordinates unavailable');
        const leg = await travel(fresh, next);
        if (!leg) return unknown('Remaining drive time unavailable (no road response or matching trip history)');
        release = leg.minutes + unload.minutes;
        reasons.push(`Current drive ~${Math.ceil(leg.minutes)}m (${leg.source}) + unload ~${Math.ceil(unload.minutes)}m (${unload.count} samples)`);
        if (stage === 'en_route_pickup') {
          const load = onsiteEstimate(history, 'load', driver, job.wellName || '');
          const onward = await travel(next, drop);
          if (!load || !onward) return unknown('Pickup-to-drop-off travel or loading history unavailable');
          release += load.minutes + onward.minutes;
          reasons.push(`Load ~${Math.ceil(load.minutes)}m (${load.count} samples), then ~${Math.ceil(onward.minutes)}m to drop-off (${onward.source})`);
        }
      } else if (stage === 'on_site_pickup') {
        const pickup = input.locate(job.ndicWellName || job.wellName || '');
        if (!pickup) return unknown('Current pickup coordinates unavailable');
        const load = addService('load', job.wellName || '', Math.max(0, age));
        const onward = await travel(pickup, drop);
        if (load === null) return unknown('Loading duration unknown or longer than usual');
        if (!onward) return unknown('Pickup-to-drop-off travel time unavailable');
        release = load + onward.minutes + unload.minutes;
        reasons.push(`~${Math.ceil(onward.minutes)}m to drop-off (${onward.source}) + unload ~${Math.ceil(unload.minutes)}m (${unload.count} samples)`);
      } else return unknown('Current job stage is unknown');
      reasons.push(`Available after current work at ${dropName}`);
    } else {
      const orphan = input.invoices.some(i => i.companyId === companyId && i.status === 'open' && resolveDispatchDriver(i, [...input.drivers])?.key === driver.key);
      if (orphan) return unknown('Open invoice without a current job; availability needs review');
      const latest = jobs.filter(j => arrivalPoint(j.driverLat, j.driverLng))
        .sort((a, b) => arrivalTimestampMs(b.driverGpsAt) - arrivalTimestampMs(a.driverGpsAt))[0];
      const gpsAge = nowMs - arrivalTimestampMs(latest?.driverGpsAt);
      if (!latest || gpsAge < -60000 || gpsAge > DRIVER_GPS_MAX_AGE_MS) return unknown('No current job, but no fresh driver location; cannot estimate arrival');
      origin = arrivalPoint(latest.driverLat, latest.driverLng);
      reasons.push(`No active job; GPS ${Math.max(0, Math.floor(gpsAge / 60000))}m old`);
    }
    if (!origin) return unknown('Release location unavailable');
    const onward = await travel(origin, input.target!);
    if (!onward) return unknown('Travel to selected pickup unavailable (no road response or matching trip history)');
    reasons.push(`Then ~${Math.ceil(onward.minutes)}m to selected pickup (${onward.source}${onward.samples ? `, ${onward.samples} trips` : ''})`);
    if (queueCount) reasons.push(`${queueCount} queued assignment${queueCount === 1 ? '' : 's'} remain; this estimate assumes dispatch places this job next`);
    reasons.push('HOS and equipment suitability not verified');
    return { driverKey: driver.key, arrivalMinutes: Math.ceil(release + onward.minutes), releaseMinutes: Math.ceil(release),
      travelMinutes: Math.ceil(onward.minutes), miles: onward.miles, queueCount, confidence: 'estimated' as const, reasons };
  }));
  return result.sort((a, b) => (a.arrivalMinutes ?? Infinity) - (b.arrivalMinutes ?? Infinity)
    || (a.miles ?? Infinity) - (b.miles ?? Infinity) || a.driverKey.localeCompare(b.driverKey));
}
