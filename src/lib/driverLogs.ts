// ── Driver Logs: data engine ──────────────────────────────────────────────────
// Fetches shift bookend events (login/logout from driver_shifts) and invoice
// timeline events (depart/arrive/depart_site/close), then merges them into a
// single chronological timeline per driver per day.

import { getFirestoreDb } from './firebase';
import {
  collection, doc, getDoc, getDocs, query, where, orderBy, Timestamp,
} from 'firebase/firestore';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ShiftEvent {
  type: 'login' | 'logout';
  timestamp: string; // ISO 8601
  lat: number;
  lng: number;
  source: string;
  synthetic?: boolean;
}

export interface ShiftDoc {
  driverId: string;
  displayName: string;
  companyId: string | null;
  date: string;
  events: ShiftEvent[];
}

export interface TimelineEvent {
  type: string; // depart | arrive | depart_site | close | pause | resume | transfer
  timestamp: string;
  lat: number | null;
  lng: number | null;
  source?: string;
  locationName?: string | null;
  leg?: number;
  reason?: string;
}

export interface LogInvoice {
  id: string;
  invoiceNumber: string;
  operator: string;
  wellName: string;
  hauledTo: string;
  status: string;
  totalBBL: number;
  totalHours: number;
  commodityType: string;
  driver: string;
  companyId: string;
  timeline: TimelineEvent[];
  createdAt: any;
  closedAt: any;
}

/** Unified event for the driver's daily timeline. */
export interface UnifiedEvent {
  type: string;
  timestamp: string;
  lat: number | null;
  lng: number | null;
  source?: string;
  // Context (from invoice or shift)
  wellName?: string;
  hauledTo?: string;
  invoiceNumber?: string;
  operator?: string;
  totalBBL?: number;
  totalHours?: number;
  commodityType?: string;
  synthetic?: boolean;
  locationName?: string | null;
  leg?: number;
  reason?: string;
}

/** Per-driver daily summary. */
export interface DriverDayLog {
  driverHash: string;
  displayName: string;
  companyId?: string;
  companyName?: string;
  shiftStart: string | null;  // ISO — login time
  shiftEnd: string | null;    // ISO — logout time
  shiftSynthetic?: boolean;   // Was the logout auto-generated?
  totalLoads: number;
  totalBBL: number;
  totalHours: number;
  invoices: LogInvoice[];
  timeline: UnifiedEvent[];   // Merged + sorted chronologically
  hasShiftData: boolean;
}

// ── Data fetching ────────────────────────────────────────────────────────────

/**
 * Fetch shift docs for a list of driver hashes on a given date.
 * Doc IDs are `{driverHash}_{YYYY-MM-DD}`.
 */
export async function fetchDriverShifts(
  driverHashes: string[],
  date: string, // YYYY-MM-DD
): Promise<Map<string, ShiftDoc>> {
  const db = getFirestoreDb();
  const results = new Map<string, ShiftDoc>();

  // Batch in groups of 10 to avoid overwhelming Firestore
  const batchSize = 10;
  for (let i = 0; i < driverHashes.length; i += batchSize) {
    const batch = driverHashes.slice(i, i + batchSize);
    const promises = batch.map(async (hash) => {
      const docId = `${hash}_${date}`;
      try {
        const snap = await getDoc(doc(db, 'driver_shifts', docId));
        if (snap.exists()) {
          results.set(hash, snap.data() as ShiftDoc);
        }
      } catch (err) {
        console.warn(`[driverLogs] Failed to fetch shift for ${docId}:`, err);
      }
    });
    await Promise.all(promises);
  }

  return results;
}

/**
 * Fetch invoices for a given date range, optionally filtered by companyId.
 * Returns invoices with their timeline arrays.
 */
export async function fetchInvoicesForDate(
  date: string, // YYYY-MM-DD
  companyId?: string | null,
): Promise<LogInvoice[]> {
  const db = getFirestoreDb();

  // Build date range: start of day → end of day (UTC)
  const startOfDay = new Date(`${date}T00:00:00`);
  const endOfDay = new Date(`${date}T23:59:59.999`);

  let q;
  if (companyId) {
    q = query(
      collection(db, 'invoices'),
      where('companyId', '==', companyId),
      where('createdAt', '>=', Timestamp.fromDate(startOfDay)),
      where('createdAt', '<=', Timestamp.fromDate(endOfDay)),
      orderBy('createdAt', 'asc'),
    );
  } else {
    // WB admin — all companies
    q = query(
      collection(db, 'invoices'),
      where('createdAt', '>=', Timestamp.fromDate(startOfDay)),
      where('createdAt', '<=', Timestamp.fromDate(endOfDay)),
      orderBy('createdAt', 'asc'),
    );
  }

  const snapshot = await getDocs(q);
  return snapshot.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      invoiceNumber: data.invoiceNumber || '',
      operator: data.operator || '',
      wellName: data.wellName || '',
      hauledTo: data.hauledTo || '',
      status: data.status || 'open',
      totalBBL: data.totalBBL || 0,
      totalHours: data.totalHours || 0,
      commodityType: data.commodityType || '',
      driver: data.driver || '',
      companyId: data.companyId || '',
      timeline: data.timeline || [],
      createdAt: data.createdAt || null,
      closedAt: data.closedAt || null,
    };
  });
}

// ── Timeline building ────────────────────────────────────────────────────────

/**
 * Build a unified chronological timeline for one driver on one day.
 */
export function buildDriverTimeline(
  shift: ShiftDoc | undefined,
  invoices: LogInvoice[],
): UnifiedEvent[] {
  const events: UnifiedEvent[] = [];

  // Add shift events (login/logout)
  if (shift?.events) {
    for (const evt of shift.events) {
      events.push({
        type: evt.type,
        timestamp: evt.timestamp,
        lat: evt.lat ?? null,
        lng: evt.lng ?? null,
        source: evt.source,
        synthetic: evt.synthetic,
      });
    }
  }

  // Add invoice timeline events
  for (const inv of invoices) {
    if (!inv.timeline?.length) continue;
    for (const evt of inv.timeline) {
      events.push({
        type: evt.type,
        timestamp: evt.timestamp,
        lat: evt.lat ?? null,
        lng: evt.lng ?? null,
        source: evt.source,
        wellName: inv.wellName,
        hauledTo: inv.hauledTo,
        invoiceNumber: inv.invoiceNumber,
        operator: inv.operator,
        totalBBL: inv.totalBBL,
        totalHours: inv.totalHours,
        commodityType: inv.commodityType,
        locationName: evt.locationName,
        leg: evt.leg,
        reason: evt.reason,
      });
    }
  }

  // Sort chronologically
  events.sort((a, b) => {
    const tA = new Date(a.timestamp).getTime() || 0;
    const tB = new Date(b.timestamp).getTime() || 0;
    return tA - tB;
  });

  return events;
}

/**
 * Build per-driver daily logs from shift + invoice data.
 * Matches invoices to drivers by displayName.
 */
export function buildDriverDayLogs(
  drivers: { key: string; displayName: string; companyId?: string; companyName?: string }[],
  shifts: Map<string, ShiftDoc>,
  invoices: LogInvoice[],
): DriverDayLog[] {
  const logs: DriverDayLog[] = [];

  for (const driver of drivers) {
    const shift = shifts.get(driver.key);
    const driverInvoices = invoices.filter(
      (inv) => inv.driver === driver.displayName,
    );

    // Skip drivers with no activity
    if (!shift && driverInvoices.length === 0) continue;

    const timeline = buildDriverTimeline(shift, driverInvoices);

    // Extract shift bookends
    const loginEvent = shift?.events?.find((e) => e.type === 'login');
    const logoutEvent = shift?.events?.find((e) => e.type === 'logout');

    // Count loads: each closed invoice = 1 load
    const totalLoads = driverInvoices.filter((i) => i.status === 'closed' || i.status === 'submitted' || i.status === 'approved' || i.status === 'paid').length;
    const totalBBL = driverInvoices.reduce((sum, i) => sum + i.totalBBL, 0);
    const totalHours = driverInvoices.reduce((sum, i) => sum + i.totalHours, 0);

    logs.push({
      driverHash: driver.key,
      displayName: driver.displayName,
      companyId: driver.companyId,
      companyName: driver.companyName,
      shiftStart: loginEvent?.timestamp || null,
      shiftEnd: logoutEvent?.timestamp || null,
      shiftSynthetic: logoutEvent?.synthetic,
      totalLoads,
      totalBBL,
      totalHours,
      invoices: driverInvoices,
      timeline,
      hasShiftData: !!shift,
    });
  }

  // Sort: drivers with activity first, then alphabetically
  logs.sort((a, b) => {
    // Active shifts first (has login, no logout yet)
    const aActive = a.shiftStart && !a.shiftEnd ? 1 : 0;
    const bActive = b.shiftStart && !b.shiftEnd ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    // Then by name
    return a.displayName.localeCompare(b.displayName);
  });

  return logs;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Format ISO timestamp to 12hr time string. */
export function formatTime12h(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    let hours = d.getHours();
    const mins = d.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${hours}:${String(mins).padStart(2, '0')} ${ampm}`;
  } catch {
    return '';
  }
}

/** Calculate duration between two ISO timestamps in human-readable form. */
export function formatDuration(startIso: string, endIso: string): string {
  try {
    const start = new Date(startIso).getTime();
    const end = new Date(endIso).getTime();
    if (isNaN(start) || isNaN(end)) return '';
    const diffMs = end - start;
    if (diffMs < 0) return '';
    const hours = Math.floor(diffMs / 3600000);
    const mins = Math.floor((diffMs % 3600000) / 60000);
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  } catch {
    return '';
  }
}

/** Get a human-readable label for a timeline event type. */
export function getEventLabel(evt: UnifiedEvent): string {
  switch (evt.type) {
    case 'login':
      return 'Shift Start';
    case 'logout':
      return evt.synthetic ? 'Shift End (auto)' : 'Shift End';
    case 'depart':
      return evt.wellName ? `Departed for ${evt.wellName}` : 'Departed';
    case 'arrive':
      return evt.locationName || evt.wellName
        ? `Arrived at ${evt.locationName || evt.wellName}`
        : 'Arrived';
    case 'depart_site':
      return evt.locationName
        ? `Left ${evt.locationName}`
        : evt.hauledTo
          ? `Left for ${evt.hauledTo}`
          : 'Left site';
    case 'close':
      return evt.invoiceNumber ? `Closed Job ${evt.invoiceNumber}` : 'Closed Job';
    case 'pause':
      return evt.reason ? `Paused (${evt.reason})` : 'Paused';
    case 'resume':
      return 'Resumed';
    case 'transfer':
      return 'Load Transferred';
    case 'reroute':
      return 'Rerouted';
    default:
      return evt.type;
  }
}

/** Get color class for event type. */
export function getEventColor(type: string): string {
  switch (type) {
    case 'login': return 'text-green-400';
    case 'logout': return 'text-red-400';
    case 'depart': return 'text-blue-400';
    case 'arrive': return 'text-cyan-400';
    case 'depart_site': return 'text-yellow-400';
    case 'close': return 'text-gray-400';
    case 'pause': return 'text-orange-400';
    case 'resume': return 'text-green-400';
    case 'transfer': return 'text-purple-400';
    default: return 'text-gray-500';
  }
}

/** Get dot/icon color for event type (for timeline connector). */
export function getEventDotColor(type: string): string {
  switch (type) {
    case 'login': return 'bg-green-500';
    case 'logout': return 'bg-red-500';
    case 'depart': return 'bg-blue-500';
    case 'arrive': return 'bg-cyan-500';
    case 'depart_site': return 'bg-yellow-500';
    case 'close': return 'bg-gray-500';
    case 'pause': return 'bg-orange-500';
    case 'resume': return 'bg-green-500';
    case 'transfer': return 'bg-purple-500';
    default: return 'bg-gray-600';
  }
}
