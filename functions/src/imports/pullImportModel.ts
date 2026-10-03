import { createHash } from 'crypto';
import type { PullImportRow } from './pullParser';
import { normalizeWell } from './pullParser';
export type JsonRecord = Record<string, any>;
export interface ReviewedPull extends PullImportRow { status: 'ready' | 'duplicate' | 'review' | 'excluded'; packetId: string; bank: number; afterFeet: number | null; reviewAcknowledged?: boolean }
export function digest(value: unknown): string {
  function stable(input: any): any {
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === 'object') return Object.fromEntries(Object.keys(input).sort().map(key => [key, stable(input[key])]));
    return input;
  }
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
export function resolveWell(name: string, configs: JsonRecord): string | null {
  const normalized = normalizeWell(name);
  const found = Object.keys(configs).filter(key => normalizeWell(key) === normalized || normalizeWell(String(configs[key]?.ndicName || '')) === normalized);
  if (found.length === 1) return found[0];
  // Long NDIC names must identify a unique short catalogue key, never fuzzy-match.
  const short = /^(gunslinger(?:federal)?[35]|cyclone[2-5]|kahuna5)(?:\d.*)?$/.exec(normalized);
  if (!short || short[1] !== normalized) return null;
  const target = short[1].replace('federal', '');
  const canonical = Object.keys(configs).filter(key => normalizeWell(key).replace('federal', '') === target);
  return canonical.length === 1 ? canonical[0] : null;
}
export function calibration(config: JsonRecord, override?: number): number {
  if (Number.isFinite(override) && Number(override) > 0 && Number(override) <= 1000) return Number(override);
  const stored = Number(config.bblPerFoot);
  if (stored > 0 && Number.isFinite(stored)) return stored; // Stored value is TOTAL bank, not per tank.
  const tanks = Number(config.activeTanks || config.tanks || config.numTanks);
  const capacity = Number(config.tankCapacity);
  const height = Number(config.tankHeight);
  return tanks > 0 && capacity > 0 && height > 0 ? tanks * capacity / height : 0;
}
export function canonicalHistory(tree: JsonRecord): JsonRecord[] {
  const keys = new Set(Object.keys(tree));
  const seen = new Set<string>();
  const result: JsonRecord[] = [];
  for (const [key, raw] of Object.entries(tree)) {
    if (!raw || /^(?:edit_|delete_|history_)/.test(key) || raw.deleted || raw.requestType === 'delete') continue;
    if (key.startsWith('idem_') && keys.has(key.slice(5))) continue;
    const row = { ...raw, key };
    const time = Date.parse(row.dateTimeUTC || row.gaugeTime || row.dateTime || '');
    if (!Number.isFinite(time) || !Number.isFinite(Number(row.tankLevelFeet))) continue;
    const identity = `${row.packetId || key.replace(/^idem_/, '')}:${time}:${row.tankLevelFeet}:${row.bblsTaken}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(row);
  }
  return result.sort((a, b) => Date.parse(a.dateTimeUTC || a.gaugeTime || a.dateTime) - Date.parse(b.dateTimeUTC || b.gaugeTime || b.dateTime));
}
export function reviewPulls(rows: PullImportRow[], configs: JsonRecord, history: JsonRecord, banks: Record<string, number>, acknowledged: Set<string>, now = Date.now()): ReviewedPull[] {
  const seen = new Set<string>();
  const result: ReviewedPull[] = [];
  for (const original of rows) {
    const wellName = resolveWell(original.wellName, configs) || original.wellName;
    const config = configs[wellName];
    const bank = config ? calibration(config, banks[wellName]) : 0;
    const issues = acknowledged.has(original.id) ? [] : original.issues.filter(issue => !(config && issue === 'Choose the well for this shorthand message'));
    const ts = Date.parse(original.dateTimeUTC);
    const top = original.tankLevelFeet;
    const bbls = original.bblsTaken;
    if (!config) issues.push('Well is not in the authorized catalogue');
    if (!bank || bank > 1000) issues.push('Valid tank calibration is required');
    if (!Number.isFinite(ts) || ts > now + 300_000 || ts < Date.UTC(2000, 0, 1)) issues.push('Invalid or future pull time');
    if (typeof top !== 'number' || !Number.isFinite(top) || top < 0 || top > Number(config?.tankHeight || 40)) issues.push('Top level is outside tank height');
    if (typeof bbls !== 'number' || !Number.isFinite(bbls) || bbls <= 0 || bbls > 1000) issues.push('Barrels must be between 0 and 1,000');
    const afterFeet = top !== null && bbls !== null && bank ? top - bbls / bank : null;
    if (afterFeet !== null && afterFeet < 0) issues.push('Load exceeds water below the reported top');
    if (afterFeet !== null && original.bottomLevelFeet !== null && Math.abs(afterFeet - original.bottomLevelFeet) > 0.75 && !acknowledged.has(original.id)) issues.push('Reported bottom differs from calibrated removal by over 9 inches; check setup or gauge');
    const packetId = 'import_' + digest([wellName, Number.isFinite(ts) ? new Date(ts).toISOString() : '', top, bbls]);
    const existing = canonicalHistory(history[wellName] || {});
    const equivalent = (row: JsonRecord, maxMs: number) => Math.abs(Date.parse(row.dateTimeUTC || row.gaugeTime || row.dateTime) - ts) <= maxMs && Math.abs(Number(row.tankLevelFeet) - Number(top)) <= 1 / 12 && Number(row.bblsTaken) === bbls;
    const duplicate = !!history[wellName]?.[packetId] || seen.has(packetId) || existing.some(row => equivalent(row, 90_000));
    if (!duplicate && existing.some(row => equivalent(row, 1_800_000)) && !acknowledged.has(original.id)) issues.push('Possible existing pull within 30 minutes; confirm or exclude');
    const prev = result.filter(row => row.wellName === wellName && !row.excluded).slice(-1)[0];
    if (prev && Math.abs(Date.parse(prev.dateTimeUTC) - ts) < 300_000 && !acknowledged.has(original.id)) issues.push('Pulls less than five minutes apart; confirm actual pull times');
    seen.add(packetId);
    result.push({ ...original, wellName, issues: [...new Set(issues)], status: original.excluded ? 'excluded' : duplicate ? 'duplicate' : issues.length ? 'review' : 'ready', packetId, bank, afterFeet });
  }
  return result;
}
export function feetDisplay(feet: number): string {
  const inches = Math.round(Math.max(0, feet) * 12);
  return `${Math.floor(inches / 12)}'${inches % 12}\"`;
}
export function rateDisplay(days: number): string {
  const seconds = Math.round(days * 86400);
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
export function buildHistoricalPackets(rows: ReviewedPull[], history: JsonRecord, batchId: string, actorUid: string, companyId: string): JsonRecord {
  const packets: JsonRecord = {};
  for (const row of rows.filter(row => row.status === 'ready')) {
    const preceding = [...canonicalHistory(history[row.wellName] || {}), ...Object.values(packets)].filter(pull => pull.wellName === row.wellName && Date.parse(pull.dateTimeUTC) < Date.parse(row.dateTimeUTC)).sort((a, b) => Date.parse(a.dateTimeUTC) - Date.parse(b.dateTimeUTC)).slice(-1)[0];
    const elapsed = preceding ? (Date.parse(row.dateTimeUTC) - Date.parse(preceding.dateTimeUTC)) / 86400_000 : 0;
    const previousBottom = preceding ? Number(preceding.tankLevelFeet) - Number(preceding.bblsTaken) / row.bank : 0;
    const recovery = preceding ? Number(row.tankLevelFeet) - previousBottom : 0;
    const days = elapsed > 0 && recovery > 0 && !preceding?.wellDown ? elapsed / recovery : 0;
    const flowRateDays = days > 0 && days < 365 ? days : 0;
    packets[row.packetId] = {
      packetId: row.packetId, requestType: 'pull', wellName: row.wellName,
      dateTime: row.dateTimeUTC, dateTimeUTC: row.dateTimeUTC,
      tankLevelFeet: row.tankLevelFeet, bblsTaken: row.bblsTaken,
      tankTopInches: Number(row.tankLevelFeet) * 12, tankAfterInches: Number(row.afterFeet) * 12,
      tankAfterFeet: feetDisplay(Number(row.afterFeet)), recoveryInches: Math.max(0, recovery * 12),
      timeDifDays: elapsed, flowRateDays, flowRate: flowRateDays ? rateDisplay(flowRateDays) : '',
      historicalImport: { version: 1, batchId, actorUid, companyId, source: 'whatsapp', messageId: row.id, author: row.author, postedAt: row.postedAt, reportedBottomFeet: row.bottomLevelFeet, bblPerFoot: row.bank },
      processedAt: new Date().toISOString(), historicalOnly: true,
    };
  }
  return packets;
}

