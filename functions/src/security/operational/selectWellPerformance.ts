/**
 * Pure WB-M well-performance request validation and row projection.
 *
 * Response-size bound: MAX_PERFORMANCE_ROWS (5000) is applied AFTER optional
 * fromDate/toDate filtering, keeping the most recent rows. 5000 daily pulls
 * is ~13.7 years, so 30D / 90D / 1Y / All / custom ranges used by WB-M are
 * not truncated for real wells.
 */
export const MAX_WELL_NAME_LENGTH = 120;
export const MAX_PERFORMANCE_ROWS = 5000;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const ALLOWED_PERFORMANCE_REQUEST_KEYS = ['wellName', 'fromDate', 'toDate'] as const;

export type PerformanceRowProjection = { d: string; a: number; p: number };

export type WellPerformanceRequest = {
  wellName: string;
  fromDate?: string;
  toDate?: string;
};

export type WellPerformanceProjection = {
  wellName: string;
  updated: string;
  rows: PerformanceRowProjection[];
};

export class WellPerformanceRequestError extends Error {
  readonly code: 'invalid-argument';
  constructor(message: string) {
    super(message);
    this.code = 'invalid-argument';
    this.name = 'WellPerformanceRequestError';
  }
}

export function wellKeyFromName(wellName: string): string {
  return wellName.replace(/\s+/g, '_');
}

export function isAuthorizedSnapshotWell(
  snapshotWells: Record<string, unknown> | null | undefined,
  wellName: string,
): boolean {
  if (!snapshotWells || typeof snapshotWells !== 'object' || Array.isArray(snapshotWells)) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(snapshotWells, wellName);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseWellPerformanceRequest(data: unknown): WellPerformanceRequest {
  if (data === undefined || data === null) {
    throw new WellPerformanceRequestError('payload_required');
  }
  if (!isPlainObject(data)) {
    throw new WellPerformanceRequestError('payload_malformed');
  }

  const keys = Object.keys(data);
  for (const key of keys) {
    if (!(ALLOWED_PERFORMANCE_REQUEST_KEYS as readonly string[]).includes(key)) {
      throw new WellPerformanceRequestError('unexpected_key');
    }
  }

  const wellNameRaw = data.wellName;
  if (typeof wellNameRaw !== 'string') {
    throw new WellPerformanceRequestError('well_name_required');
  }
  const wellName = wellNameRaw.trim();
  if (!wellName) {
    throw new WellPerformanceRequestError('well_name_required');
  }
  if (wellName.length > MAX_WELL_NAME_LENGTH) {
    throw new WellPerformanceRequestError('well_name_too_long');
  }

  const fromDate = optionalIsoDate(data.fromDate, 'fromDate');
  const toDate = optionalIsoDate(data.toDate, 'toDate');
  if (fromDate && toDate && fromDate > toDate) {
    throw new WellPerformanceRequestError('date_range_reversed');
  }

  const parsed: WellPerformanceRequest = { wellName };
  if (fromDate) parsed.fromDate = fromDate;
  if (toDate) parsed.toDate = toDate;
  return parsed;
}

function optionalIsoDate(raw: unknown, label: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') {
    throw new WellPerformanceRequestError(`${label}_malformed`);
  }
  if (raw.length > 10 || !ISO_DATE_RE.test(raw)) {
    throw new WellPerformanceRequestError(`${label}_malformed`);
  }
  return raw;
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function projectPerformanceRow(raw: unknown): PerformanceRowProjection | null {
  if (!isPlainObject(raw)) return null;
  const d = raw.d;
  const a = raw.a;
  const p = raw.p;
  if (typeof d !== 'string' || !ISO_DATE_RE.test(d.trim())) return null;
  if (!isFinitePositiveNumber(a) || !isFinitePositiveNumber(p)) return null;
  return { d: d.trim(), a, p };
}

export function projectWellPerformance(input: {
  requestedWellName: string;
  node: unknown;
  fromDate?: string;
  toDate?: string;
}): WellPerformanceProjection {
  const node = isPlainObject(input.node) ? input.node : {};
  const storedName = typeof node.wellName === 'string' ? node.wellName.trim() : '';
  if (storedName && storedName !== input.requestedWellName) {
    return { wellName: input.requestedWellName, updated: '', rows: [] };
  }
  const updated = typeof node.updated === 'string' ? node.updated : '';

  const rawRows = node.rows;
  const collected: PerformanceRowProjection[] = [];
  if (Array.isArray(rawRows)) {
    for (const row of rawRows) {
      const projected = projectPerformanceRow(row);
      if (projected) collected.push(projected);
    }
  } else if (isPlainObject(rawRows)) {
    for (const row of Object.values(rawRows)) {
      const projected = projectPerformanceRow(row);
      if (projected) collected.push(projected);
    }
  }

  const filtered = collected.filter((row) => {
    if (input.fromDate && row.d < input.fromDate) return false;
    if (input.toDate && row.d > input.toDate) return false;
    return true;
  });

  filtered.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  const bounded =
    filtered.length > MAX_PERFORMANCE_ROWS
      ? filtered.slice(filtered.length - MAX_PERFORMANCE_ROWS)
      : filtered;

  return {
    wellName: input.requestedWellName,
    updated,
    rows: bounded.map((row) => ({ d: row.d, a: row.a, p: row.p })),
  };
}
