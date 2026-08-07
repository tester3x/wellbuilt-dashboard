/**
 * Canonical + legacy Edit badge predicate and correction-trail types.
 * Mirrors functions/src/editHistory.ts (keep predicates in sync).
 */

export type EditSource = 'wbm' | 'dashboard' | 'legacy' | 'unknown';

export interface FieldChange {
  field: string;
  previous: string | number | boolean | null;
  next: string | number | boolean | null;
}

export interface EditHistoryEvent {
  eventId: string;
  packetId: string;
  sequence: number;
  editedAt: string;
  source: EditSource | string;
  actorDriverId?: string | null;
  actorDriverName?: string | null;
  fields: FieldChange[];
  originalSubmissionAt?: string | null;
  outcome?: string;
  resolutionPath?: string;
  editRequestId?: string;
}

/** Shared badge predicate: canonical history OR editedAt OR legacy markers. */
export function packetShowsEditBadge(p: {
  editCount?: number;
  editedAt?: string | null;
  isEdit?: boolean;
  requestType?: string;
} | null | undefined): boolean {
  if (!p) return false;
  if (typeof p.editCount === 'number' && p.editCount > 0) return true;
  if (typeof p.editedAt === 'string' && p.editedAt.length > 0) return true;
  if (p.isEdit === true) return true;
  if (p.requestType === 'edit') return true;
  return false;
}

export function formatEditSourceLabel(source: string | undefined | null): string {
  switch (source) {
    case 'wbm':
      return 'WB-M';
    case 'dashboard':
      return 'Dashboard';
    case 'legacy':
      return 'Legacy';
    case 'unknown':
      return 'Unknown';
    default:
      return source ? String(source) : 'Unknown';
  }
}

export function formatFieldLabel(field: string): string {
  switch (field) {
    case 'bblsTaken':
      return 'BBLs';
    case 'tankTopInches':
      return 'Top level (in)';
    case 'tankLevelFeet':
      return 'Top level (ft)';
    case 'dateTimeUTC':
      return 'Time (UTC)';
    case 'dateTime':
      return 'Time';
    case 'wellDown':
      return 'Well down';
    default:
      return field;
  }
}

export function formatChangeValue(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}
