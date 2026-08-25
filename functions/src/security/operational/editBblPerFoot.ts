/**
 * Production edit tank-math rate. Never invents 20×tanks.
 *
 * Resolution order:
 *   1. stored positive bblPerFoot (number or numeric string) — total BBL/ft
 *      for the configured tank set;
 *   2. derivation (tankCapacity / tankHeight) * tankCount, each a positive
 *      number or numeric string. That is actual total barrels-per-foot.
 *
 * Insufficient data → fail closed. No arbitrary defaults.
 */

export type EditBblPerFootOk = {
  ok: true;
  bblPerFoot: number;
  source: 'stored' | 'derived';
};

export type EditBblPerFootMiss = {
  ok: false;
  reason: 'bbl_per_foot_unavailable';
};

export type EditBblPerFootDecision = EditBblPerFootOk | EditBblPerFootMiss;

/** Finite number > 0, accepting numeric strings. */
export function positiveNumeric(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

function tankCount(config: Record<string, unknown>): number | null {
  return positiveNumeric(config.tanks) ?? positiveNumeric(config.numTanks);
}

/**
 * Total barrels-per-foot for the configured tank set, or fail closed.
 */
export function resolveEditBblPerFoot(
  config: Record<string, unknown> | null | undefined,
): EditBblPerFootDecision {
  const row = config && typeof config === 'object' && !Array.isArray(config) ? config : {};

  const stored = positiveNumeric(row.bblPerFoot);
  if (stored !== null) {
    return { ok: true, bblPerFoot: stored, source: 'stored' };
  }

  const capacity = positiveNumeric(row.tankCapacity);
  const height = positiveNumeric(row.tankHeight);
  const count = tankCount(row);
  if (capacity !== null && height !== null && count !== null) {
    const derived = (capacity / height) * count;
    if (Number.isFinite(derived) && derived > 0) {
      return { ok: true, bblPerFoot: derived, source: 'derived' };
    }
  }

  return { ok: false, reason: 'bbl_per_foot_unavailable' };
}
