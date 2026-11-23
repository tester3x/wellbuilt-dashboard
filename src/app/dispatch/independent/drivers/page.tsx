'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppHeader } from '@/components/AppHeader';
import { IndependentDriverProfilesPanel } from '@/components/IndependentDriverProfilesPanel';
import { useAuth } from '@/contexts/AuthContext';
import { hasCapability } from '@/lib/auth';
import { independentDispatchJobs, type LinkedWellBuiltDriver } from '@/lib/independentDispatchJobs';
import { independentDispatchDirectory, type IndependentCustomer } from '@/lib/independentDispatchDirectory';
import { listExternalDrivers, type ExternalDriver } from '@/lib/externalAssignmentDelivery';

export default function IndependentDispatchDriversPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [data, setData] = useState<{ drivers: ExternalDriver[]; wbDrivers: LinkedWellBuiltDriver[]; customers: IndependentCustomer[] } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (loading) return () => { cancelled = true; };
    if (!user) { router.replace('/login'); return () => { cancelled = true; }; }
    if (!hasCapability(user, 'viewDispatch') || !hasCapability(user, 'manageDrivers')) {
      router.replace('/dispatch/independent');
      return () => { cancelled = true; };
    }
    // Both callables enforce the active package and trusted company. Keep the
    // directory and driver roster scoped to the same workspace as the jobs.
    void Promise.all([independentDispatchJobs({ op: 'list' }), independentDispatchDirectory({ op: 'list' }), listExternalDrivers()])
      .then(([jobs, directory, drivers]) => {
        if (cancelled) return;
        if (!jobs.companyId || jobs.companyId !== directory.companyId) throw Error('Driver profiles are unavailable for this company.');
        setData({ drivers, wbDrivers: jobs.wbDrivers || [], customers: directory.customers || [] });
      }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Unable to load driver profiles.'); });
    return () => { cancelled = true; };
  }, [user, loading, router]);

  return <div className="min-h-screen bg-gray-900 text-white"><AppHeader />
    <main className="mx-auto w-full max-w-5xl px-4 py-4 2xl:px-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-semibold">Driver profiles</h1><a className="text-sm text-cyan-300 underline" href="/dispatch/independent/">Back to Independent Dispatch</a></div>
      {error ? <p role="alert" className="rounded border border-red-700 bg-red-950 p-3 text-red-200">{error}</p> : !data ? <p>Loading driver profiles…</p>
        : <IndependentDriverProfilesPanel {...data} initiallyOpen />}
    </main>
  </div>;
}
