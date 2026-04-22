import type { OperationalEvent, SourceRef } from './types';
import type { ShiftDocInput } from './buildSessionView';
import type { BuildJSAViewInput } from './buildJSAView';
import { normalizeLocationName } from './normalizeLocation';

export interface InvoiceTimelineEvent {
  type?: string;
  timestamp?: string;
  lat?: number;
  lng?: number;
  wellName?: string;
  hauledTo?: string;
}

export interface InvoiceInput {
  id?: string;
  driver?: string;
  driverHash?: string;
  driverId?: string;
  wellName?: string;
  hauledTo?: string;
  commodityType?: string;
  timeline?: InvoiceTimelineEvent[];
}

export interface DispatchInput {
  id?: string;
  jobId?: string;
  driverHash?: string;
  driverId?: string;
  wellName?: string;
  ndicWellName?: string;
  disposal?: string;
  disposalName?: string;
  jobType?: string;
  serviceType?: string;
  commodityType?: string;
  status?: string;
  assignedAt?: string;
  completedAt?: string;
  stageUpdatedAt?: string;
  updatedAt?: string;
}

export interface ProductionInput {
  wellKey?: string;
  wellName?: string;
  date?: string;
  updatedAt?: string;
  pullCount?: number;
}

export interface ExtractEventsInput {
  shifts?: ShiftDocInput[];
  invoices?: InvoiceInput[];
  dispatches?: DispatchInput[];
  jsas?: BuildJSAViewInput[];
  production?: ProductionInput[];
}

function opKey(id?: string): string | undefined {
  return id ? `op:${id}` : undefined;
}

function locKey(name?: string): string | undefined {
  if (!name || !name.trim()) return undefined;
  return `loc:${normalizeLocationName(name)}`;
}

const INVOICE_EVENT_MAP: Record<string, OperationalEvent['eventType']> = {
  depart: 'departure',
  arrive: 'arrival',
  depart_site: 'pickup',
  close: 'dropoff',
  accept: 'dispatch_status',
};

export function extractOperationalEvents(
  input: ExtractEventsInput
): OperationalEvent[] {
  const events: OperationalEvent[] = [];

  for (const shift of input.shifts ?? []) {
    const driverId = shift.driverId ?? shift.driverHash;
    if (!driverId) continue;
    const operatorKey = opKey(driverId);
    const recordId = shift.date ? `${driverId}_${shift.date}` : driverId;
    const baseRef: SourceRef = {
      system: 'firestore',
      path: 'driver_shifts',
      recordId,
      field: 'events',
    };
    for (const e of shift.events ?? []) {
      if (!e.timestamp) continue;
      let et: OperationalEvent['eventType'] = 'unknown';
      if (e.type === 'login') et = 'login';
      else if (e.type === 'logout') et = 'logout';
      else continue;
      const ev: OperationalEvent = {
        eventKey: `evt:${et}:${driverId}:${e.timestamp}`,
        eventType: et,
        occurredAt: e.timestamp,
        sourceRefs: [baseRef],
      };
      if (operatorKey) ev.operatorKey = operatorKey;
      const payload: Record<string, unknown> = {};
      if (e.lat !== undefined) payload.lat = e.lat;
      if (e.lng !== undefined) payload.lng = e.lng;
      if (e.source) payload.source = e.source;
      if (e.synthetic) payload.synthetic = e.synthetic;
      if (Object.keys(payload).length > 0) ev.payload = payload;
      events.push(ev);
    }
  }

  for (const inv of input.invoices ?? []) {
    const driverRef = inv.driverHash ?? inv.driverId;
    const operatorKey = opKey(driverRef);
    const recordId = inv.id;
    const baseRef: SourceRef = {
      system: 'firestore',
      path: 'invoices',
      field: 'timeline',
    };
    if (recordId !== undefined) baseRef.recordId = recordId;
    for (const t of inv.timeline ?? []) {
      if (!t.timestamp || !t.type) continue;
      const mapped = INVOICE_EVENT_MAP[t.type];
      if (!mapped) continue;
      const pickupDropoffLocation =
        t.type === 'arrive' || t.type === 'depart' || t.type === 'depart_site'
          ? t.wellName ?? inv.wellName
          : t.type === 'close'
          ? t.hauledTo ?? inv.hauledTo
          : undefined;
      const ev: OperationalEvent = {
        eventKey: `evt:${mapped}:${recordId ?? 'noid'}:${t.timestamp}`,
        eventType: mapped,
        occurredAt: t.timestamp,
        sourceRefs: [baseRef],
      };
      if (operatorKey) ev.operatorKey = operatorKey;
      const locationKey = locKey(pickupDropoffLocation);
      if (locationKey) ev.locationKey = locationKey;
      if (recordId) ev.relatedRecordId = recordId;
      const payload: Record<string, unknown> = { rawType: t.type };
      if (t.lat !== undefined) payload.lat = t.lat;
      if (t.lng !== undefined) payload.lng = t.lng;
      if (pickupDropoffLocation) payload.locationName = pickupDropoffLocation;
      ev.payload = payload;
      events.push(ev);
    }
  }

  for (const disp of input.dispatches ?? []) {
    const id = disp.id ?? disp.jobId;
    const driverRef = disp.driverHash ?? disp.driverId;
    const operatorKey = opKey(driverRef);
    const recordId = id;
    const baseRef: SourceRef = {
      system: 'firestore',
      path: 'dispatches',
    };
    if (recordId !== undefined) baseRef.recordId = recordId;
    const ts =
      disp.completedAt ?? disp.stageUpdatedAt ?? disp.updatedAt ?? disp.assignedAt;
    const ev: OperationalEvent = {
      eventKey: `evt:dispatch_status:${id ?? 'noid'}:${disp.status ?? 'unknown'}:${ts ?? ''}`,
      eventType: 'dispatch_status',
      sourceRefs: [baseRef],
    };
    if (ts) ev.occurredAt = ts;
    if (operatorKey) ev.operatorKey = operatorKey;
    const wellName = disp.wellName ?? disp.ndicWellName;
    const locationKey = locKey(wellName);
    if (locationKey) ev.locationKey = locationKey;
    if (id) ev.relatedRecordId = id;
    const payload: Record<string, unknown> = {};
    if (disp.status) payload.status = disp.status;
    if (disp.jobType) payload.jobType = disp.jobType;
    if (disp.commodityType) payload.commodityType = disp.commodityType;
    if (disp.disposal || disp.disposalName) payload.disposal = disp.disposal ?? disp.disposalName;
    if (Object.keys(payload).length > 0) ev.payload = payload;
    events.push(ev);
  }

  for (const jsa of input.jsas ?? []) {
    const operatorKey = opKey(jsa.driverHash);
    const baseRef: SourceRef = {
      system: jsa.sourceSystem ?? 'firestore',
      path: jsa.sourceRecordPath ?? 'jsa_day_status',
    };
    if (jsa.id !== undefined) baseRef.recordId = jsa.id;
    if (jsa.jsaCompleted) {
      const ts = jsa.timestamp ?? jsa.date;
      const ev: OperationalEvent = {
        eventKey: `evt:jsa_completed:${jsa.driverHash ?? 'noid'}:${ts ?? ''}`,
        eventType: 'jsa_completed',
        sourceRefs: [baseRef],
      };
      if (ts) ev.occurredAt = ts;
      if (operatorKey) ev.operatorKey = operatorKey;
      if (jsa.id) ev.relatedRecordId = jsa.id;
      const payload: Record<string, unknown> = {};
      if (jsa.pdfUrl) payload.pdfUrl = jsa.pdfUrl;
      if (jsa.signature) payload.signatureName = jsa.signature;
      if (Object.keys(payload).length > 0) ev.payload = payload;
      events.push(ev);
    }
    for (const s of jsa.locationStamps ?? []) {
      if (!s.name) continue;
      const locationKey = locKey(s.name);
      const ts = s.stampedAt;
      const ev: OperationalEvent = {
        eventKey: `evt:location_stamped:${jsa.driverHash ?? 'noid'}:${s.name}:${ts ?? ''}`,
        eventType: 'location_stamped',
        sourceRefs: [baseRef],
      };
      if (ts) ev.occurredAt = ts;
      if (operatorKey) ev.operatorKey = operatorKey;
      if (locationKey) ev.locationKey = locationKey;
      if (s.dispatchId) ev.relatedRecordId = s.dispatchId;
      const payload: Record<string, unknown> = { name: s.name };
      if (s.type) payload.pickupDropoffType = s.type;
      if (s.jobType) payload.jobType = s.jobType;
      if (s.dispatchId) payload.dispatchId = s.dispatchId;
      ev.payload = payload;
      events.push(ev);
    }
    for (const loc of jsa.locations ?? []) {
      if (typeof loc !== 'object' || !loc || !loc.name) continue;
      const locationKey = locKey(loc.name);
      const ts = loc.stampedAt;
      const ev: OperationalEvent = {
        eventKey: `evt:location_stamped:${jsa.driverHash ?? 'noid'}:${loc.name}:${ts ?? ''}`,
        eventType: 'location_stamped',
        sourceRefs: [baseRef],
      };
      if (ts) ev.occurredAt = ts;
      if (operatorKey) ev.operatorKey = operatorKey;
      if (locationKey) ev.locationKey = locationKey;
      if (loc.dispatchId) ev.relatedRecordId = loc.dispatchId;
      const payload: Record<string, unknown> = { name: loc.name };
      if (loc.type) payload.pickupDropoffType = loc.type;
      if (loc.jobType) payload.jobType = loc.jobType;
      if (loc.dispatchId) payload.dispatchId = loc.dispatchId;
      ev.payload = payload;
      events.push(ev);
    }
  }

  for (const p of input.production ?? []) {
    if (!p.date) continue;
    const locationKey = locKey(p.wellName ?? p.wellKey);
    const baseRef: SourceRef = {
      system: 'rtdb',
      path: 'production',
    };
    if (p.wellKey !== undefined && p.date !== undefined) {
      baseRef.recordId = `${p.wellKey}/${p.date}`;
    }
    const ev: OperationalEvent = {
      eventKey: `evt:production_recorded:${p.wellKey ?? p.wellName ?? 'noid'}:${p.date}`,
      eventType: 'production_recorded',
      sourceRefs: [baseRef],
    };
    if (p.updatedAt) ev.occurredAt = p.updatedAt;
    if (locationKey) ev.locationKey = locationKey;
    const payload: Record<string, unknown> = { date: p.date };
    if (p.pullCount !== undefined) payload.pullCount = p.pullCount;
    if (p.wellName) payload.wellName = p.wellName;
    ev.payload = payload;
    events.push(ev);
  }

  return events.sort((a, b) => {
    // Coerce to string defensively. Upstream sources sometimes hand us a
    // number (unix-ms) or Date for occurredAt even though the type says
    // string, which would crash .localeCompare with a cryptic TypeError.
    const ta = String(a.occurredAt ?? '');
    const tb = String(b.occurredAt ?? '');
    if (ta !== tb) return ta.localeCompare(tb);
    return String(a.eventKey ?? '').localeCompare(String(b.eventKey ?? ''));
  });
}
