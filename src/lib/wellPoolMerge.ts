import type { WellResponse } from './wells';

export function wellResponsesFromCatalog(wellConfig: Record<string, unknown>): WellResponse[] {
  return Object.entries(wellConfig).map(([wellName, raw]) => {
    const config = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const tanks = typeof config.tanks === 'number'
      ? config.tanks
      : typeof config.numTanks === 'number' ? config.numTanks : 1;
    return {
      wellName,
      currentLevel: '--',
      etaToMax: '',
      flowRate: typeof config.avgFlowRate === 'string' ? config.avgFlowRate : 'Unknown',
      timestamp: '',
      route: typeof config.route === 'string' ? config.route : 'Unrouted',
      tanks,
      pullBbls: typeof config.pullBbls === 'number' ? config.pullBbls : 140,
      ndicName: typeof config.ndicName === 'string' ? config.ndicName : '',
      isDown: config.isDown === true,
    };
  });
}

function wellStatusRecord(
  wellStatus: Record<string, unknown>,
  wellName: string,
): Record<string, unknown> {
  const exact = wellStatus[wellName];
  if (exact && typeof exact === 'object') return exact as Record<string, unknown>;
  const stripped = wellStatus[wellName.replace(/\s/g, '')];
  if (stripped && typeof stripped === 'object') return stripped as Record<string, unknown>;
  return {};
}

/** Merge authorized catalog wellConfig with catalog wellStatus (outgoing projection). */
export function mergeWellPool(
  wellConfig: Record<string, unknown>,
  wellStatus: Record<string, unknown> = {},
): WellResponse[] {
  return wellResponsesFromCatalog(wellConfig).map((well) => {
    const st = wellStatusRecord(wellStatus, well.wellName);
    return {
      ...well,
      currentLevel: typeof st.currentLevel === 'string' ? st.currentLevel : well.currentLevel,
      flowRate: typeof st.flowRate === 'string' ? st.flowRate : well.flowRate,
      timestamp: typeof st.timestamp === 'string' ? st.timestamp : well.timestamp,
      timeTillPull: typeof st.timeTillPull === 'string' ? st.timeTillPull : well.timeTillPull,
      nextPullTime: typeof st.nextPullTime === 'string' ? st.nextPullTime : well.nextPullTime,
      nextPullTimeUTC: typeof st.nextPullTimeUTC === 'string' ? st.nextPullTimeUTC : well.nextPullTimeUTC,
      lastPullDateTimeUTC: typeof st.lastPullDateTimeUTC === 'string' ? st.lastPullDateTimeUTC : well.lastPullDateTimeUTC,
      lastPullBbls: st.lastPullBbls != null ? String(st.lastPullBbls) : well.lastPullBbls,
      isDown: st.wellDown === true || st.isDown === true || well.isDown,
      status: typeof st.status === 'string' ? st.status : well.status,
    };
  });
}
