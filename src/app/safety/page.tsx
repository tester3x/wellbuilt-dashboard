'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { AppHeader } from '@/components/AppHeader';
import { loadAllCompanies, loadCompanyById, type CompanyConfig } from '@/lib/companySettings';
import { SAFETY_CATEGORIES, decideSafetyAccess } from '@/lib/spill/spillAccess';
import { hasCapability } from '@/lib/auth';
import { listSpillIncidents } from '@/lib/spill/spillIncidentStore';
import { SpillIncidentList } from '@/components/safety/SpillIncidentList';
import type { SpillListFilter, SpillListRow, SpillLoadState } from '@/lib/spill/spillIncidentProjection';

export default function SafetyPage() {
  const { user, loading: authLoading, userCompany } = useAuth();
  const router = useRouter();
  const [companyId, setCompanyId] = useState<string>('');
  const [companies, setCompanies] = useState<CompanyConfig[]>([]);
  const [filter, setFilter] = useState<SpillListFilter>('open');
  const [state, setState] = useState<SpillLoadState>({ kind: 'loading' });
  const [rows, setRows] = useState<SpillListRow[]>([]);
  const access = decideSafetyAccess(user, companyId || user?.companyId || null, {
    canView: hasCapability(user, 'viewSafety', userCompany),
  });

  useEffect(() => {
    if (authLoading) return;
    if (!user) { router.push('/login'); return; }
    if (!access.ok) return;
    if (access.mode === 'tenant' && access.companyId && !companyId) setCompanyId(access.companyId);
  }, [user, authLoading, access.ok, access.ok ? access.mode : '', access.ok ? access.companyId : '']);

  useEffect(() => {
    if (!user || !access.ok || access.mode !== 'platform') return;
    loadAllCompanies().then((list) => {
      setCompanies(list);
      if (!companyId && list[0]) setCompanyId(list[0].id);
    }).catch(() => setCompanies([]));
  }, [user, access.ok]);

  const load = useCallback(async () => {
    const decided = decideSafetyAccess(user, companyId || user?.companyId || null, {
      canView: hasCapability(user, 'viewSafety', userCompany),
    });
    if (!decided.ok) {
      setState({ kind: decided.reason === 'unauthenticated' ? 'denied' : decided.reason === 'cross_company' || decided.reason === 'driver' || decided.reason === 'no_capability' || decided.reason === 'missing_company' ? 'denied' : 'denied' });
      setRows([]);
      return;
    }
    const cid = decided.companyId;
    if (!cid) {
      setState({ kind: 'ready' });
      setRows([]);
      return;
    }
    setState({ kind: 'loading' });
    const name = companies.find((c) => c.id === cid)?.name || (await loadCompanyById(cid).then((c) => c?.name).catch(() => null));
    const result = await listSpillIncidents(cid, { companyName: name || null });
    setState(result.state);
    setRows(result.rows);
  }, [user, userCompany, companyId, companies]);

  useEffect(() => { if (!authLoading && user && access.ok) void load(); }, [authLoading, user, access.ok, companyId, load]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-gray-900">
        <AppHeader />
        <div className="text-gray-400 text-center py-24">Loading...</div>
      </div>
    );
  }

  if (!user || !access.ok) {
    return (
      <div className="min-h-screen bg-gray-900">
        <AppHeader />
        <div className="text-red-400 text-center py-24">
          {access.ok ? '' : access.reason === 'driver'
            ? 'Drivers do not have Dashboard Safety access.'
            : 'You do not have access to Safety.'}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900">
      <AppHeader />
      <main className="max-w-6xl mx-auto px-4 py-8">
        <h2 className="text-2xl font-bold text-white">Safety</h2>
        <p className="text-gray-400 text-sm mt-1 mb-6">Spill incidents first. Other safety categories can be added later.</p>

        <div className="flex gap-6">
          <nav className="w-52 shrink-0 space-y-1">
            {SAFETY_CATEGORIES.map((c) => (
              <div
                key={c.id}
                className={`px-3 py-2 rounded text-sm ${
                  c.live ? 'bg-gray-800 text-white border border-blue-600' : 'text-gray-600 cursor-not-allowed'
                }`}
              >
                {c.label}
                {!c.live && <div className="text-[10px] uppercase tracking-wide">Coming later</div>}
              </div>
            ))}
          </nav>
          <div className="flex-1 min-w-0">
            {access.mode === 'platform' && (
              <div className="mb-4">
                <label className="text-gray-400 text-xs block mb-1">Company</label>
                <select
                  value={companyId}
                  onChange={(e) => setCompanyId(e.target.value)}
                  className="px-3 py-2 bg-gray-700 text-white rounded text-sm w-72"
                >
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>{c.name || c.id}</option>
                  ))}
                </select>
              </div>
            )}
            <SpillIncidentList
              state={state}
              rows={rows}
              filter={filter}
              onFilter={setFilter}
              onRetry={() => void load()}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
