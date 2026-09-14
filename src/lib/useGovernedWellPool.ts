'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { canViewGlobalWellPool } from '@/lib/tenantScope';
import { adminGetWellPool, classifiedReadFailure } from '@/lib/adminDashboardCatalog';
import { WellResponse, mergeWellPool } from '@/lib/wells';

export interface GovernedWellPool {
  /** Merged, catalog-left-joined well rows (raw last-pull fields carried through). */
  wells: WellResponse[];
  /** Distinct routes present (excludes the synthetic "Unrouted"). */
  routes: string[];
  /** True until the first governed response (or the no-entitlement decision) lands. */
  dataLoading: boolean;
  /** The caller is not entitled to the global pool (server or client scope says so). */
  notEntitled: boolean;
  /** A genuine governed-source failure (retries exhausted) — honest UNAVAILABLE, not empty. */
  statusUnavailable: boolean;
  /** Classified read-failure message when statusUnavailable, else undefined. */
  readError?: string;
}

/**
 * The ONE authorized live well-status source for dashboard (email/password) users.
 *
 * Dashboard users hold NO driver/staff/wellbuiltAdmin RTDB claims, so the direct
 * `packets/outgoing` subscription is permission-denied for them. This hook uses the
 * governed `adminGetWellPool` callable + `mergeWellPool` contract — the identical
 * source the Dispatch board uses — so /mobile, /well, Dispatch and the modals all
 * read the same governed response. It NEVER falls back to the forbidden RTDB path or
 * to catalog-only data: a real failure surfaces as `statusUnavailable` with a reason.
 *
 * The governed read is one-shot; a bounded 60s interval refreshes it (matching
 * Dispatch). Time-based LEVEL advancement is a separate concern handled by the
 * shared ticker (useSharedNow) + projectWellLevel, so the estimate advances between
 * these 60s governed refreshes without any extra network traffic.
 */
export function useGovernedWellPool(refreshMs = 60000): GovernedWellPool {
  const { user, loading } = useAuth();
  const [wells, setWells] = useState<WellResponse[]>([]);
  const [routes, setRoutes] = useState<string[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [notEntitled, setNotEntitled] = useState(false);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const [readError, setReadError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (loading) return;
    if (!user) { setDataLoading(false); return; }
    // Tenant containment: only Owner / Liquid Gold / platform admins are entitled to
    // the global pool. A scoped company has no governed own-pool read (backend gap)
    // → empty by design, not an error and NOT a reason to try the forbidden RTDB path.
    if (!canViewGlobalWellPool(user)) {
      setWells([]); setRoutes([]); setNotEntitled(true);
      setStatusUnavailable(false); setReadError(undefined); setDataLoading(false);
      return;
    }
    setNotEntitled(false);
    let cancelled = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      try {
        const pool = await adminGetWellPool();
        if (cancelled) return;
        if (pool.canViewWellPool === false) {
          setWells([]); setRoutes([]); setNotEntitled(true);
          setStatusUnavailable(false); setReadError(undefined); setDataLoading(false);
          return;
        }
        const wellsData = mergeWellPool(
          (pool.wellConfig || {}) as Record<string, unknown>,
          (pool.wellStatus || {}) as Record<string, unknown>,
        );
        const routeList = [...new Set(wellsData.map(w => w.route).filter((r): r is string => !!r))];
        setWells(wellsData);
        setRoutes(routeList.filter(r => r !== 'Unrouted'));
        setStatusUnavailable(false); setReadError(undefined); setDataLoading(false);
      } catch (err) {
        if (cancelled) return;
        attempts += 1;
        // Bounded retry ONLY because a cold-start token can finish restoring and make
        // the governed callable authorized — not a permanent denial.
        if (attempts < 2) { retryTimer = setTimeout(load, 1500); return; }
        setStatusUnavailable(true);
        setWells([]); setRoutes([]);
        setReadError(classifiedReadFailure('well live status', err));
        setDataLoading(false);
      }
    };

    load();
    refreshTimer = setInterval(() => { if (!cancelled) load(); }, refreshMs);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (refreshTimer) clearInterval(refreshTimer);
    };
  }, [user, loading, refreshMs]);

  return { wells, routes, dataLoading, notEntitled, statusUnavailable, readError };
}
