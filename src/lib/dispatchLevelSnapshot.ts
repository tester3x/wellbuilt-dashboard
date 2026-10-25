import type { WellResponse } from './wells';
import { projectWellLevel } from './wellLevelProjection.ts';

/** Historical dispatch snapshot, never written back to the well's pull baseline. */
export function dispatchLevelSnapshot(well: WellResponse | null | undefined, assignedAtMs: number) {
  const projection = well ? projectWellLevel(well, assignedAtMs) : null;
  return {
    currentLevel: projection?.available ? projection.estDisplay : '',
    flowRate: well?.flowRate || '',
  };
}
