'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppHeader } from '@/components/AppHeader';
import { IndependentDispatchBoard } from '@/components/IndependentDispatchBoard';
import { useAuth } from '@/contexts/AuthContext';
import { hasCapability } from '@/lib/auth';
import { independentDispatchJobs } from '@/lib/independentDispatchJobs';
import { loadCompanyById } from '@/lib/companySettings';
import { hasOnlyIndependentDispatchPackage } from '@/lib/independentDispatchPackage';

export default function IndependentDispatchPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [access, setAccess] = useState<{ companyId: string; standardWorkspace: boolean } | null>(null);
  useEffect(() => {
    let cancelled = false; setAccess(null);
    if (loading) return () => { cancelled = true; };
    if (!user) {
      router.replace('/login');
      return () => { cancelled = true; };
    }
    if (!hasCapability(user, 'viewDispatch')) {
      router.replace('/dispatch');
      return () => { cancelled = true; };
    }
    // The callable checks the trusted company and active package before
    // returning any jobs. A copied URL cannot unlock this board.
    void independentDispatchJobs({ op: 'list' }).then(async result => {
      if (cancelled) return;
      if (!result.companyId) router.replace('/dispatch');
      else {
        // The independent board is authorized by the callable. A separate
        // company read determines whether its standard-workspace link belongs.
        let standardWorkspace = false;
        try {
          const company = await loadCompanyById(result.companyId);
          standardWorkspace = Array.isArray(company?.activePackages)
            && !hasOnlyIndependentDispatchPackage(company.activePackages);
        } catch { /* hide the optional link when package state is unavailable */ }
        if (!cancelled) setAccess({ companyId: result.companyId, standardWorkspace });
      }
    }).catch(() => { if (!cancelled) router.replace('/dispatch'); });
    return () => { cancelled = true; };
  }, [user, loading, router]);
  return <div className="min-h-screen bg-gray-900 text-white"><AppHeader />
    <main className="mx-auto max-w-6xl p-4">
      {!access || !user ? <p>Checking access…</p> : <>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-semibold">Independent Dispatch</h1><div className="flex gap-4 text-sm text-cyan-300">{access.standardWorkspace && <Link href="/dispatch">Dispatch workspace</Link>}<Link href="/settings">Job package settings</Link></div></div>
        <IndependentDispatchBoard key={`${access.companyId}:${user.uid}`} companyId={access.companyId} canWrite={hasCapability(user, 'createDispatch')} canManageDrivers={hasCapability(user, 'manageDrivers')} />
      </>}
    </main>
  </div>;
}
