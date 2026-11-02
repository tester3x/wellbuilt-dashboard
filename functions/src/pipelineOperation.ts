/** Gross well production and net tank accumulation are independent. A running
 * pipeline holds an explicitly assumed/confirmed operating level; that level is
 * never written into a historical pull or used to train gross production. */
export function runningPipeline(config: any) {
  const p = config?.pipelineOperation;
  if (p?.mode !== 'running' || config.isDown === true || config.routeType === 'freshwater') return null;
  const levelFeet = p.holdingLevelFeet, height = config.tankHeight;
  const minutesPerFoot = p.productionMinutesPerFoot;
  if (typeof levelFeet !== 'number' || !Number.isFinite(levelFeet) || levelFeet < 0
    || typeof height !== 'number' || !Number.isFinite(height) || height <= 0 || levelFeet > height
    || typeof minutesPerFoot !== 'number' || !Number.isFinite(minutesPerFoot) || minutesPerFoot <= 0) return null;
  return { levelFeet, minutesPerFoot, assumed: p.levelBasis !== 'confirmed',
    bblsDay: Math.round(Number(config.bblPerFoot) * 1440 / minutesPerFoot) };
}

export async function refreshPipelineProjection(db: any, wellName: string, config: any): Promise<boolean> {
  const p = runningPipeline(config); if (!p || !Number.isFinite(p.bblsDay) || p.bblsDay <= 0) return false;
  const out = (await db.ref('packets/outgoing').orderByChild('wellName').equalTo(wellName).once('value')).val() || {};
  const at = new Date().toISOString(), inches = Math.floor(p.levelFeet * 12 + 1e-7);
  const level = `${Math.floor(inches / 12)}'${inches % 12}\"`;
  const seconds = Math.round(p.minutesPerFoot * 60);
  const rate = `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
  const projection = { pipelineRunning: true, pipelineHoldingLevelFeet: p.levelFeet,
    pipelineLevelAssumed: p.assumed, netInventoryBblsDay: 0, productionBblsDay: p.bblsDay };
  for (const key of Object.keys(out)) await db.ref('packets/outgoing/' + key).transaction((row: any) => row && row.wellDown !== true ? {
    ...row, ...projection, currentLevel: level, wellDown: false, flowRate: rate,
    bbls24hrs: String(p.bblsDay), windowBblsDay: null, overnightBblsDay: null,
    nextPullTimeUTC: null, nextPullTime: '', timeTillPull: 'Pipeline running',
    timestamp: at, timestampUTC: at, isEdit: true,
  } : undefined);
  await db.ref('wells/' + wellName + '/status').transaction((row: any) => row && row.isDown !== true ? {
    ...row, ...projection, isDown: false,
    current: { level, levelInches: inches, asOf: at, basis: p.assumed ? 'assumed_pipeline_setpoint' : 'pipeline_setpoint' },
    calculated: { ...row.calculated, flowRate: rate, flowRateMinutes: p.minutesPerFoot,
      bbls24hrs: p.bblsDay, netInventoryBblsDay: 0, nextPullTimeUTC: null,
      nextPullTime: '', timeTillPull: 'Pipeline running' },
  } : undefined);
  return true;
}
