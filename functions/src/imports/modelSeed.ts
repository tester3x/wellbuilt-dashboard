import { feetDisplay, rateDisplay, type JsonRecord } from './pullImportModel';
import { parseFeet } from './pullParser';
export function modelForecast(dateTimeUTC: string, bottomFeet: number, config: JsonRecord, afr: number, bank: number, isDown: boolean, now = Date.now()): JsonRecord {
  const target = Number(config.bottomLevel ?? config.allowedBottom ?? 0) + Number(config.pullBbls || 140) / bank;
  const nextMs = Date.parse(dateTimeUTC) + Math.max(0, target - bottomFeet) * afr * 86400_000;
  if (!Number.isFinite(nextMs)) return {};
  const next = new Date(nextMs);
  const nextPullTime = new Intl.DateTimeFormat('en-US', {timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit',hour:'numeric',minute:'2-digit'}).format(next).replace(',', '');
  const remaining = Math.max(0, Math.ceil((nextMs - now) / 60000));
  return { nextPullTimeUTC: next.toISOString(), nextPullTime, timeTillPull: isDown ? 'Down' : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` };
}
export function seededStatus(current: JsonRecord, config: JsonRecord, afr: number, bank: number, batchId: string): JsonRecord {
  const bottom = Number(current.lastPull?.bottomLevelInches) / 12;
  const forecast = Number.isFinite(bottom) ? modelForecast(current.lastPull.dateTimeUTC, bottom, config, afr, bank, current.isDown === true) : {};
  return { ...current, calculated: { ...current.calculated, ...forecast, flowRate: rateDisplay(afr), flowRateMinutes: Math.round(afr * 144000) / 100, bbls24hrs: Math.round(bank / afr) }, historicalModelSeed: { batchId, at: Date.now(), bblPerFoot: bank } };
}
export function seededOutgoing(current: JsonRecord, config: JsonRecord, afr: number, bank: number, batchId: string): JsonRecord {
  const bottom = parseFeet(String(current.lastPullBottomLevel || ''));
  const forecast = bottom !== null ? modelForecast(current.lastPullDateTimeUTC, bottom, config, afr, bank, current.wellDown === true) : {};
  const basis = Date.parse(current.timestampUTC || current.timestamp || '');
  const lastTime = Date.parse(current.lastPullDateTimeUTC || '');
  const level = bottom !== null && Number.isFinite(basis) && Number.isFinite(lastTime) ? feetDisplay(bottom + Math.max(0, basis - lastTime) / 86400_000 / afr) : current.currentLevel;
  return { ...current, ...forecast, ...(level ? { currentLevel: level } : {}), flowRate: rateDisplay(afr), bbls24hrs: String(Math.round(bank / afr)), historicalModelSeed: { batchId, at: Date.now(), bblPerFoot: bank } };
}
