'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { type CompanyConfig } from '@/lib/companySettings';
import { usePathname, useRouter } from 'next/navigation';
import { ref, onValue } from 'firebase/database';
import { useAuth } from '@/contexts/AuthContext';
import { TABS, getActiveTab } from '@/lib/tabs';
import { getRoleLabel, hasCapability, hasEQuipmentAccess, hasRole, isPlatformAdmin } from '@/lib/auth';
import { NotificationBell } from './NotificationBell';
import { ChatIcon } from './chat/ChatIcon';
import { ChatSidebar } from './chat/ChatSidebar';
import { getFirebaseDatabase } from '@/lib/firebase';
import { rememberedTabHref, rememberTabHref } from '@/lib/dashboardReturnState';

export function AppHeader() {
  const { user, userCompany, signOut, operatingCompanyId, selectOperatingCompany } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const activeTabId = getActiveTab(pathname);
  const [pendingDriverCount, setPendingDriverCount] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [companies, setCompanies] = useState<CompanyConfig[]>([]);
  useEffect(() => {
    if (!isPlatformAdmin(user)) return;
    let cancelled = false;
    import('@/lib/companySettings').then(m => m.loadAllCompanies()).then(rows => { if (!cancelled) setCompanies(rows); }).catch(console.error);
    return () => { cancelled = true; };
  }, [user]);
  const [chatUnread, setChatUnread] = useState(0);
  const [returnLinks, setReturnLinks] = useState<Record<string, string>>({});
  useEffect(() => {
    setReturnLinks(user ? Object.fromEntries(TABS.map(tab => [tab.id, rememberedTabHref(user.uid, operatingCompanyId, tab.id, tab.href)])) : {});
  }, [user?.uid, operatingCompanyId, pathname]);

  // Real-time listener: pending driver count → drives Admin button pulse
  // This is independent of the notification bell. Bell = awareness, pulse = persistent reminder.
  // Pulse stops ONLY when the actual pending drivers are approved/rejected.
  useEffect(() => {
    if (!user) return;
    if (!hasCapability(user, 'manageDrivers', userCompany)) return;

    const db = getFirebaseDatabase();
    const pendingRef = ref(db, 'drivers/pending');
    const unsub = onValue(pendingRef, (snap) => {
      if (!snap.exists()) { setPendingDriverCount(0); return; }
      let count = 0;
      Object.values(snap.val()).forEach((entry: any) => {
        if (entry.status !== 'approved' && entry.status !== 'rejected') count++;
      });
      setPendingDriverCount(count);
    }, () => {
      import('@/lib/adminDashboardCatalog').then(({ adminGetDashboardCatalog }) =>
        adminGetDashboardCatalog().then((catalog) => {
          let count = 0;
          Object.values(catalog.pending || {}).forEach((entry: any) => {
            if (entry.status !== 'approved' && entry.status !== 'rejected') count++;
          });
          setPendingDriverCount(count);
        })
      ).catch(() => setPendingDriverCount(0));
    });
    return () => unsub();
  }, [user, userCompany]);

  if (!user) return null;

  return (
    <header className="bg-gray-800 border-b border-gray-700 sticky top-0 z-40">
      {/* Compact account identity shares the tools row; navigation stays full-width. */}
      <div className="w-full min-w-0 flex flex-col items-center gap-1 px-3 pt-2">
        {/* LEFT: Admin + Truth tools (admin/it) + Sign Out, pinned to left edge */}
        <div aria-label="Account and administration" className="order-2 w-full min-w-0 flex flex-wrap justify-center items-center gap-2 [&>a]:whitespace-nowrap [&>button]:whitespace-nowrap">
          <div aria-label="Signed-in account" className="mr-auto min-w-0 max-w-full text-left">
            <h1 className="text-sm font-semibold leading-tight text-white">WellBuilt Suite</h1>
            <p className="max-w-[18rem] truncate text-xs leading-tight text-gray-400" title={`${user.email} • ${getRoleLabel(user.role, userCompany)}`}>
              {user.email} &bull; <span>{getRoleLabel(user.role, userCompany)}</span>
            </p>
          </div>
        {isPlatformAdmin(user) && <label className="flex max-w-full items-center gap-2 text-xs text-gray-300">Company
          <select aria-label="Operating company" value={operatingCompanyId || ''} onChange={e => selectOperatingCompany(e.target.value)} className="min-w-0 max-w-[12rem] rounded bg-gray-700 px-2 py-1.5 text-xs text-white">
            <option value="">Show all companies</option>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
          </select>
        </label>}
          {hasCapability(user, 'viewAdmin', userCompany) && (
            <Link
              href={pendingDriverCount > 0 ? '/admin?tab=drivers' : '/admin'}
              className="relative px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors text-xs"
            >
              Admin
              {pendingDriverCount > 0 && !pathname.startsWith('/admin') && (
                <span className="absolute -top-1.5 -right-1.5 flex h-5 w-5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-5 w-5 bg-red-500 text-[10px] text-white items-center justify-center font-bold">
                    {pendingDriverCount}
                  </span>
                </span>
              )}
            </Link>
          )}
          {!user?.companyId && (hasCapability(user, 'viewTruthDebug', userCompany) || hasCapability(user, 'viewDiagnostics', userCompany)) && (
            <details className="relative group">
              <summary className="cursor-pointer list-none rounded px-2.5 py-1.5 text-xs text-gray-200 bg-gray-700 hover:bg-gray-600 select-none">
                Admin Tools <span aria-hidden="true">▾</span>
              </summary>
              <div aria-label="Admin tools" className="absolute left-0 top-full mt-1 z-50 flex min-w-40 flex-col gap-1 rounded-lg border border-gray-600 bg-gray-800 p-2 shadow-xl">
                {!user?.companyId && hasCapability(user, 'viewTruthDebug', userCompany) && (
                  <>
                    {/* Plain <a> (full document load) — bypasses App Router prefetch
                        cache + stale chunk refs that caused intermittent click failures
                        on these admin-only routes. Right-click open-in-new-tab already
                        does this; the buttons should match. */}
                    <a
                      href="/admin/truth-debug/"
                      className={`px-3 py-2 rounded-lg transition-colors text-xs ${
                        pathname.startsWith('/admin/truth-debug')
                          ? 'bg-gray-600 text-white'
                          : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
                      }`}
                    >
                      Truth Debug
                    </a>
                    <a
                      href="/admin/truth-rag-exports/"
                      className={`px-3 py-2 rounded-lg transition-colors text-xs ${
                        pathname.startsWith('/admin/truth-rag-exports')
                          ? 'bg-gray-600 text-white'
                          : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
                      }`}
                    >
                      Truth RAG
                    </a>
                  </>
                )}
                {!user?.companyId && hasCapability(user, 'viewDiagnostics', userCompany) && (
                  <a
                    href="/admin/diagnostics/"
                    className={`px-3 py-2 rounded-lg transition-colors text-xs ${
                      pathname.startsWith('/admin/diagnostics')
                        ? 'bg-gray-600 text-white'
                        : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
                    }`}
                  >
                    WB Diagnostics
                  </a>
                )}
              </div>
            </details>
          )}
          <button
            onClick={async () => {
              await signOut();
              if (user.uid === 'wellbuilt-demo-shared-viewer') {
                sessionStorage.removeItem('wellbuilt-demo-viewer-tab');
                window.location.assign('/');
              } else {
                router.push('/login');
              }
            }}
            className="px-2.5 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors text-xs"
          >
            {user.uid === 'wellbuilt-demo-shared-viewer' ? 'Leave Demo' : 'Sign Out'}
          </button>
          <div aria-label="Chat and notifications" className="ml-auto flex items-center gap-2">
            <ChatIcon onClick={() => setChatOpen(!chatOpen)} unreadCount={chatUnread} />
            <NotificationBell />
          </div>
        </div>

        {/* Main navigation keeps its own centered row. */}
        <div className="contents">
          <nav aria-label="Main navigation" className="order-3 flex w-full min-w-0 flex-wrap justify-center gap-x-1 gap-y-0">
            {TABS.filter(tab => {
              if (tab.id === 'equipment') return hasEQuipmentAccess(user, userCompany);
              // Capability-based gate wins when set. Falls back to legacy minRole
              // only if capability is unset (e.g., Home tab with no gate at all).
              if (tab.capability) return hasCapability(user, tab.capability, userCompany);
              if (tab.minRole) return hasRole(user, tab.minRole);
              return true;
            }).map((tab) => {
              const isActive = tab.id === activeTabId;
              return (
                <Link
                  key={tab.id}
                  href={returnLinks[tab.id] || tab.href}
                  onClick={event => {
                    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    rememberTabHref(user.uid, operatingCompanyId);
                    const href = rememberedTabHref(user.uid, operatingCompanyId, tab.id, tab.href);
                    event.preventDefault(); router.push(href);
                  }}
                  className={`relative whitespace-nowrap px-3 py-2 text-sm font-medium transition-colors border-b-2 ${
                    isActive
                      ? 'border-blue-500 text-white'
                      : 'border-transparent text-gray-400 hover:text-gray-200 hover:border-gray-600'
                  }`}
                >
                  {tab.label}
                </Link>
              );
            })}
          </nav>
        </div>

      </div>

      {/* Chat Sidebar */}
      <ChatSidebar
        visible={chatOpen}
        onClose={() => setChatOpen(false)}
        userId={user?.uid || ''}
        companyId={user?.companyId || ''}
        onUnreadChange={setChatUnread}
      />
    </header>
  );
}
