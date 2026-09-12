'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ref, onValue } from 'firebase/database';
import { useAuth } from '@/contexts/AuthContext';
import { TABS, getActiveTab } from '@/lib/tabs';
import { getRoleLabel, hasCapability, hasEQuipmentAccess, hasRole } from '@/lib/auth';
import { NotificationBell } from './NotificationBell';
import { ChatIcon } from './chat/ChatIcon';
import { ChatSidebar } from './chat/ChatSidebar';
import { getFirebaseDatabase } from '@/lib/firebase';

export function AppHeader() {
  const { user, userCompany, signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const activeTabId = getActiveTab(pathname);
  const [pendingDriverCount, setPendingDriverCount] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatUnread, setChatUnread] = useState(0);

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
      {/* Full-width rows keep the title and navigation centered independently of tools. */}
      <div className="w-full min-w-0 flex flex-col items-center gap-2 px-3 pt-3">
        {/* LEFT: Admin + Truth tools (admin/it) + Sign Out, pinned to left edge */}
        <div aria-label="Account and administration" className="order-2 w-full min-w-0 flex flex-wrap justify-center items-center gap-2 [&>a]:whitespace-nowrap [&>button]:whitespace-nowrap">
          {hasCapability(user, 'viewAdmin', userCompany) && (
            <Link
              href={pendingDriverCount > 0 ? '/admin?tab=drivers' : '/admin'}
              className="relative px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors text-sm"
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
          {!user?.companyId && hasCapability(user, 'viewTruthDebug', userCompany) && (
            <>
              {/* Plain <a> (full document load) — bypasses App Router prefetch
                  cache + stale chunk refs that caused intermittent click failures
                  on these admin-only routes. Right-click open-in-new-tab already
                  does this; the buttons should match. */}
              <a
                href="/admin/truth-debug/"
                className={`px-3 py-2 rounded-lg transition-colors text-sm ${
                  pathname.startsWith('/admin/truth-debug')
                    ? 'bg-gray-600 text-white'
                    : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
                }`}
              >
                Truth Debug
              </a>
              <a
                href="/admin/truth-rag-exports/"
                className={`px-3 py-2 rounded-lg transition-colors text-sm ${
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
              className={`px-3 py-2 rounded-lg transition-colors text-sm ${
                pathname.startsWith('/admin/diagnostics')
                  ? 'bg-gray-600 text-white'
                  : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
              }`}
            >
              WB Diagnostics
            </a>
          )}
          <button
            onClick={async () => {
              await signOut();
              router.push('/login');
            }}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors text-sm"
          >
            Sign Out
          </button>
        </div>

        {/* CENTER: Title + user info + tabs */}
        <div className="contents">
          <div className="order-1 w-full min-w-0 grid grid-cols-[5.5rem_minmax(0,1fr)_5.5rem] items-start text-center">
            <div aria-hidden="true" />
            <div className="min-w-0">
            <h1 className="text-xl sm:text-3xl font-bold text-white">WellBuilt Suite</h1>
            <p className="text-gray-400 text-sm break-words">
              {user.email} &bull; <span>{getRoleLabel(user.role, userCompany)}</span>
            </p>
            </div>
            <div aria-label="Chat and notifications" className="flex justify-end items-center gap-2">
              <ChatIcon onClick={() => setChatOpen(!chatOpen)} unreadCount={chatUnread} />
              <NotificationBell />
            </div>
          </div>
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
                  href={tab.href}
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
