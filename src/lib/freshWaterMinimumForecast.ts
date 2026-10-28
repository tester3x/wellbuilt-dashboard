import { thresholdTime } from '@tester3x/water-hauling';
import type { WellResponse } from './wellPoolCore';

/** Forecast when a freshwater tank reaches its configured delivery minimum. */
export function freshWaterMinimumForecast(well: WellResponse, estimatedFeet: number | null, asOfMs: number) {
  if (well.routeType !== 'freshwater' || estimatedFeet == null || well.bottomLevel == null) return null;
  const at = thresholdTime('freshwater', estimatedFeet, new Date(asOfMs).toISOString(),
    well.inventoryDailyBbl, well.bblPerFoot || 0, well.bottomLevel,
    well.isDown || well.wellDown || well.currentLevel === 'DOWN');
  return at ? { at, hoursRemaining: Math.max(0, (Date.parse(at) - asOfMs) / 3600000) } : null;
}
