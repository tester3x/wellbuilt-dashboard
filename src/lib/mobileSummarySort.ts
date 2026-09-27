import type { WellResponse } from './wellPoolCore.ts';
import { projectWellLevel, wbmInputsFromWell } from './wellLevelProjection.ts';
import { predictedReadyAtMs, readyLevelFeet, WBM_DEFAULT_LOAD_BBLS } from './wbmLevelEstimator.ts';

export type SummarySortField = 'wellName' | 'tanks' | 'nextPull' | 'level' | 'flowRate' | 'timeTillPull' | 'status';
export interface SummarySort { field: SummarySortField; dir: 'asc' | 'desc' }
export const DEFAULT_SUMMARY_SORT: SummarySort = { field: 'timeTillPull', dir: 'asc' };

// Missing values stay at the end in either direction; never treat them as zero.
function compareNumber(a: number | null, b: number | null, direction = 1): number {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  return (a - b) * direction;
}

function nextPullMs(well: WellResponse): number | null {
  const value = Date.parse(well.nextPullTimeUTC || well.nextPullTime || '');
  return Number.isFinite(value) ? value : null;
}

/** Route summary order uses the same live level as the displayed row and the
 * route's selected load size. Down wells always finish the list, highest first.
 * Operating wells default to ready-first, then earliest pull time (WB-M summary).
 * Column selections still sort the operating wells, without mixing in down wells.
 */
export function sortMobileSummaryWells(
  wells: WellResponse[],
  sort: SummarySort,
  asOfMs: number,
): WellResponse[] {
  const direction = sort.dir === 'asc' ? 1 : -1;
  return wells.map(well => {
    const level = projectWellLevel(well, asOfMs);
    const inputs = wbmInputsFromWell(well);
    const capacity = well.bblPerFoot && well.bblPerFoot > 0
      ? well.bblPerFoot : well.tanks && well.tanks > 0 ? 20 * well.tanks : null;
    const target = readyLevelFeet({
      allowedBottomFeet: well.bottomLevel ?? null,
      loadBbls: well.pullBbls ?? WBM_DEFAULT_LOAD_BBLS,
      bblsPerFoot: capacity,
    });
    const ready = level.estFeet != null && target != null && level.estFeet >= target;
    const readyAt = level.available ? predictedReadyAtMs(inputs, target) : null;
    return { well, level, ready, readyAt, flow: inputs.flowMinutesPerFoot };
  }).sort((a, b) => {
    if (a.level.wellDown !== b.level.wellDown) return a.level.wellDown ? 1 : -1;
    const nameOrder = a.well.wellName.localeCompare(b.well.wellName, undefined, { numeric: true });
    if (a.level.wellDown) {
      return compareNumber(a.level.estFeet, b.level.estFeet, -1) || nameOrder;
    }

    let order = 0;
    switch (sort.field) {
      case 'wellName': return nameOrder * direction;
      case 'tanks': order = compareNumber(a.well.tanks ?? null, b.well.tanks ?? null, direction); break;
      case 'nextPull': order = compareNumber(nextPullMs(a.well), nextPullMs(b.well), direction); break;
      case 'level': order = compareNumber(a.level.estFeet, b.level.estFeet, direction); break;
      case 'flowRate': order = compareNumber(a.flow, b.flow, direction); break;
      case 'status': order = (Number(b.level.available) - Number(a.level.available)) * direction; break;
      case 'timeTillPull': {
        // Ready/forecastable wells precede missing-data wells even when reversed.
        const aKnown = a.ready || a.readyAt != null;
        const bKnown = b.ready || b.readyAt != null;
        if (aKnown !== bKnown) return aKnown ? -1 : 1;
        if (a.ready !== b.ready) return (a.ready ? -1 : 1) * direction;
        order = compareNumber(a.readyAt, b.readyAt, direction);
        if (!order) order = compareNumber(a.level.estFeet, b.level.estFeet, -1);
        break;
      }
    }
    return order || nameOrder;
  }).map(item => item.well);
}
