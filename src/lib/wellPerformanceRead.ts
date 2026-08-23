/**
 * Individual-well Performance read: exact stored-name match and a staff
 * fallback when the direct RTDB parent read is denied.
 */

export type WellPerformanceRow = { d: string; a: number; p: number };

export function wellKeyFromName(wellName: string): string {
  return wellName.replace(/\s+/g, '_');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPerfRow(value: unknown): value is WellPerformanceRow {
  if (!isPlainObject(value)) return false;
  return typeof value.d === 'string'
    && typeof value.a === 'number' && Number.isFinite(value.a)
    && typeof value.p === 'number' && Number.isFinite(value.p);
}

export function isDeniedPerformanceRead(err: unknown): boolean {
  const code = err && typeof err === 'object' && 'code' in err
    ? String((err as { code?: unknown }).code || '')
    : '';
  const message = err && typeof err === 'object' && 'message' in err
    ? String((err as { message?: unknown }).message || '')
    : String(err || '');
  const blob = `${code} ${message}`;
  return /permission-denied|PERMISSION_DENIED|permission_denied/i.test(blob);
}

/** Rows only when stored wellName exactly equals the authorized requested name. */
export function projectStoredWellPerformance(input: {
  requestedWellName: string;
  node: unknown;
}): WellPerformanceRow[] {
  const node = isPlainObject(input.node) ? input.node : {};
  const storedName = typeof node.wellName === 'string' ? node.wellName.trim() : '';
  if (storedName !== input.requestedWellName) return [];

  const collected: WellPerformanceRow[] = [];
  const rawRows = node.rows;
  if (Array.isArray(rawRows)) {
    for (const row of rawRows) {
      if (isPerfRow(row)) collected.push({ d: row.d, a: row.a, p: row.p });
    }
  } else if (isPlainObject(rawRows)) {
    for (const row of Object.values(rawRows)) {
      if (isPerfRow(row)) collected.push({ d: row.d, a: row.a, p: row.p });
    }
  }
  collected.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
  return collected;
}

export function rowsFromSecureWellPayload(
  payload: { wellName?: unknown; rows?: unknown },
  requestedWellName: string,
): WellPerformanceRow[] {
  if (
    typeof payload.wellName !== 'string'
    || payload.wellName === ''
    || payload.wellName !== requestedWellName
  ) {
    return [];
  }
  if (!Array.isArray(payload.rows)) return [];
  const rows: WellPerformanceRow[] = [];
  for (const row of payload.rows) {
    if (isPerfRow(row)) rows.push({ d: row.d, a: row.a, p: row.p });
  }
  return rows;
}

export async function fetchWellPerformanceWithFallback(input: {
  wellName: string;
  readNode: () => Promise<unknown>;
  readSecure: (wellName: string) => Promise<{ wellName?: unknown; rows?: unknown }>;
}): Promise<WellPerformanceRow[]> {
  const wellName = input.wellName.trim();
  if (!wellName) return [];
  try {
    const node = await input.readNode();
    return projectStoredWellPerformance({ requestedWellName: wellName, node });
  } catch (err) {
    if (!isDeniedPerformanceRead(err)) throw err;
    const remote = await input.readSecure(wellName);
    return rowsFromSecureWellPayload(remote, wellName);
  }
}
