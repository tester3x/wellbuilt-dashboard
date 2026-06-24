// Bulk Maintained Well Import — pure parse + match logic (NO writes).
//
// P1 scope: turn pasted text / CSV into status-bucketed rows matched against
// candidate NDIC wells. The actual well_config write happens in P2 and lives
// elsewhere; nothing here touches Firebase.

import { type NdicWell, normalizeWellName, searchWellsByName, suggestDisplayName } from './firestoreWells';

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
  /** Driver-facing display name — auto-suggested, user-editable. Becomes the well_config key. */
  displayName: string;
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

  // Existing maintained-well keys ARE display names — dedup/already-maintained
  // must compare against the final display name, not the pasted name.
  const existingNorm = new Set(existingWellNames.map(normalizeWellName));
  const seen = new Set<string>();

  return parsed.map(row => {
    const route = (row.route && row.route.length > 0 ? row.route : defaultRoute);
    const norm = normalizeWellName(row.name);

    // 1. Resolve a catalog match (exact → normalized-exact → fuzzy).
    let match: NdicWell | null = byName.get(row.name.toLowerCase()) || byNorm.get(norm) || null;
    let foundCandidates: NdicWell[] = [];
    let matchStatus: ImportStatus;
    let matchReason: string;
    if (match) {
      matchStatus = 'MATCHED';
      matchReason = match.well_name;
    } else {
      const fuzzy = searchWellsByName(row.name, candidates, 5);
      if (fuzzy.length > 0) {
        match = fuzzy[0];
        foundCandidates = fuzzy;
        matchStatus = 'NEEDS_REVIEW';
        matchReason = fuzzy.length === 1 ? `Closest: ${fuzzy[0].well_name}` : `${fuzzy.length} possible matches`;
      } else {
        matchStatus = 'NOT_FOUND';
        matchReason = 'No match in selected operator(s)';
      }
    }

    // 2. Suggest the driver display name from the matched legal name.
    const displayName = match ? suggestDisplayName(match.well_name) : row.name;
    const dnorm = normalizeWellName(displayName);

    // 3. Dedup / already-maintained keyed on the FINAL display name.
    let status: ImportStatus = matchStatus;
    let reason = matchReason;
    if (existingNorm.has(dnorm)) {
      status = 'ALREADY_MAINTAINED';
      reason = `"${displayName}" already maintained`;
    } else if (seen.has(dnorm)) {
      status = 'DUPLICATE';
      reason = `Duplicate display name "${displayName}"`;
    }
    seen.add(dnorm);

    return { ...row, displayName, route, match, candidates: foundCandidates, status, reason };
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
