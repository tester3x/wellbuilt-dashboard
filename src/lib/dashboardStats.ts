// Dashboard V1 "At a Glance" aggregation.
//
// Derives operational totals from existing canonical sources — no new
// collections. tickets = operational counts (1 ticket = 1 load, works for
// both invoice_tickets and ticket_only companies). RTDB well_config =
// maintained-well / route inventory. dispatches = open jobs.
//
// A single month-scoped tickets query powers TODAY + MONTH + TOP + RECENT;
// today is derived by filtering that same set client-side. Three reads total
// (tickets, dispatches, well_config). This is intentionally NOT a reporting
// engine — keep it small.

import { getFirestoreDb, getFirebaseDatabase } from './firebase';
import { collection, getDocs, query, where, orderBy, Timestamp } from 'firebase/firestore';
import { ref, get } from 'firebase/database';

const OPEN_DISPATCH_STATUSES = [
  'pending',
  'pending_approval',
  'accepted',
  'in_progress',
  'paused',
];

export interface TopEntry {
  name: string;
  bbl: number;
  loads: number;
}

export interface RecentEntry {
  ticketNumber: string;
  well: string;
  driver: string;
  bbl: number;
  createdAt: Date | null;
}

export interface DashboardStats {
  today: {
    loads: number;
    bbl: number;
    openJobs: number;
    driversWorking: number;
    wellsPulled: number;
  };
  month: {
    loads: number;
    bbl: number;
    avgBblPerLoad: number;
    activeMaintainedWells: number;
  };
  topWells: TopEntry[];
  topDrivers: TopEntry[];
  recent: RecentEntry[];
  snapshot: {
    maintainedWells: number;
    unrouted: number;
    routeCount: number;
  };
}

/** Parse a ticket's BBL value (string field, may be empty/non-numeric). */
function parseBbl(raw: unknown): number {
  const n = parseFloat(String(raw ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fetch all At-a-Glance stats for the given company.
 * @param companyId scope to one company; null/undefined = all companies (WB admin).
 */
export async function fetchDashboardStats(companyId?: string | null): Promise<DashboardStats> {
  const db = getFirestoreDb();

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

  // ── Tickets for the current month (powers TODAY + MONTH + TOP + RECENT) ──
  const ticketsQ = query(
    collection(db, 'tickets'),
    where('createdAt', '>=', Timestamp.fromDate(monthStart)),
    orderBy('createdAt', 'desc'),
  );

  let ticketDocs: Array<Record<string, unknown>> = [];
  try {
    const snap = await getDocs(ticketsQ);
    ticketDocs = snap.docs.map(d => d.data() as Record<string, unknown>);
  } catch {
    // createdAt index missing or query failed — leave empty rather than throw.
    ticketDocs = [];
  }

  // Company scope + drop voided tickets.
  const tickets = ticketDocs.filter(d => {
    if ((d.status as string) === 'void') return false;
    if (companyId && d.companyId && d.companyId !== companyId) return false;
    return true;
  });

  // Month aggregates
  let monthLoads = 0;
  let monthBbl = 0;
  const wellAgg = new Map<string, TopEntry>();
  const driverAgg = new Map<string, TopEntry>();

  // Today aggregates
  let todayLoads = 0;
  let todayBbl = 0;
  const todayWells = new Set<string>();
  const todayDrivers = new Set<string>();

  const recent: RecentEntry[] = [];

  for (const d of tickets) {
    const bbl = parseBbl(d.bbls ?? d.qty);
    const well = String((d.location as string) || (d as Record<string, unknown>).wellName || '').trim();
    const driver = String((d.driver as string) || '').trim();
    const createdAt = (d.createdAt as { toDate?: () => Date })?.toDate?.() ?? null;

    monthLoads += 1;
    monthBbl += bbl;

    if (well) {
      const w = wellAgg.get(well) || { name: well, bbl: 0, loads: 0 };
      w.bbl += bbl;
      w.loads += 1;
      wellAgg.set(well, w);
    }
    if (driver) {
      const dr = driverAgg.get(driver) || { name: driver, bbl: 0, loads: 0 };
      dr.bbl += bbl;
      dr.loads += 1;
      driverAgg.set(driver, dr);
    }

    if (createdAt && createdAt >= todayStart) {
      todayLoads += 1;
      todayBbl += bbl;
      if (well) todayWells.add(well);
      if (driver) todayDrivers.add(driver);
    }

    if (recent.length < 10) {
      recent.push({
        ticketNumber: String((d.ticketNumber as string) || ''),
        well,
        driver,
        bbl,
        createdAt,
      });
    }
  }

  const topWells = Array.from(wellAgg.values())
    .sort((a, b) => b.bbl - a.bbl)
    .slice(0, 5);
  const topDrivers = Array.from(driverAgg.values())
    .sort((a, b) => b.bbl - a.bbl)
    .slice(0, 5);

  // ── Open jobs from dispatches ──
  let openJobs = 0;
  try {
    const dispQ = query(
      collection(db, 'dispatches'),
      where('status', 'in', OPEN_DISPATCH_STATUSES),
    );
    const dispSnap = await getDocs(dispQ);
    openJobs = dispSnap.docs.filter(ds => {
      const d = ds.data() as Record<string, unknown>;
      if (companyId && d.companyId && d.companyId !== companyId) return false;
      return true;
    }).length;
  } catch {
    openJobs = 0;
  }

  // ── Maintained-well / route inventory from RTDB well_config ──
  // well_config is keyed by well name and not company-scoped, so these counts
  // are global for V1 (matches existing home-page well counting).
  let maintainedWells = 0;
  let unrouted = 0;
  let routeCount = 0;
  try {
    const rtdb = getFirebaseDatabase();
    const snap = await get(ref(rtdb, 'well_config'));
    if (snap.exists()) {
      const data = snap.val() as Record<string, { route?: string }>;
      const routeSet = new Set<string>();
      for (const cfg of Object.values(data)) {
        maintainedWells += 1;
        const route = cfg?.route || 'Unrouted';
        if (route === 'Unrouted') unrouted += 1;
        routeSet.add(route);
      }
      routeCount = routeSet.size;
    }
  } catch {
    // leave zeros
  }

  return {
    today: {
      loads: todayLoads,
      bbl: Math.round(todayBbl * 100) / 100,
      openJobs,
      driversWorking: todayDrivers.size,
      wellsPulled: todayWells.size,
    },
    month: {
      loads: monthLoads,
      bbl: Math.round(monthBbl * 100) / 100,
      avgBblPerLoad: monthLoads > 0 ? Math.round((monthBbl / monthLoads) * 10) / 10 : 0,
      activeMaintainedWells: maintainedWells,
    },
    topWells,
    topDrivers,
    recent,
    snapshot: {
      maintainedWells,
      unrouted,
      routeCount,
    },
  };
}
