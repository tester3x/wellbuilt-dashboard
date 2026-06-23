// Bulk Maintained Well Import — pure parse + match logic (NO writes).
//
// P1 scope: turn pasted text / CSV into status-bucketed rows matched against
// candidate NDIC wells. The actual well_config write happens in P2 and lives
// elsewhere; nothing here touches Firebase.

import { type NdicWell, normalizeWellName, searchWellsByName } from './firestoreWells';

export type ImportStatus =
  | 'MATCHED'
  | 'NEEDS_REVIEW'
  | 'NOT_FOUND'
  | 'DUPLICATE'
  | 'ALREADY_MAINTAINED';

export interface ParsedRow {
  raw: string;        // original line
  name: string;       // well name as pasted
  route?: string;     // route from CSV column, if any
}

export interface ImportRow extends ParsedRow {
  status: ImportStatus;
  route: string;            // resolved route to assign (CSV value as-is, else default)
  match: NdicWell | null;   // resolved NDIC well (MATCHED, or top candidate for NEEDS_REVIEW)
  candidates: NdicWell[];   // alternatives for NEEDS_REVIEW (used by P3 manual review)
  reason: string;           // human-readable note
}

export interface ParseResult {
  rows: ParsedRow[];
  hadHeader: boolean;
}

/** Does a line look like a CSV header row (e.g. "Well Name,Route")? */
function isHeaderLine(cells: string[]): boolean {
  const first = (cells[0] || '').toLowerCase();
  return cells.length >= 2 && (first.includes('well') || first === 'name');
}

/**
 * Parse pasted text. Accepts a plain newline-separated list or CSV text.
 * For CSV, column 0 is the well name and (if present) a column whose header
 * contains "route" — or simply column 1 when there's no header — is the route.
 */
export function parseImportText(text: string): ParseResult {
  const lines = (text || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  if (lines.length === 0) return { rows: [], hadHeader: false };

  let routeCol = -1;
  let hadHeader = false;

  const firstCells = lines[0].split(',').map(c => c.trim());
  if (isHeaderLine(firstCells)) {
    hadHeader = true;
    routeCol = firstCells.findIndex(c => c.toLowerCase().includes('route'));
    lines.shift();
  }

  const rows: ParsedRow[] = [];
  for (const line of lines) {
    const cells = line.split(',').map(c => c.trim());
    const name = cells[0] || '';
    if (!name) continue;
    let route: string | undefined;
    if (routeCol >= 0) {
      route = cells[routeCol]?.trim() || undefined;
    } else if (cells.length > 1) {
      route = cells[1]?.trim() || undefined;
    }
    rows.push({ raw: line, name, route });
  }

  return { rows, hadHeader };
}

/**
 * Match parsed rows against candidate NDIC wells and bucket each row.
 *
 * Match priority: exact name → normalized-exact (both = MATCHED, confident) →
 * fuzzy (NEEDS_REVIEW, never auto-imported) → NOT_FOUND. ALREADY_MAINTAINED and
 * within-paste DUPLICATE are detected first.
 *
 * Route resolution honors the confirmed default: a CSV route value is used
 * AS-IS even if new (routes are just grouping strings); otherwise defaultRoute.
 */
export function matchRows(
  parsed: ParsedRow[],
  candidates: NdicWell[],
  existingWellNames: string[],
  defaultRoute: string,
): ImportRow[] {
  const byName = new Map<string, NdicWell>();
  const byNorm = new Map<string, NdicWell>();
  for (const w of candidates) {
    const lower = (w.well_name || '').toLowerCase();
    if (lower && !byName.has(lower)) byName.set(lower, w);
    const norm = normalizeWellName(w.well_name);
    if (norm && !byNorm.has(norm)) byNorm.set(norm, w);
  }

  const existingNorm = new Set(existingWellNames.map(normalizeWellName));
  const seen = new Set<string>();

  return parsed.map(row => {
    const route = (row.route && row.route.length > 0 ? row.route : defaultRoute);
    const norm = normalizeWellName(row.name);

    const base: Omit<ImportRow, 'status' | 'reason'> = {
      ...row,
      route,
      match: null,
      candidates: [],
    };

    let result: ImportRow;

    if (existingNorm.has(norm)) {
      result = { ...base, status: 'ALREADY_MAINTAINED', reason: 'Already a maintained well' };
    } else if (seen.has(norm)) {
      result = { ...base, status: 'DUPLICATE', reason: 'Duplicate in pasted list' };
    } else {
      const exact = byName.get(row.name.toLowerCase()) || byNorm.get(norm) || null;
      if (exact) {
        result = { ...base, match: exact, status: 'MATCHED', reason: `${exact.operator || ''} · ${exact.well_name}`.trim() };
      } else {
        const fuzzy = searchWellsByName(row.name, candidates, 5);
        if (fuzzy.length > 0) {
          result = {
            ...base,
            match: fuzzy[0],
            candidates: fuzzy,
            status: 'NEEDS_REVIEW',
            reason: fuzzy.length === 1 ? `Closest: ${fuzzy[0].well_name}` : `${fuzzy.length} possible matches`,
          };
        } else {
          result = { ...base, status: 'NOT_FOUND', reason: 'No match in selected operator(s)' };
        }
      }
    }

    seen.add(norm);
    return result;
  });
}

/** Summary counts by status, for the preview header. */
export function summarize(rows: ImportRow[]): Record<ImportStatus, number> {
  const counts: Record<ImportStatus, number> = {
    MATCHED: 0,
    NEEDS_REVIEW: 0,
    NOT_FOUND: 0,
    DUPLICATE: 0,
    ALREADY_MAINTAINED: 0,
  };
  for (const r of rows) counts[r.status] += 1;
  return counts;
}
