import { createHash } from 'node:crypto';

export type HistoryRecord = Record<string, any>;
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const key = (value: unknown): string => text(value).toLowerCase().replace(/[^a-z0-9]/g, '');
const api = (value: unknown): string => text(value).replace(/\D/g, '');
export const historyPullDigest = (...fields: unknown[]) =>
  createHash('sha256').update(JSON.stringify(fields)).digest('hex');

function level(raw: unknown): number {
  const value = typeof raw === 'number' ? String(raw) : text(raw);
  const inches = /^(\d+)(?:'\s*|\s+)(\d+(?:\.\d+)?)"?$/.exec(value);
  if (inches && Number(inches[2]) < 12) return Number(inches[1]) + Number(inches[2]) / 12;
  return /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
}

function originalInstant(value: unknown): string | undefined {
  const iso = text(value);
  return /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(iso) && Number.isFinite(Date.parse(iso))
    ? new Date(iso).toISOString() : undefined;
}

export function historyPullEvidence(ticket: HistoryRecord, invoice: HistoryRecord) {
  const activity = text(invoice.commodityType || ticket.type).toLowerCase();
  if (!['production water', 'production water (hr)', 'service work'].includes(activity)) return null;
  const top = level(ticket.top ?? ticket.tankLevelFeet);
  const bottomInput = ticket.bottom ?? ticket.bottomLevelFeet;
  const measuredBottom = level(bottomInput);
  const bottom = measuredBottom >= 0 && measuredBottom < top ? measuredBottom : undefined;
  const rawBarrels = String(ticket.bbls || ticket.qty || '').trim();
  const barrels = /^\d+(?:\.\d+)?$/.test(rawBarrels) ? Number(rawBarrels) : NaN;
  if (!(top > 0 && top <= 50 && barrels > 0 && barrels <= 1000)) return null;
  if (bottomInput !== undefined && bottomInput !== null && bottomInput !== '' && bottom === undefined) return null;
  const depart = Array.isArray(invoice.timeline) && invoice.timeline.find(event => event.type === 'depart_site');
  const recordedTime = [ticket.gaugeTimeUtc, ticket.gaugeTimeUTC, ticket.timeGauged, invoice.packetDateTimeUTC]
    .map(originalInstant).find(Boolean);
  return {
    top, bottom, barrels,
    at: recordedTime || originalInstant(depart && (depart.recordedTimestamp || depart.timestamp)),
    timeSource: recordedTime ? 'recorded_gauge' : 'recorded_pickup_departure',
    jobType: text(invoice.commodityType || ticket.type),
  };
}

export function matchHistoryWell(ticket: HistoryRecord, invoice: HistoryRecord, configs: HistoryRecord) {
  const names = [ticket.wellName, ticket.location, invoice.wellName, invoice.ndicWellName].map(key).filter(Boolean);
  const apis = [ticket.apiNo, invoice.apiNo, invoice.ndicApiNo].map(api).filter(Boolean);
  const entries = Object.entries(configs);
  const exactApi = entries.filter(([, cfg]) => api(cfg?.ndicApiNo) && apis.includes(api(cfg.ndicApiNo)));
  const named = entries.filter(([name, cfg]) =>
    [name, cfg?.ndicName].some(candidate => key(candidate) && names.includes(key(candidate))));
  if (apis.length) {
    return exactApi.length === 1 && named.every(([name]) => name === exactApi[0][0]) ? exactApi[0] : undefined;
  }
  return named.length === 1 ? named[0] : undefined;
}

export function historyPullKey(ticket: HistoryRecord, invoice: HistoryRecord, invoiceId: string) {
  const raw = [ticket.packetId, invoice.packetId].filter(Boolean);
  if (raw.some(id => typeof id !== 'string')) return undefined;
  const ids = raw.map((id: string) => id.replace(/^idem_/, ''));
  if (ids.some(id => !/^[A-Za-z0-9_-]{8,120}$/.test(id)) || new Set(ids).size > 1) return undefined;
  return ids[0] || 'wbt_history_' + historyPullDigest(ticket.companyId, invoiceId).slice(0, 40);
}

export function historyPullRoute(input: {
  original?: HistoryRecord; pending?: HistoryRecord; rejection?: HistoryRecord;
  evidence: NonNullable<ReturnType<typeof historyPullEvidence>>;
  owner: { driverId: string; companyId: string; invoiceId: string };
  wellName: string; latest: number; equivalent: boolean; legacyRecoveryOnly: boolean;
}): 'edit' | 'normal' | 'historical' | 'wait' | 'unchanged' | 'review' {
  const { original, pending, rejection, owner, evidence, wellName } = input;
  const owns = (record: HistoryRecord) => record.wellName === wellName && record.companyId === owner.companyId
    && record.driverId === owner.driverId && (!record.invoiceDocId || record.invoiceDocId === owner.invoiceId);
  if (original) {
    if (!owns(original) || !originalInstant(original.dateTimeUTC)) return 'review';
    if (input.legacyRecoveryOnly || (Number(original.tankLevelFeet) === evidence.top
      && Number(original.bblsTaken) === evidence.barrels
      && (evidence.bottom === undefined ||
        Math.abs(Number(original.tankAfterInches) / 12 - evidence.bottom) < 1 / 12))) return 'unchanged';
    if (original.noLevel) return 'review';
    return 'edit';
  }
  if (pending) return owns(pending) ? 'wait' : 'review';
  if (!evidence.at || evidence.bottom === undefined || input.equivalent) return 'review';
  if (rejection && (!owns(rejection.packet || {}) || rejection.reason !== 'STALE_PULL_TIME')) return 'review';
  const at = Date.parse(evidence.at);
  if (rejection && input.latest <= at) return 'review';
  if (input.latest === at) return 'review';
  return input.latest > at ? 'historical' : 'normal';
}
