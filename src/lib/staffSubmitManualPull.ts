/**
 * Governed Dashboard MANUAL pull client (+Add Pull).
 *
 * Replaces the legacy direct RTDB write to packets/incoming (denied by
 * production rules). Routes through the authenticated staffSubmitManualPull
 * callable, which derives company from the caller, submits through the canonical
 * WB-M pull-input path, and never produces a ticket/invoice/Payroll/Billing
 * projection. No direct database fallback.
 */
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';

export const MANUAL_PULL_CALLABLE = 'staffSubmitManualPull';

export type ManualPullServiceCategory = 'standard' | 'hot_oiler' | 'washout' | 'third_party' | 'other';

export interface ManualPullRequest {
  wellName: string;
  tankLevelFeet: number;
  bblsTaken: number;
  dateTimeUTC: string;
  wellDown?: boolean;
  serviceCategory?: ManualPullServiceCategory;
  externalCompany?: string;
  externalDriver?: string;
  reason?: string;
  idempotencyKey?: string;
  timezone?: string;
}

export interface ManualPullResult {
  ok: true;
  packetId: string;
  idempotent: boolean;
  submitted: boolean;
}

/** Build the callable request; strips undefined so no client company override can slip in. */
export function buildManualPullRequest(input: ManualPullRequest): Record<string, unknown> {
  const req: Record<string, unknown> = {
    wellName: input.wellName,
    tankLevelFeet: input.tankLevelFeet,
    bblsTaken: input.bblsTaken,
    dateTimeUTC: input.dateTimeUTC,
    wellDown: input.wellDown === true,
  };
  if (input.serviceCategory) req.serviceCategory = input.serviceCategory;
  if (input.externalCompany) req.externalCompany = input.externalCompany;
  if (input.externalDriver) req.externalDriver = input.externalDriver;
  if (input.reason) req.reason = input.reason;
  if (input.idempotencyKey) req.idempotencyKey = input.idempotencyKey;
  if (input.timezone) req.timezone = input.timezone;
  return req;
}

export async function submitManualPull(input: ManualPullRequest): Promise<ManualPullResult> {
  const fn = httpsCallable(getFirebaseFunctions(), MANUAL_PULL_CALLABLE);
  const res = await fn(buildManualPullRequest(input));
  return res.data as ManualPullResult;
}

/** Sanitized, actionable operator messages; never leaks raw transport text. */
export function describeManualPullError(err: unknown): string {
  const e = (err ?? {}) as { code?: string; message?: string };
  const raw = typeof e.message === 'string' ? e.message : '';
  const reason = raw.includes(':') ? raw.split(':')[0] : raw;
  switch (reason) {
    case 'company_required':
      return 'No company is bound to your account — a manager/dispatcher with a company can add pulls.';
    case 'company_override_forbidden':
      return 'Company is taken from your account and cannot be set manually.';
    case 'wellName_invalid':
    case 'wellName_malformed':
      return 'Choose a valid well before adding the pull.';
    case 'tankLevelFeet_invalid':
      return 'Enter a valid tank level (feet).';
    case 'bblsTaken_invalid':
      return 'Enter a valid barrels value.';
    case 'dateTimeUTC_invalid':
      return 'Enter a valid pull date/time.';
    case 'dateTimeUTC_future':
      return 'The pull time cannot be in the future.';
    case 'serviceCategory_invalid':
      return 'Choose a valid service category.';
    default:
      break;
  }
  if (e.code === 'unauthenticated') return 'Your session expired. Sign in again and retry.';
  if (e.code === 'permission-denied') return 'You do not have permission to add pulls.';
  if (e.code === 'unavailable' || e.code === 'internal' || e.code === 'deadline-exceeded') {
    return 'The pull service is unavailable right now. Nothing was recorded — try again.';
  }
  return 'Could not add the pull. Nothing was recorded — try again.';
}
