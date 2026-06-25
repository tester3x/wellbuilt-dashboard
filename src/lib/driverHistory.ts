// Driver history probe — READ-ONLY existence checks used to gate hard-delete.
//
// A driver hash is referenced by several collections. Before an admin can hard-
// delete a `drivers/approved/{hash}` record we probe every one of them so we
// never destroy a driver who has real operational history (tickets, invoices,
// JSA, shifts, dispatches, canonical jobs) or a linked dashboard account.
//
// These are `limit(1)` existence queries — cheap, and they NEVER write or
// delete anything. Field mapping verified against live data:
//   tickets        .driverId    = hash
//   invoices       .driverHash  = hash
//   canonical_jobs .driverHash  = hash
//   jsa_day_status .driverHash  = hash
//   dispatches     .driverHash  = hash
//   driver_shifts  .driverId    = hash
import { getFirestoreDb } from './firebase';
import { collection, query, where, limit, getDocs } from 'firebase/firestore';

export interface DriverHistorySummary {
  hasAny: boolean;
  tickets: boolean;
  invoices: boolean;
  canonicalJobs: boolean;
  jsa: boolean;
  dispatches: boolean;
  shifts: boolean;
  dashboardLink: boolean;
  /** True when one or more probes threw — caller should treat as "history present" (fail safe). */
  probeError: boolean;
}

const PROBES: Array<{ key: keyof Omit<DriverHistorySummary, 'hasAny' | 'dashboardLink' | 'probeError'>; col: string; field: string }> = [
  { key: 'tickets', col: 'tickets', field: 'driverId' },
  { key: 'invoices', col: 'invoices', field: 'driverHash' },
  { key: 'canonicalJobs', col: 'canonical_jobs', field: 'driverHash' },
  { key: 'jsa', col: 'jsa_day_status', field: 'driverHash' },
  { key: 'dispatches', col: 'dispatches', field: 'driverHash' },
  { key: 'shifts', col: 'driver_shifts', field: 'driverId' },
];

export async function probeDriverHistory(
  hash: string,
  dashboardUid?: string | null,
): Promise<DriverHistorySummary> {
  const fs = getFirestoreDb();
  let probeError = false;

  const results = await Promise.all(
    PROBES.map(async (p) => {
      try {
        const snap = await getDocs(query(collection(fs, p.col), where(p.field, '==', hash), limit(1)));
        return { key: p.key, exists: !snap.empty };
      } catch (err) {
        console.error(`[driverHistory] probe failed for ${p.col}:`, err);
        probeError = true;
        return { key: p.key, exists: false };
      }
    }),
  );

  const summary: DriverHistorySummary = {
    hasAny: false,
    tickets: false,
    invoices: false,
    canonicalJobs: false,
    jsa: false,
    dispatches: false,
    shifts: false,
    dashboardLink: !!dashboardUid,
    probeError,
  };
  results.forEach((r) => { summary[r.key] = r.exists; });

  summary.hasAny =
    probeError ||
    summary.dashboardLink ||
    summary.tickets ||
    summary.invoices ||
    summary.canonicalJobs ||
    summary.jsa ||
    summary.dispatches ||
    summary.shifts;

  return summary;
}
