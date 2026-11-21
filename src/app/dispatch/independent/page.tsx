'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppHeader } from '@/components/AppHeader';
import { IndependentDispatchBoard } from '@/components/IndependentDispatchBoard';
import { useAuth } from '@/contexts/AuthContext';
import { hasCapability } from '@/lib/auth';
import { independentDispatchJobs } from '@/lib/independentDispatchJobs';

export default function IndependentDispatchPage() {
  const { user, loading } = useAuth();
  const [access, setAccess] = useState<{ companyId: string; error?: string } | null>(null);
  useEffect(() => {
    let cancelled = false; setAccess(null);
    if (!user || !hasCapability(user, 'viewDispatch')) return;
    void independentDispatchJobs({ op: 'list' }).then(result => {
      if (!cancelled) setAccess({ companyId: result.companyId || '' });
    }).catch(e => { if (!cancelled) setAccess({ companyId: '', error: e.message }); });
    return () => { cancelled = true; };
  }, [user]);
  return <div className="min-h-screen bg-gray-900 text-white"><AppHeader />
    <main className="mx-auto max-w-6xl p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-semibold">Independent Dispatch</h1><div className="flex gap-4 text-sm text-cyan-300"><Link href="/dispatch">Dispatch workspace</Link><Link href="/settings">Job package settings</Link></div></div>
      {loading ? <p>Loading…</p> : !user ? <Link href="/login">Sign in to continue</Link> : !hasCapability(user, 'viewDispatch') ? <p role="alert">You do not have access to Dispatch.</p>
        : !access ? <p>Checking company package…</p> : access.error ? <div role="alert" className="rounded border border-amber-700 p-4"><p>Independent Dispatch is unavailable. Check that your company has the Independent Dispatch job package installed and your staff access is enabled.</p><p className="mt-2 text-sm text-gray-400">{access.error}</p></div>
        : <IndependentDispatchBoard key={`${access.companyId}:${user.uid}`} companyId={access.companyId} canWrite={hasCapability(user, 'createDispatch')} canManageDrivers={hasCapability(user, 'manageDrivers')} />}
    </main>
  </div>;
}
