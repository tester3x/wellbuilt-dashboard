'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { hasOnlyIndependentDispatchPackage } from '@/lib/independentDispatchPackage';

const INDEPENDENT_ROUTES = ['/dispatch/independent', '/settings', '/login'];

/** Keep package-only tenants out of WB-M, tickets, billing, and the standard dispatch workspace. */
export function IndependentDispatchRouteGate({ children }: { children: ReactNode }) {
  const { user, userCompany, authResolved } = useAuth();
  const pathname = usePathname().replace(/\/$/, '') || '/';
  const router = useRouter();
  const independentOnly = !!user?.companyId && hasOnlyIndependentDispatchPackage(userCompany?.activePackages);
  const allowed = INDEPENDENT_ROUTES.includes(pathname);
  useEffect(() => {
    if (authResolved && independentOnly && !allowed) router.replace('/dispatch/independent');
  }, [authResolved, independentOnly, allowed, router]);
  if (user?.companyId && !authResolved) return <main className="min-h-screen bg-gray-900 p-8 text-gray-300">Loading company workspace…</main>;
  if (user?.companyId && !userCompany) return <main className="min-h-screen bg-gray-900 p-8 text-gray-300">Company workspace unavailable. Refresh this page to try again.</main>;
  if (independentOnly && !allowed) return <main className="min-h-screen bg-gray-900 p-8 text-gray-300">Opening Independent Dispatch…</main>;
  return <>{children}</>;
}
