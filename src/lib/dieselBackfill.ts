/**
 * Governed 12-week diesel-price backfill client.
 *
 * Replaces the legacy direct-write flow (handleBackfillHistory → saveDieselPrice
 * loop), whose write to companies.currentDieselPrice the deployed Firestore
 * rules deny (companies .write:false) and whose per-week loop left partial
 * state. Backfill now goes through the authenticated staffBackfillDieselPrices
 * callable, which derives the company + authorization server-side, fetches +
 * validates the EIA history, and commits every row + the company price in one
 * atomic batch. There is deliberately NO direct database fallback here.
 */
import { httpsCallable, FunctionsError } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';

export interface BackfillResult {
  ok: true;
  companyId: string;
  region: string;
  written: number;
  currentPrice: number | null;
  currentDate: string | null;
  fscConfigured: boolean;
  dates: string[];
}

/** Governed 12-week diesel backfill for the caller's own company. */
export async function backfillDieselPrices(weeks = 12): Promise<BackfillResult> {
  const fn = httpsCallable(getFirebaseFunctions(), 'staffBackfillDieselPrices');
  const res = await fn({ weeks });
  return res.data as BackfillResult;
}

/**
 * Turn a callable error into a short, sanitized, actionable message. Never
 * surfaces raw exception/transport text. Server messages are "reason:human
 * text"; key off the reason half.
 */
export function describeBackfillError(err: unknown): string {
  const code = (err as FunctionsError | undefined)?.code;
  const rawMessage = typeof (err as Error | undefined)?.message === 'string'
    ? (err as Error).message
    : '';
  const reason = rawMessage.includes(':') ? rawMessage.split(':')[0].trim() : rawMessage.trim();

  switch (reason) {
    case 'no_company':
    case 'no_company_doc':
      return 'No company is linked to your account — ask an admin to set it.';
    case 'no_region':
      return 'This company has no DOE fuel region or state configured.';
    case 'eia_empty':
    case 'eia_no_data':
      return 'The EIA price service returned no data. Try again shortly.';
    default:
      break;
  }
  if (reason.startsWith('eia_http_')) return 'The EIA price service is temporarily unavailable.';

  switch (code) {
    case 'permission-denied':
      return 'You do not have permission to update fuel prices.';
    case 'unauthenticated':
      return 'Your session expired — sign in again.';
    case 'failed-precondition':
      return 'Backfill is not available for this company yet.';
    case 'unavailable':
      return 'The price service is temporarily unavailable. Try again shortly.';
    default:
      return 'Could not backfill diesel prices. Please try again.';
  }
}
