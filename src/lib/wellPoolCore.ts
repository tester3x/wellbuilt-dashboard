/**
 * wellPoolCore — Firebase-free well-pool data contract.
 *
 * Pure functions that turn the governed adminGetWellPool payload
 * (`wellConfig` from `well_config`, `wellStatus` from `packets/outgoing`) into
 * WellResponse rows the height-first classifier (dispatchPriority.classifyWell)
 * can act on. Kept import-free of the Firebase SDK so it is unit-testable with
 * `node --test` (see __tests__/wellPoolDataContract.test.ts).
 *
 * CONTRACT (why this file exists): the classifier needs a pull-height target
 * (`tankAtLevel`), a numeric level (`currentLevelInches`), an observation
 * timestamp (`timestampUTC`), and validated gain (`windowBblsDay`/`bbls24hrs`).
 * The governed merge previously produced NONE of these, so every well fell to
 * VERIFY:missing_target. These functions derive/carry them exactly as the
 * realtime builder does.
 */

export interface WellResponse {
  wellName: string;
  currentLevel: string;
  etaToMax: string;
  flowRate: string;
  timestamp: string;
  timestampUTC?: string;     // ISO 8601 UTC timestamp for calculations
  bbls?: number;
  maxLevel?: number;
  bottomLevel?: number;
  isDown?: boolean;
  wellDown?: boolean;        // From Cloud Function response
  responseId?: string;
  route?: string;
  // Additional fields from outgoing packets (TankResponse from VBA)
  tanks?: number;
  tankAtLevel?: string;      // "Tank @ Level" — target height for pullBbls (e.g. "2 @ 7'6\"")
  pullBbls?: number;         // Configured pull BBLs for this well
  timeTillPull?: string;     // Time Till Pull (H:M format) - from outgoing packets
  nextPullTime?: string;     // Next Pull Time (datetime string) - from outgoing packets
  nextPullTimeUTC?: string;  // ISO 8601 UTC timestamp
  bbls24hrs?: string;        // BBLs produced in 24 hours (AFR-based)
  windowBblsDay?: string;    // Window-averaged bbls/day (more accurate, from Cloud Function)
  overnightBblsDay?: string; // Overnight bbls/day from Cloud Function
  status?: string;           // Status from VBA
  location?: string;         // GPS/address placeholder for future
  // Last pull info from Cloud Function
  lastPullDateTime?: string;
  lastPullDateTimeUTC?: string;
  lastPullBbls?: string;
  lastPullTopLevel?: string;
  lastPullBottomLevel?: string;
  // NDIC linkage from well_config
  ndicName?: string;           // Full NDIC well name (e.g. "GABRIEL 1-36-25H")
  // Raw numeric level for precision (avoids parsing formatted string)
  currentLevelInches?: number; // Total inches — used by Add Pull modal
  // Tank dimensions from well_config
  bblPerFoot?: number;         // Stored BBL/ft (overrides numTanks * 20 default)
}

/** Parse a "F'I"" level string to total inches (0 when unparseable). */
export function parseFeetInchesStr(str: string): number {
  if (!str) return 0;
  const match = str.match(/(\d+)'(\d+)"/);
  if (match) return parseInt(match[1]) * 12 + parseInt(match[2]);
  return 0;
}

/**
 * Configured pull-height target from tank geometry.
 * bblPerFootPerTank: per-tank BBL/ft (default 20 for standard 400BBL/20' tanks).
 */
export function calcTankAtLevel(
  tanks: number,
  pullBbls: number,
  bottomInches: number,
  bblPerFootPerTank: number = 20,
): { tankAtInches: number; tankAtLevel: string } {
  const bblsPerTank = pullBbls / tanks;
  const tankAtInches = ((bblsPerTank / bblPerFootPerTank) * 12) + bottomInches;
  const tankAtFeet = Math.floor(tankAtInches / 12);
  const tankAtRemainder = Math.round(tankAtInches - (tankAtFeet * 12));
  return { tankAtInches, tankAtLevel: `${tanks} @ ${tankAtFeet}'${tankAtRemainder}"` };
}

/**
 * Roster from the configured catalog, WITH the derived pull-height target and
 * geometry the classifier needs. This is the LEFT side of the catalog-left-join
 * (mergeWellPool overlays status onto it) — every configured well appears even
 * when it has no outgoing status.
 */
export function wellResponsesFromCatalog(wellConfig: Record<string, unknown>): WellResponse[] {
  return Object.entries(wellConfig).map(([wellName, raw]) => {
    const config = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const tanks = typeof config.tanks === 'number'
      ? config.tanks
      : typeof config.numTanks === 'number' ? config.numTanks : 1;
    const pullBbls = typeof config.pullBbls === 'number' ? config.pullBbls : 140;
    // Configured pull-height target — the SAME derivation the realtime builder
    // uses (calcTankAtLevel), so the height-first classifier has a target on the
    // governed path too (missing it made every well read VERIFY:missing_target).
    const bottomLevelFeet = typeof config.bottomLevel === 'number'
      ? config.bottomLevel
      : typeof (config as Record<string, unknown>).allowedBottom === 'number'
        ? (config as Record<string, unknown>).allowedBottom as number : 3;
    const bottomInches = bottomLevelFeet * 12;
    const bblPerFoot = typeof (config as Record<string, unknown>).bblPerFoot === 'number'
      ? (config as Record<string, unknown>).bblPerFoot as number : undefined;
    const bblPerFootPerTank = bblPerFoot ? bblPerFoot / tanks : 20;
    const { tankAtLevel } = calcTankAtLevel(tanks, pullBbls, bottomInches, bblPerFootPerTank);
    return {
      wellName,
      currentLevel: '--',
      etaToMax: '',
      flowRate: typeof config.avgFlowRate === 'string' ? config.avgFlowRate : 'Unknown',
      timestamp: '',
      route: typeof config.route === 'string' ? config.route : 'Unrouted',
      tanks,
      pullBbls,
      tankAtLevel,
      bottomLevel: bottomLevelFeet,
      maxLevel: typeof config.maxLevel === 'number' ? config.maxLevel : undefined,
      bblPerFoot,
      ndicName: typeof config.ndicName === 'string' ? config.ndicName : '',
      isDown: config.isDown === true,
    };
  });
}

/**
 * Catalog-left-join: full configured roster (wellResponsesFromCatalog) with the
 * live outgoing status overlaid. Carries the gain/level/timestamp fields the
 * classifier needs; a configured well with no outgoing status stays in the list
 * (currentLevel '--') and classifies as NEEDS DATA:missing_level.
 */
export function mergeWellPool(
  wellConfig: Record<string, unknown>,
  wellStatus: Record<string, unknown> = {},
): WellResponse[] {
  return wellResponsesFromCatalog(wellConfig).map((well) => {
    const st = (wellStatus[well.wellName] && typeof wellStatus[well.wellName] === 'object')
      ? wellStatus[well.wellName] as Record<string, unknown>
      : {};
    const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : v != null ? String(v) : undefined);
    const currentLevel = typeof st.currentLevel === 'string' ? st.currentLevel : well.currentLevel;
    const lastPullBottomLevel = asStr(st.lastPullBottomLevel);
    return {
      ...well,
      currentLevel,
      // Numeric level for the height-first classifier (governed path has no
      // precomputed estimate; parse the reported reading).
      currentLevelInches: currentLevel && currentLevel !== '--' ? parseFeetInchesStr(currentLevel) : undefined,
      flowRate: typeof st.flowRate === 'string' ? st.flowRate : well.flowRate,
      timestamp: typeof st.timestamp === 'string' ? st.timestamp : well.timestamp,
      // Observation timestamp for freshness (prefer explicit UTC, else last pull).
      timestampUTC: asStr(st.timestampUTC) || asStr(st.lastPullDateTimeUTC),
      timeTillPull: typeof st.timeTillPull === 'string' ? st.timeTillPull : well.timeTillPull,
      nextPullTime: typeof st.nextPullTime === 'string' ? st.nextPullTime : well.nextPullTime,
      nextPullTimeUTC: typeof st.nextPullTimeUTC === 'string' ? st.nextPullTimeUTC : well.nextPullTimeUTC,
      lastPullDateTimeUTC: typeof st.lastPullDateTimeUTC === 'string' ? st.lastPullDateTimeUTC : well.lastPullDateTimeUTC,
      lastPullBottomLevel: lastPullBottomLevel ?? well.lastPullBottomLevel,
      lastPullBbls: st.lastPullBbls != null ? String(st.lastPullBbls) : well.lastPullBbls,
      // Positive-gain evidence for the classifier (production field names).
      windowBblsDay: asStr(st.windowBblsDay) ?? well.windowBblsDay,
      bbls24hrs: asStr(st.bbls24hrs) ?? well.bbls24hrs,
      overnightBblsDay: asStr(st.overnightBblsDay) ?? well.overnightBblsDay,
      isDown: st.wellDown === true || st.isDown === true || well.isDown,
      wellDown: st.wellDown === true || well.wellDown,
      status: typeof st.status === 'string' ? st.status : well.status,
    };
  });
}
