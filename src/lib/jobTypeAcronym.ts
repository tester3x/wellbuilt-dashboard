/**
 * Canonical two-letter acronyms for dispatch job types — pure, node-testable.
 *
 * The dispatch `DispatchJob.jobType` is a strict union of exactly TWO stored values,
 * and these are the only job types the Active Jobs surface renders:
 *   'pw'      → PW (Produced Water)
 *   'service' → SW (Service Work)
 *
 * The extra explicit entries below are recognized related job-type tokens that
 * legacy / imported data could carry; they render canonically if ever present. This
 * is PRESENTATION ONLY — stored job-type values are never altered, and no routing,
 * calculation, or identity depends on this mapping. The full name is always
 * preserved for the badge's tooltip / accessibility text.
 */

export interface JobTypeBadgeInfo {
  /** Canonical two-letter acronym, e.g. "PW", "SW", "DW". */
  code: string;
  /** Full human-readable job-type name, preserved for tooltip / aria-label. */
  full: string;
}

/** Explicit mapping keyed by the lowercased stored token. */
export const JOB_TYPE_ACRONYMS: Record<string, JobTypeBadgeInfo> = {
  // The two canonical dispatch job types (the only values this app stores):
  pw: { code: 'PW', full: 'Produced Water' },
  service: { code: 'SW', full: 'Service Work' },
  // Recognized related tokens (legacy / imported data), mapped canonically:
  sw: { code: 'SW', full: 'Service Work' },
  dw: { code: 'DW', full: 'Dirty Water' },
  fw: { code: 'FW', full: 'Fresh Water' },
};

/**
 * Resolve ANY job-type token to a canonical two-letter acronym + full name.
 * Recognized tokens use the explicit table; an unrecognized token falls back to its
 * first two alphanumeric characters (uppercased) with the original token preserved
 * as the full name — so every job type renders as two letters and nothing is lost.
 */
export function jobTypeAcronym(jobType: string | null | undefined): JobTypeBadgeInfo {
  const key = (jobType ?? '').trim().toLowerCase();
  if (key && Object.prototype.hasOwnProperty.call(JOB_TYPE_ACRONYMS, key)) {
    return JOB_TYPE_ACRONYMS[key];
  }
  const alnum = key.replace(/[^a-z0-9]/g, '');
  const code = alnum ? alnum.slice(0, 2).toUpperCase() : '??';
  const full = jobType && jobType.trim() ? jobType.trim() : 'Unknown';
  return { code, full };
}

/** Convenience: just the two-letter code (for compact count summaries like "4 PW"). */
export function jobTypeCode(jobType: string | null | undefined): string {
  return jobTypeAcronym(jobType).code;
}
