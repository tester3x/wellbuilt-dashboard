// Single source of truth for the well_config object shape.
//
// Both the manual "Add Maintained Well" form and Bulk Import build their
// well_config through buildWellConfig() so they always write the identical
// shape. This is NOT a second model — it is the same well_config document the
// admin page has always written, with the math (bblPerFoot derivation, app-
// compatible duplicate fields) centralized.

export type H2sStatus = 'none' | 'low' | 'high' | 'unknown';

export interface WellConfigInput {
  route?: string;
  /** Bottom level in feet (already parsed). Defaults to 3 when missing/<=0. */
  bottomFeet?: number;
  tanks?: number;             // physical tanks; default 1
  activeTanks?: number;       // flowing tanks; default = tanks
  pullBbls?: number;          // default 140
  tankCapacity?: number;      // BBL per tank; default 400
  tankHeight?: number;        // feet per tank; default 20
  /** Manual bbl/ft override; null/undefined → derive from capacity/height×activeTanks. */
  bblPerFootOverride?: number | null;
  equalizedTanks?: boolean;
  requireActualBottom?: boolean;
  ndicName?: string;
  ndicApiNo?: string;
  waterWeight?: number;       // omitted from the doc when undefined
  h2sStatus?: H2sStatus;      // default 'unknown'
}

export interface BuiltWellConfig {
  route: string;
  bottomLevel: number;
  tanks: number;
  allowedBottom: number;
  numTanks: number;
  pullBbls: number;
  tankCapacity: number;
  tankHeight: number;
  bblPerFoot: number;
  activeTanks: number;
  bblPerFootOverride: number | null;
  equalizedTanks: boolean;
  requireActualBottom: boolean;
  ndicName?: string;
  ndicApiNo?: string;
  waterWeight?: number;
  h2sStatus: H2sStatus;
}

const pos = (n: number | undefined | null, fallback: number): number =>
  (typeof n === 'number' && !isNaN(n) && n > 0 ? n : fallback);

export function buildWellConfig(input: WellConfigInput): BuiltWellConfig {
  const tankCapacity = pos(input.tankCapacity, 400);
  const tankHeight = pos(input.tankHeight, 20);
  const tanks = pos(input.tanks, 1);
  const activeTanks = pos(input.activeTanks, tanks);
  const bottomLevel = pos(input.bottomFeet, 3);
  const pullBbls = pos(input.pullBbls, 140);

  const hasOverride =
    typeof input.bblPerFootOverride === 'number' &&
    !isNaN(input.bblPerFootOverride) &&
    input.bblPerFootOverride > 0;
  const bblPerFoot = hasOverride
    ? (input.bblPerFootOverride as number)
    : (tankCapacity / tankHeight) * activeTanks;

  const cfg: BuiltWellConfig = {
    route: input.route || 'Unrouted',
    bottomLevel,
    tanks,
    // app-compatible duplicate field names
    allowedBottom: bottomLevel,
    numTanks: tanks,
    pullBbls,
    tankCapacity,
    tankHeight,
    bblPerFoot,
    activeTanks,
    bblPerFootOverride: hasOverride ? (input.bblPerFootOverride as number) : null,
    equalizedTanks: !!input.equalizedTanks,
    requireActualBottom: !!input.requireActualBottom,
    h2sStatus: input.h2sStatus || 'unknown',
  };
  if (input.ndicName) cfg.ndicName = input.ndicName;
  if (input.ndicApiNo) cfg.ndicApiNo = input.ndicApiNo;
  if (typeof input.waterWeight === 'number' && !isNaN(input.waterWeight)) {
    cfg.waterWeight = input.waterWeight;
  }
  return cfg;
}
