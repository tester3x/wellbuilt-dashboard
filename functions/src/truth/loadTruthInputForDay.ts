import * as admin from 'firebase-admin';
import type { BuildTruthProjectionInput } from '../truth-layer/buildTruthProjection';

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
  const loaded = { drivers: 0, shifts: 0, invoices: 0, dispatches: 0, jsas: 0 };

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
      invoices.push({
        id: doc.id,
        driver: data.driver,
        driverHash: data.driverHash,
        wellName: data.wellName,
        hauledTo: data.hauledTo,
        commodityType: data.commodityType,
        timeline: readTimelineFromInvoice(data),
      });
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

  return { input, sourceErrors, loaded };
}
