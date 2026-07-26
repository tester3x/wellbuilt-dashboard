// Default-truth well editor fields (7/26).
//
// Legacy well_config records predate the engineering fields (tankCapacity /
// tankHeight / bblPerFoot / activeTanks / pullBbls) and may store bottom only
// under the allowedBottom alias. The editor previously seeded its form with
// `config.field || default`, which (a) hid Gab 1's real allowedBottom=1.33
// behind the default 3 — saving as displayed would have overwritten the real
// limit — and (b) presented unsaved defaults (400/20 → "40 BBL/ft") as if
// they were persisted, both in the edit panel and on the Maintained Wells
// cards.
//
// This module is the ONE normalization used by the editor: presence-aware
// (explicit nullish/parse checks — a legitimate 0 is never replaced), alias-
// reconciling, and pure (no firebase — jest-tested via sanitized fixtures).

export interface EditorField {
  value: number | null;
  /** True when the record actually persists this field (any alias). */
  present: boolean;
}

export interface NormalizedWellEditorFields {
  bottomFeet: EditorField;      // bottomLevel | allowedBottom
  tanks: EditorField;           // tanks | numTanks
  activeTanks: EditorField;     // activeTanks | activeFlowingTanks
  pullBbls: EditorField;
  tankCapacity: EditorField;    // tankCapacity | tankCapacityBbl | capacity (+ tankStats)
  tankHeight: EditorField;      // tankHeight | tankHeightFt | tankHt | height (+ tankStats)
  bblPerFoot: EditorField;      // stored rate aliases (+ tankStats)
  bblPerFootOverride: EditorField;
}

export const WELL_EDITOR_DEFAULTS = {
  bottomFeet: 3,
  tanks: 1,
  pullBbls: 140,
  tankCapacity: 400,
  tankHeight: 20,
} as const;

type Raw = Record<string, unknown> | null | undefined;

/** Explicit presence: null/undefined/unparseable are absent; 0 is PRESENT. */
function readNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function firstPresent(cfg: Raw, keys: string[]): EditorField {
  if (cfg && typeof cfg === 'object') {
    for (const k of keys) {
      const n = readNum((cfg as Record<string, unknown>)[k]);
      if (n !== null) return { value: n, present: true };
    }
    const nested = (cfg as Record<string, unknown>).tankStats;
    if (nested && typeof nested === 'object') {
      for (const k of keys) {
        const n = readNum((nested as Record<string, unknown>)[k]);
        if (n !== null) return { value: n, present: true };
      }
    }
  }
  return { value: null, present: false };
}

export function normalizeWellEditorFields(cfg: Raw): NormalizedWellEditorFields {
  return {
    bottomFeet: firstPresent(cfg, ['bottomLevel', 'allowedBottom']),
    tanks: firstPresent(cfg, ['tanks', 'numTanks']),
    activeTanks: firstPresent(cfg, ['activeTanks', 'activeFlowingTanks']),
    pullBbls: firstPresent(cfg, ['pullBbls']),
    tankCapacity: firstPresent(cfg, ['tankCapacity', 'tankCapacityBbl', 'capacity']),
    tankHeight: firstPresent(cfg, ['tankHeight', 'tankHeightFt', 'tankHt', 'height']),
    bblPerFoot: firstPresent(cfg, ['bblPerFoot', 'bbl_per_foot', 'bblPerFt', 'bblsPerFoot', 'barrelsPerFoot']),
    bblPerFootOverride: firstPresent(cfg, ['bblPerFootOverride']),
  };
}

export type EffectiveRateSource =
  | 'override'          // manual bblPerFootOverride
  | 'stored'            // persisted bblPerFoot
  | 'derived-saved'     // derived from PERSISTED capacity/height
  | 'derived-defaults'; // derived using unsaved default capacity/height — preview only

/** Effective rate + provenance, so the UI can label preview vs saved truth. */
export function effectiveBblPerFoot(
  n: NormalizedWellEditorFields,
): { rate: number; source: EffectiveRateSource } {
  const override = n.bblPerFootOverride.value;
  if (override !== null && override > 0) return { rate: override, source: 'override' };
  if (n.bblPerFoot.present && (n.bblPerFoot.value as number) > 0) {
    return { rate: n.bblPerFoot.value as number, source: 'stored' };
  }
  const cap = n.tankCapacity.value ?? WELL_EDITOR_DEFAULTS.tankCapacity;
  const ht = n.tankHeight.value ?? WELL_EDITOR_DEFAULTS.tankHeight;
  const active = n.activeTanks.value ?? n.tanks.value ?? WELL_EDITOR_DEFAULTS.tanks;
  const rate = ht > 0 ? (cap / ht) * active : 0;
  return {
    rate,
    source: n.tankCapacity.present && n.tankHeight.present ? 'derived-saved' : 'derived-defaults',
  };
}

export interface EditorSaveInputs {
  route: string;
  /** The bottom the form DISPLAYS — seeded from the persisted aliases. */
  bottomFeet: number;
  tanks: number;
  /** Blank input → defaults to physical tanks. */
  activeTanks: number | null;
  pullBbls: number;
  tankCapacity: number;
  tankHeight: number;
  bblPerFootOverride: number | null;
  equalizedTanks: boolean;
  requireActualBottom: boolean;
  h2sStatus: string;
  ndicName?: string;
  ndicApiNo?: string;
  waterWeight?: number;
}

/**
 * The exact merge payload Save writes to `well_config/<existing key>` via
 * update(). Pressing Save is explicit acceptance of the DISPLAYED inputs —
 * but the payload carries ONLY editor-owned fields, so top-level merge
 * semantics preserve everything else (loadLine, routeGroupWell, routeColor,
 * avgFlowRate*, isDown, routeRecording, …).
 */
export function buildEditorSavePayload(i: EditorSaveInputs): Record<string, unknown> {
  const tanks = i.tanks > 0 ? i.tanks : WELL_EDITOR_DEFAULTS.tanks;
  const activeTanks = i.activeTanks !== null && i.activeTanks > 0 ? i.activeTanks : tanks;
  const hasOverride = i.bblPerFootOverride !== null && i.bblPerFootOverride > 0;
  const bblPerFoot = hasOverride
    ? (i.bblPerFootOverride as number)
    : (i.tankCapacity / i.tankHeight) * activeTanks;
  return {
    route: i.route || 'Unrouted',
    bottomLevel: i.bottomFeet,
    allowedBottom: i.bottomFeet,
    tanks,
    numTanks: tanks,
    pullBbls: i.pullBbls,
    tankCapacity: i.tankCapacity,
    tankHeight: i.tankHeight,
    bblPerFoot,
    activeTanks,
    bblPerFootOverride: hasOverride ? (i.bblPerFootOverride as number) : null,
    equalizedTanks: !!i.equalizedTanks,
    requireActualBottom: !!i.requireActualBottom,
    h2sStatus: i.h2sStatus || 'unknown',
    ...(i.ndicName ? { ndicName: i.ndicName } : {}),
    ...(i.ndicApiNo ? { ndicApiNo: i.ndicApiNo } : {}),
    ...(typeof i.waterWeight === 'number' && Number.isFinite(i.waterWeight)
      ? { waterWeight: i.waterWeight }
      : {}),
  };
}
