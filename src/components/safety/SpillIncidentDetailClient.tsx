'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { AppHeader } from '@/components/AppHeader';
import { loadCompanyById } from '@/lib/companySettings';
import { decideSafetyAccess } from '@/lib/spill/spillAccess';
import { hasCapability } from '@/lib/auth';
import { getSpillIncident } from '@/lib/spill/spillIncidentStore';
import { SpillIncidentDetail } from '@/components/safety/SpillIncidentDetail';
import type { SpillDetailView, SpillLoadState } from '@/lib/spill/spillIncidentProjection';
import {
  parseSpillDetailIncidentId,
  spillDetailRouteErrorCopy,
} from '@/lib/spill/spillDetailRoute';

export function SpillIncidentDetailClient() {
  const { user, loading: authLoading, userCompany } = useAuth();
  const router = useRouter();
  const search = useSearchParams();
  const pathname = usePathname();
  const parsed = parseSpillDetailIncidentId({
    searchIncidentId: search.get('incidentId'),
    pathname,
  });
  const requestedCompany = search.get('companyId') || user?.companyId || '';
  const access = decideSafetyAccess(user, requestedCompany, {
    canView: hasCapability(user, 'viewSafety', userCompany),
  });
  const [state, setState] = useState<SpillLoadState>({ kind: 'loading' });
  const [detail, setDetail] = useState<SpillDetailView | null>(null);

  const load = useCallback(async () => {
    if (!parsed.ok) {
      setState({ kind: 'empty' });
      setDetail(null);
      return;
    }
    const decided = decideSafetyAccess(user, requestedCompany, {
      canView: hasCapability(user, 'viewSafety', userCompany),
    });
    if (!decided.ok || !decided.companyId) {
      setState({ kind: 'denied' });
      setDetail(null);
      return;
    }
    setState({ kind: 'loading' });
    const company = await loadCompanyById(decided.companyId).catch(() => null);
    const result = await getSpillIncident(decided.companyId, parsed.incidentId, {
      companyName: company?.name || null,
    });
    setState(result.state);
    setDetail(result.detail);
  }, [user, userCompany, requestedCompany, parsed.ok, parsed.ok ? parsed.incidentId : '']);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { router.push('/login'); return; }
    void load();
  }, [authLoading, user, load, router]);

  return (
    <div className="min-h-screen bg-gray-900">
      <AppHeader />
      <main className="max-w-4xl mx-auto px-4 py-8">
        <Link href="/safety" className="text-blue-400 text-sm hover:underline">← Safety</Link>
        <h2 className="text-2xl font-bold text-white mt-2 mb-6">Spill incident</h2>
        {!parsed.ok ? (
          <div className="text-red-400 text-center py-16">
            <p>{spillDetailRouteErrorCopy(parsed.reason)}</p>
            <p className="mt-3">
              <Link href="/safety" className="text-blue-400 hover:underline">Back to Safety</Link>
            </p>
          </div>
        ) : (
          <SpillIncidentDetail
            state={access.ok ? state : { kind: 'denied' }}
            detail={detail}
            canManage={hasCapability(user, 'manageSafety', userCompany)}
            onRetry={() => void load()}
          />
        )}
      </main>
    </div>
  );
}
