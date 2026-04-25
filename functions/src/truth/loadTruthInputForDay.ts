import * as admin from 'firebase-admin';
import type { BuildTruthProjectionInput } from '../truth-layer/buildTruthProjection';
import type {
  NdicEntry,
  WellConfigEntry,
} from '../truth-layer/normalizeLocation';

export interface LoadTruthInputForDayParams {
  date: string; // YYYY-MM-DD
  companyId?: string; // optional scope (WB admin when absent)
}

export interface LoadTruthInputForDayResult {
  input: BuildTruthProjectionInput;
  sourceErrors: string[];
  loaded: {
    drivers: number;
    shifts: number;
    invoices: number;
    dispatches: number;
    jsas: number;
    /**
     * Number of entries in the location catalog (well_config → NDIC / wellConfig).
     * Not shown in the current UI summary grid — call it out in sourceErrors or
     * read it programmatically if you need it. Optional so existing consumers
     * that destructure `loaded` don't break.
     */
    catalog?: number;
  };
}

type AnyRecord = Record<string, unknown>;

function isObject(v: unknown): v is AnyRecord {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function readTimelineFromInvoice(data: AnyRecord): unknown[] {
  const t = data['timeline'];
  return Array.isArray(t) ? t : [];
}

export async function loadTruthInputForDay(
  params: LoadTruthInputForDayParams
): Promise<LoadTruthInputForDayResult> {
  const { date, companyId } = params;
  const sourceErrors: string[] = [];

  // Parse date once for Firestore Timestamp range filtering on invoices.createdAt.
  // Boundaries are UTC so the query is deterministic regardless of server tz;
  // driver_shifts / jsa_day_status use docId-suffix filtering, not this range.
  const startOfDay = new Date(`${date}T00:00:00.000Z`);
  const endOfDay = new Date(`${date}T23:59:59.999Z`);

  const db = admin.database();
  const firestore = admin.firestore();

  const input: BuildTruthProjectionInput = {};
  const loaded: LoadTruthInputForDayResult['loaded'] = {
    drivers: 0,
    shifts: 0,
    invoices: 0,
    dispatches: 0,
    jsas: 0,
  };

  // ── drivers (RTDB drivers/approved) ──────────────────────────────────────
  try {
    const snap = await db.ref('drivers/approved').once('value');
    if (snap.exists()) {
      const raw = snap.val() as Record<string, unknown>;
      const drivers: unknown[] = [];
      for (const [hash, entry] of Object.entries(raw)) {
        if (!isObject(entry)) continue;
        if (companyId) {
          // Flat shape: entry has companyId at top level.
          const flatCompanyId = (entry as AnyRecord)['companyId'];
          if (
            typeof flatCompanyId === 'string' &&
            flatCompanyId !== companyId
          ) {
            continue;
          }
        }
        drivers.push({ hash, ...(entry as AnyRecord) });
      }
      input.drivers = drivers;
      loaded.drivers = drivers.length;
    }
  } catch (e) {
    sourceErrors.push(`drivers: ${(e as Error).message}`);
  }

  // ── shifts (Firestore driver_shifts, docId = {hash}_{YYYY-MM-DD}) ────────
  try {
    const shiftsSnap = await firestore
      .collection('driver_shifts')
      .where(admin.firestore.FieldPath.documentId(), '>=', `_${date}`)
      .get()
      .catch(async () => {
        // Fallback if the docId range query rejects — iterate all docs whose
        // id ends with `_${date}`. This is only used as a safety net.
        return firestore.collection('driver_shifts').get();
      });
    const suffix = `_${date}`;
    const shiftDocs: unknown[] = [];
    shiftsSnap.forEach((doc) => {
      if (!doc.id.endsWith(suffix)) return;
      const data = doc.data();
      if (companyId && data.companyId && data.companyId !== companyId) return;
      shiftDocs.push({ ...data });
    });
    input.shifts = shiftDocs as BuildTruthProjectionInput['shifts'];
    loaded.shifts = shiftDocs.length;
  } catch (e) {
    sourceErrors.push(`shifts: ${(e as Error).message}`);
  }

  // ── invoices (Firestore invoices, filtered by createdAt range) ───────────
  try {
    let query = firestore
      .collection('invoices')
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(startOfDay))
      .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(endOfDay));
    if (companyId) {
      query = query.where('companyId', '==', companyId);
    }
    const snap = await query.get();
    const invoices: unknown[] = [];
    snap.forEach((doc) => {
      const data = doc.data();
      // Normalize createdAt to ISO so the week-summary / ticket surface
      // doesn't hand back Firestore Timestamp objects (which stringify to
      // `[object Object]` for naive consumers).
      const createdAt = (() => {
        const ca = data['createdAt'] as unknown;
        if (!ca) return undefined;
        if (typeof ca === 'string') return ca;
        if (typeof (ca as { toDate?: () => Date }).toDate === 'function') {
          return (ca as { toDate: () => Date }).toDate().toISOString();
        }
        return undefined;
      })();
      const tickets = Array.isArray(data['tickets'])
        ? (data['tickets'] as unknown[]).filter(isObject).map((t) => {
            const tt = t as AnyRecord;
            const ticketCreated = (() => {
              const ca = tt['createdAt'];
              if (typeof ca === 'string') return ca;
              if (ca && typeof (ca as { toDate?: () => Date }).toDate === 'function') {
                return (ca as { toDate: () => Date }).toDate().toISOString();
              }
              return undefined;
            })();
            const out: AnyRecord = {};
            if (tt['ticketNumber'] !== undefined) out['ticketNumber'] = tt['ticketNumber'];
            if (typeof tt['wellName'] === 'string') out['wellName'] = tt['wellName'];
            if (typeof tt['hauledTo'] === 'string') out['hauledTo'] = tt['hauledTo'];
            if (typeof tt['bbl'] === 'number') out['bbl'] = tt['bbl'];
            if (typeof tt['totalBBL'] === 'number') out['totalBBL'] = tt['totalBBL'];
            if (typeof tt['commodityType'] === 'string') out['commodityType'] = tt['commodityType'];
            if (ticketCreated) out['createdAt'] = ticketCreated;
            return out;
          })
        : [];
      const row: AnyRecord = {
        id: doc.id,
        driver: data['driver'],
        driverHash: data['driverHash'],
        wellName: data['wellName'],
        hauledTo: data['hauledTo'],
        commodityType: data['commodityType'],
        timeline: readTimelineFromInvoice(data),
        tickets,
      };
      if (typeof data['totalBBL'] === 'number') row['totalBBL'] = data['totalBBL'];
      if (data['ticketNumber'] !== undefined) row['ticketNumber'] = data['ticketNumber'];
      if (data['invoiceNumber'] !== undefined) row['invoiceNumber'] = data['invoiceNumber'];
      if (typeof data['status'] === 'string') row['status'] = data['status'];
      if (createdAt) row['createdAt'] = createdAt;
      invoices.push(row);
    });
    input.invoices = invoices as BuildTruthProjectionInput['invoices'];
    loaded.invoices = invoices.length;
  } catch (e) {
    sourceErrors.push(`invoices: ${(e as Error).message}`);
  }

  // ── dispatches (Firestore dispatches, filtered by assignedAt range) ──────
  try {
    let query = firestore
      .collection('dispatches')
      .where(
        'assignedAt',
        '>=',
        admin.firestore.Timestamp.fromDate(startOfDay)
      )
      .where('assignedAt', '<=', admin.firestore.Timestamp.fromDate(endOfDay));
    if (companyId) {
      query = query.where('companyId', '==', companyId);
    }
    const snap = await query.get();
    const dispatches: unknown[] = [];
    snap.forEach((doc) => {
      const data = doc.data();
      dispatches.push({ id: doc.id, ...data });
    });
    input.dispatches = dispatches as BuildTruthProjectionInput['dispatches'];
    loaded.dispatches = dispatches.length;
  } catch (e) {
    sourceErrors.push(`dispatches: ${(e as Error).message}`);
  }

  // ── jsas (Firestore jsa_day_status, docId = {hash}_{YYYY-MM-DD}) ─────────
  try {
    const jsaSnap = await firestore.collection('jsa_day_status').get();
    const suffix = `_${date}`;
    const jsas: unknown[] = [];
    jsaSnap.forEach((doc) => {
      if (!doc.id.endsWith(suffix)) return;
      const data = doc.data();
      if (companyId && data.companyId && data.companyId !== companyId) return;
      jsas.push({ id: doc.id, ...data });
    });
    input.jsas = jsas as BuildTruthProjectionInput['jsas'];
    loaded.jsas = jsas.length;
  } catch (e) {
    sourceErrors.push(`jsas: ${(e as Error).message}`);
  }

  // ── catalog: well_config (RTDB, shared across companies) ────────────────
  // Each well_config/{ShortName} entry may have an `ndicName` field carrying
  // the full NDIC well name (e.g. "GABRIEL 1-36-25H"). Drivers type invoice
  // wellName as either the short form (config key, "Gabriel 1") or the long
  // NDIC form, so we emit BOTH as catalog entries and let the truth-layer's
  // normalized-name matcher pick whichever form the data uses.
  //
  // Entries with an ndicName go into `ndic` (strong, NDIC-backed).
  // Entries without an ndicName go into `wellConfig` (medium, configured).
  // SWD directory (per-company Firestore collection) is intentionally not
  // loaded in this pass — that's a separate catalog surface.
  try {
    const snap = await db.ref('well_config').once('value');
    if (snap.exists()) {
      const raw = snap.val() as Record<string, unknown>;
      const ndic: NdicEntry[] = [];
      const wellConfig: WellConfigEntry[] = [];
      // Plain-object dedupe — intentional, not a Set. Phase 6's read-only
      // loader source-inspection test greps this file for Firestore-write
      // method names to confirm the loader is side-effect-free.
      const seen: Record<string, true> = {};
      const normalize = (s: string): string =>
        s.toLowerCase().trim().replace(/_/g, ' ').replace(/\s+/g, ' ');

      for (const [wellKey, entry] of Object.entries(raw)) {
        if (!isObject(entry)) continue;
        const ndicNameRaw = (entry as AnyRecord)['ndicName'];
        const ndicName =
          typeof ndicNameRaw === 'string' && ndicNameRaw.trim().length > 0
            ? ndicNameRaw.trim()
            : undefined;

        const keyNorm = normalize(wellKey);
        if (keyNorm && !seen[keyNorm]) {
          seen[keyNorm] = true;
          if (ndicName !== undefined) {
            ndic.push({ name: wellKey });
          } else {
            wellConfig.push({ name: wellKey });
          }
        }

        if (ndicName !== undefined) {
          const ndicNorm = normalize(ndicName);
          if (ndicNorm && !seen[ndicNorm]) {
            seen[ndicNorm] = true;
            ndic.push({ name: ndicName });
          }
        }
      }

      if (ndic.length > 0 || wellConfig.length > 0) {
        input.catalog = {};
        if (ndic.length > 0) input.catalog.ndic = ndic;
        if (wellConfig.length > 0) input.catalog.wellConfig = wellConfig;
        loaded.catalog = ndic.length + wellConfig.length;
      }
    }
  } catch (e) {
    sourceErrors.push(`well_config: ${(e as Error).message}`);
  }

  return { input, sourceErrors, loaded };
}
