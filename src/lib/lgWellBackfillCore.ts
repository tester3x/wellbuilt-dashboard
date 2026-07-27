// Liquid Gold legacy well-config backfill — pure, jest-tested (7/26).
//
// Legacy maintained-well records predate the engineering fields
// (tankCapacity / tankHeight / bblPerFoot / activeTanks). Before cab1d64 the
// Dashboard silently displayed fallback defaults (400/20/derived) as if
// saved; cab1d64 correctly labelled them "Default — not saved" / preview, but
// the fields were never persisted, so WB-T (which requires a canonical rate
// since cccd518) cannot auto-calc Bottom for those wells.
//
// Mike verified in Dashboard that every displayed preview BBL/ft matches the
// well's tank count (including multi-tank wells). This module computes the
// MINIMAL, non-destructive patch that persists exactly that previewed
// engineering — the same values Dashboard "Save Changes" would write — while
// NEVER overwriting any existing explicit engineering value and NEVER touching
// non-engineering fields (allowedBottom, route, tanks, pullBbls, ndic*, AFR,
// h2sStatus, waterWeight, routeGroupWell, …).

import { normalizeWellEditorFields, WELL_EDITOR_DEFAULTS } from './wellEditorFields';

export interface BackfillDecision {
  wellName: string;
  action: 'backfill' | 'skip';
  reason:
    | 'preview_engineering'  // backfill: previewed engineering not yet persisted
    | 'no_config'            // no well_config record
    | 'already_configured'   // stored rate / override / cap+ht — leave unchanged
    | 'no_tank_count'        // e.g. a SWD/disposal with no tanks — cannot derive
    | 'nothing_missing';     // all engineering keys already present
  /** Only the ABSENT engineering keys — an idempotent RTDB merge patch. */
  patch?: Record<string, number>;
  effectiveBblPerFoot?: number;
}

/** A well is "already configured" when it carries a stored rate, a manual
 *  override, or both capacity AND height — never touch those. */
export function isEngineeringConfigured(cfg: Record<string, unknown> | null | undefined): boolean {
  const n = normalizeWellEditorFields(cfg as any);
  return (
    n.bblPerFoot.present ||
    n.bblPerFootOverride.present ||
    (n.tankCapacity.present && n.tankHeight.present)
  );
}

function readNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Compute the backfill decision for one well. Backfills ONLY preview wells
 * (no engineering persisted) that have a usable tank count; the patch
 * contains only the engineering keys currently absent, computed from the
 * well's own tank count and the Dashboard default capacity/height — i.e. the
 * verified preview rate. Idempotent: re-running on a backfilled well returns
 * 'already_configured'.
 */
export function computeBackfill(
  wellName: string,
  cfg: Record<string, unknown> | null | undefined,
): BackfillDecision {
  if (!cfg || typeof cfg !== 'object') return { wellName, action: 'skip', reason: 'no_config' };
  if (isEngineeringConfigured(cfg)) return { wellName, action: 'skip', reason: 'already_configured' };

  const n = normalizeWellEditorFields(cfg as any);
  const tanks = n.tanks.value;
  if (tanks == null || tanks <= 0) return { wellName, action: 'skip', reason: 'no_tank_count' };

  const cap = WELL_EDITOR_DEFAULTS.tankCapacity; // 400
  const ht = WELL_EDITOR_DEFAULTS.tankHeight;    // 20
  const active = n.activeTanks.value ?? tanks;
  const bblPerFoot = (cap / ht) * active;        // == the verified preview rate

  const patch: Record<string, number> = {};
  if (!n.tankCapacity.present) patch.tankCapacity = cap;
  if (!n.tankHeight.present) patch.tankHeight = ht;
  if (!n.activeTanks.present) patch.activeTanks = active;
  if (!n.bblPerFoot.present) patch.bblPerFoot = bblPerFoot;
  // Canonical duplicate — only when genuinely absent; never overwrite `tanks`.
  if (readNum((cfg as any).numTanks) == null && readNum((cfg as any).tanks) != null) {
    patch.numTanks = tanks;
  }

  if (Object.keys(patch).length === 0) return { wellName, action: 'skip', reason: 'nothing_missing' };
  return { wellName, action: 'backfill', reason: 'preview_engineering', patch, effectiveBblPerFoot: bblPerFoot };
}

export interface BackfillPlan {
  backfill: BackfillDecision[];
  skipped: BackfillDecision[];
  unresolved: BackfillDecision[]; // skips that need a human (no_tank_count)
}

/** Plan the whole company set. Deterministic; no I/O. */
export function planBackfill(
  configs: Record<string, Record<string, unknown>>,
  wellNames: string[],
): BackfillPlan {
  const backfill: BackfillDecision[] = [];
  const skipped: BackfillDecision[] = [];
  const unresolved: BackfillDecision[] = [];
  for (const name of [...wellNames].sort()) {
    const d = computeBackfill(name, configs[name]);
    if (d.action === 'backfill') backfill.push(d);
    else if (d.reason === 'no_tank_count' || d.reason === 'no_config') unresolved.push(d);
    else skipped.push(d);
  }
  return { backfill, skipped, unresolved };
}
