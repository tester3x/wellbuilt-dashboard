import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';

export type DashboardCatalog = {
  ok: true;
  scope?: 'platform' | 'company';
  companyId?: string | null;
  approved: Record<string, unknown>;
  users: Record<string, unknown>;
  wellConfig: Record<string, unknown>;
  counts: { approved: number; users: number; wellConfig: number };
};

export async function adminGetDashboardCatalog(): Promise<DashboardCatalog> {
  const fn = httpsCallable(getFirebaseFunctions(), 'adminGetDashboardCatalog');
  const res = await fn({});
  return res.data as DashboardCatalog;
}

export function catalogErrorCode(err: unknown): string {
  if (!err || typeof err !== 'object') return 'unknown';
  const e = err as { code?: string; message?: string };
  const raw = String(e.code || e.message || 'unknown');
  if (/unauthenticated|auth/i.test(raw)) return 'unauthenticated';
  if (/permission-denied|permission_denied/i.test(raw)) return 'permission-denied';
  if (/not-found|not_found|404/i.test(raw)) return 'missing-callable';
  if (/failed-precondition|index/i.test(raw)) return 'failed-precondition';
  if (/deadline|unavailable|network/i.test(raw)) return 'unavailable';
  return raw.replace(/^functions\//, '').slice(0, 64);
}

export function classifiedReadFailure(surface: string, err: unknown): string {
  return `Failed to load ${surface} [${catalogErrorCode(err)}]. This is a read failure, not an empty list.`;
}
