// editProduction.ts — cross-production-date recomputation for canonical edits
// (predeploy gate Blocker 1). When an edit moves a pull's event time across a
// production-date boundary, the OLD date's bucket must drop the pull and the
// NEW date's bucket must gain it — both recomputed from AUTHORITATIVE surviving
// rows (count-based `n`, never a blind ±1, so it is replay-safe / drift-free),
// with a/w/o reflecting the actual latest pull on each date. Same-date edits
// recompute the single affected bucket. Historical stored tank bottoms on OTHER
// rows are never touched here.
import {
  calculateOvernightBblsPerDay,
  calculateWindowBblsPerDay,
  getProductionDate,
  type HistoricalPull,
} from './productionFormulas';
import { computeAFRFromRates } from './pullFormulas';

export interface EditProdRow {
  key: string;
  ms: number;
  flowRateDays: number;
  tankLevelFeet: number;
  bblsTaken: number;
  wellDown: boolean;
}

export interface EditProductionInput {
  /** Pre-edit processed rows for the well (the edited row still at its OLD id/time). */
  rows: EditProdRow[];
  editedKey: string;
  oldMs: number;
  newMs: number;
  newFlowRateDays: number;
  newTankLevelFeet: number;
  newBblsTaken: number;
  newWellDown: boolean;
  bblPerFoot: number;
  wellKey: string;
  nowIso: string;
  /** Current stored bucket a-values by date, used only as a fallback when a
   *  date has no computable flow rate. */
  curBuckets: Record<string, { a?: number } | null | undefined>;
}

const asHistorical = (arr: EditProdRow[]): HistoricalPull[] =>
  arr.map((r) => ({ key: r.key, timestamp: r.ms, tankLevelFeet: r.tankLevelFeet, bblsTaken: r.bblsTaken, wellDown: r.wellDown }));

/** cmp by time then deterministic key (canonical order). */
const cmp = (a: EditProdRow, b: EditProdRow): number =>
  a.ms !== b.ms ? a.ms - b.ms : (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Pure. Returns one production entry per AFFECTED date (old + new, deduped);
 * `value: null` removes a vacated bucket. Recompute is idempotent: it depends
 * only on the post-edit row set, so any retry yields the same buckets.
 */
export function computeEditProductionBuckets(input: EditProductionInput):
  Array<{ wellKey: string; date: string; value: Record<string, unknown> | null }> {
  const edited = input.rows.map((r) =>
    r.key === input.editedKey
      ? { ...r, ms: input.newMs, flowRateDays: input.newFlowRateDays, tankLevelFeet: input.newTankLevelFeet, bblsTaken: input.newBblsTaken, wellDown: input.newWellDown }
      : r);
  const hist = asHistorical(edited);

  const dates = Array.from(new Set([getProductionDate(input.oldMs), getProductionDate(input.newMs)]));
  const out: Array<{ wellKey: string; date: string; value: Record<string, unknown> | null }> = [];

  for (const date of dates) {
    const onDate = edited.filter((r) => getProductionDate(r.ms) === date).sort(cmp);
    if (onDate.length === 0) {
      out.push({ wellKey: input.wellKey, date, value: null }); // vacated → remove
      continue;
    }
    const latest = onDate[onDate.length - 1];
    const w = calculateWindowBblsPerDay(hist, input.bblPerFoot, latest.ms) || 0;
    const o = calculateOvernightBblsPerDay(hist, input.bblPerFoot, latest.ms) || 0;
    // AFR of the latest pull = the rolling core over flow rates up to & incl it.
    const rates = edited.filter((r) => r.ms <= latest.ms && r.flowRateDays > 0).sort(cmp).map((r) => r.flowRateDays).slice(-15);
    const afr = computeAFRFromRates(rates);
    const a = afr > 0 ? Math.round((1 / afr) * input.bblPerFoot) : (input.curBuckets[date]?.a ?? 0);
    out.push({ wellKey: input.wellKey, date, value: { a, w, o, u: input.nowIso, n: onDate.length } });
  }
  return out;
}

/** One production bucket rebuilt from the POST-CASCADE rows on a date, or null
 *  when no qualifying pull remains. a/w/o are owned by the LATEST pull on the
 *  date (the canonical owner); n is the authoritative surviving count. */
function bucketForDate(
  afterRows: EditProdRow[], hist: HistoricalPull[], date: string,
  bblPerFoot: number, wellKey: string, nowIso: string,
  curBuckets: Record<string, { a?: number } | null | undefined>,
): { wellKey: string; date: string; value: Record<string, unknown> | null } {
  const onDate = afterRows.filter((r) => getProductionDate(r.ms) === date).sort(cmp);
  if (onDate.length === 0) return { wellKey, date, value: null };
  const latest = onDate[onDate.length - 1];
  const w = calculateWindowBblsPerDay(hist, bblPerFoot, latest.ms) || 0;
  const o = calculateOvernightBblsPerDay(hist, bblPerFoot, latest.ms) || 0;
  const rates = afterRows.filter((r) => r.ms <= latest.ms && r.flowRateDays > 0).sort(cmp).map((r) => r.flowRateDays).slice(-15);
  const afr = computeAFRFromRates(rates);
  const a = afr > 0 ? Math.round((1 / afr) * bblPerFoot) : (curBuckets[date]?.a ?? 0);
  return { wellKey, date, value: { a, w, o, u: nowIso, n: onDate.length } };
}

export interface AffectedProductionInput {
  /** Pre-mutation canonical rows (engine-recomputed BEFORE state). */
  beforeRows: EditProdRow[];
  /** Post-mutation canonical rows (engine-recomputed AFTER state — post-cascade). */
  afterRows: EditProdRow[];
  bblPerFoot: number;
  wellKey: string;
  nowIso: string;
  curBuckets: Record<string, { a?: number } | null | undefined>;
}

/**
 * THE unified production invariant for CREATE, EDIT, and DELETE. Given the
 * engine-recomputed BEFORE and AFTER canonical rows, the AFFECTED production-date
 * set is every date containing a row that was ADDED, REMOVED, MOVED (its date
 * changed → both old + new dates), or MATERIALLY CHANGED by cascade recomputation
 * (its flowRateDays / tankLevelFeet / bblsTaken / wellDown / ms differs). Each
 * affected date is rebuilt from the POST-CASCADE afterRows (bucketForDate): a/w/o
 * owned by the latest surviving pull on the date, n the authoritative count,
 * value null when none survive. A date with no added/removed/moved/changed row is
 * NOT emitted → genuinely-unrelated dates stay byte-identical. Idempotent: depends
 * only on the before/after row sets, so a replay yields identical buckets.
 */
export function computeAffectedProductionBuckets(input: AffectedProductionInput):
  Array<{ wellKey: string; date: string; value: Record<string, unknown> | null }> {
  const beforeByKey = new Map(input.beforeRows.map((r) => [r.key, r]));
  const afterByKey = new Map(input.afterRows.map((r) => [r.key, r]));
  const material = (r: EditProdRow) => `${r.flowRateDays}|${r.tankLevelFeet}|${r.bblsTaken}|${r.wellDown}|${r.ms}`;
  const dates = new Set<string>();
  for (const [k, r] of beforeByKey) if (!afterByKey.has(k)) dates.add(getProductionDate(r.ms));       // removed
  for (const [k, r] of afterByKey) if (!beforeByKey.has(k)) dates.add(getProductionDate(r.ms));       // added
  for (const [k, a] of afterByKey) {                                                                    // moved / changed
    const b = beforeByKey.get(k);
    if (!b) continue;
    const bDate = getProductionDate(b.ms), aDate = getProductionDate(a.ms);
    if (bDate !== aDate) { dates.add(bDate); dates.add(aDate); }
    else if (material(a) !== material(b)) dates.add(aDate);
  }
  const hist = asHistorical(input.afterRows);
  return [...dates].map((date) => bucketForDate(input.afterRows, hist, date, input.bblPerFoot, input.wellKey, input.nowIso, input.curBuckets));
}

export interface DeleteProductionInput {
  /** Post-delete SURVIVING processed rows (the deleted row already excluded). */
  survivingRows: EditProdRow[];
  /** Event time of the pull being deleted (its production date is the only one touched). */
  deletedMs: number;
  bblPerFoot: number;
  wellKey: string;
  nowIso: string;
  /** Current stored bucket a-values by date; fallback only when a surviving date
   *  has no computable flow rate. */
  curBuckets: Record<string, { a?: number } | null | undefined>;
}

/**
 * Pure. Recompute the SINGLE production-date bucket a DELETE touches (the deleted
 * pull's date), from the AUTHORITATIVE surviving rows — the exact per-date
 * semantics of computeEditProductionBuckets, so DELETE and EDIT agree. Count `n`
 * is the number of surviving pulls on that date (never a blind −1), so replay is
 * idempotent and cannot double-decrement; a/w/o reflect the actual latest
 * surviving pull on the date. `value: null` removes the bucket when the deleted
 * pull was the last one on that date. Historical stored tank bottoms are never
 * touched. Returns [] only for an unparseable deleted time (no date to recompute).
 */
export function computeDeleteProductionBuckets(input: DeleteProductionInput):
  Array<{ wellKey: string; date: string; value: Record<string, unknown> | null }> {
  if (!Number.isFinite(input.deletedMs)) return [];
  const hist = asHistorical(input.survivingRows);
  const date = getProductionDate(input.deletedMs);
  const onDate = input.survivingRows.filter((r) => getProductionDate(r.ms) === date).sort(cmp);
  if (onDate.length === 0) {
    return [{ wellKey: input.wellKey, date, value: null }]; // last pull on the date removed → bucket gone
  }
  const latest = onDate[onDate.length - 1];
  const w = calculateWindowBblsPerDay(hist, input.bblPerFoot, latest.ms) || 0;
  const o = calculateOvernightBblsPerDay(hist, input.bblPerFoot, latest.ms) || 0;
  const rates = input.survivingRows.filter((r) => r.ms <= latest.ms && r.flowRateDays > 0).sort(cmp).map((r) => r.flowRateDays).slice(-15);
  const afr = computeAFRFromRates(rates);
  const a = afr > 0 ? Math.round((1 / afr) * input.bblPerFoot) : (input.curBuckets[date]?.a ?? 0);
  return [{ wellKey: input.wellKey, date, value: { a, w, o, u: input.nowIso, n: onDate.length } }];
}
