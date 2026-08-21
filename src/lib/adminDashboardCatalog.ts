import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';

export type DashboardCatalog = {
  ok: true;
  scope?: 'platform' | 'company';
  companyId?: string | null;
  canViewWellPool?: boolean;
  approved: Record<string, unknown>;
  profiles?: Record<string, unknown>;
  users: Record<string, unknown>;
  pending?: Record<string, unknown>;
  wellConfig: Record<string, unknown>;
  wellStatus?: Record<string, unknown>;
  counts: {
    approved: number;
    profiles?: number;
    users: number;
    wellConfig: number;
    pending?: number;
    wellStatus?: number;
  };
};

export type WellPool = {
  ok: true;
  canViewWellPool: boolean;
  wellConfig: Record<string, unknown>;
  wellStatus: Record<string, unknown>;
};

export async function adminGetDashboardCatalog(): Promise<DashboardCatalog> {
  const fn = httpsCallable(getFirebaseFunctions(), 'adminGetDashboardCatalog');
  const res = await fn({});
  return res.data as DashboardCatalog;
}

export async function adminGetWellPool(): Promise<WellPool> {
  const fn = httpsCallable(getFirebaseFunctions(), 'adminGetWellPool');
  const res = await fn({});
  return res.data as WellPool;
}

export async function adminGetWellHistory(wellName: string): Promise<{ pulls: Record<string, unknown>[] }> {
  const fn = httpsCallable(getFirebaseFunctions(), 'adminGetWellHistory');
  const res = await fn({ wellName });
  return res.data as { pulls: Record<string, unknown>[] };
}

export async function adminGetWellPerformance(): Promise<{ rows: Record<string, { d: string; a: number; p: number }[]> }> {
  const fn = httpsCallable(getFirebaseFunctions(), 'adminGetWellPerformance');
  const res = await fn({});
  return res.data as { rows: Record<string, { d: string; a: number; p: number }[]> };
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
