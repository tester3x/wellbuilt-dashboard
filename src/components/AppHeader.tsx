'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ref, onValue } from 'firebase/database';
import { useAuth } from '@/contexts/AuthContext';
import { TABS, getActiveTab } from '@/lib/tabs';
import { getRoleLabel, hasCapability, hasRole } from '@/lib/auth';
import { NotificationBell } from './NotificationBell';
import { ChatIcon } from './chat/ChatIcon';
import { ChatSidebar } from './chat/ChatSidebar';
import { getFirebaseDatabase } from '@/lib/firebase';

export function AppHeader() {
  const { user, userCompany, signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const activeTabId = getActiveTab(pathname);
  // Existing company branding accent (Settings → Branding → primaryColor).
  // WB admins (no company) fall back to the WellBuilt blue identity.
  const accent = userCompany?.primaryColor || '#3b82f6';
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
    });
    return () => unsub();
  }, [user, userCompany]);

  if (!user) return null;

  return (
    <header className="bg-gray-800 border-b border-gray-700 sticky top-0 z-40">
      {/* Three-column grid: buttons | title+tabs | bell */}
      <div className="w-full grid grid-cols-[auto_1fr_auto] items-start">
        {/* LEFT: Admin + Truth tools (admin/it) + Sign Out, pinned to left edge.
            flex-wrap so on narrow/tablet-portrait widths these buttons reflow to
            extra lines instead of overflowing off-screen (the grid `auto` track
            then floors at one button wide, not the whole row). */}
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
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
          {hasCapability(user, 'viewTruthDebug', userCompany) && (
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
          {hasCapability(user, 'viewDiagnostics', userCompany) && (
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

        {/* CENTER: Title + user info + tabs. min-w-0 lets the 1fr track shrink
            below the tabs' natural width so the nav (flex-wrap below) can wrap
            instead of pushing the right column off-screen. */}
        <div className="flex flex-col items-center min-w-0">
          <div className="pt-2 pb-1.5 text-center">
            <h1 className="text-2xl font-bold text-white leading-tight">
              WellBuilt <span className="text-gray-300 font-semibold">Suite</span>
            </h1>
            {/* Subtle company-accent bar under the brand (existing primaryColor). */}
            <div className="mx-auto mt-1 h-0.5 w-10 rounded-full" style={{ backgroundColor: accent }} />
            {userCompany?.name && (
              <p className="mt-1.5 text-sm font-semibold text-white leading-tight">{userCompany.name}</p>
            )}
            <p className="text-gray-400 text-xs mt-0.5">
              {user.email} <span className="text-gray-600">&bull;</span> {getRoleLabel(user.role, userCompany)}
            </p>
          </div>
          {/* Cabinet folder tabs — raised active folder, accent top edge, sits on
              a shared baseline so sections read like an application, not a menu. */}
          <nav className="flex flex-wrap items-end justify-center gap-1 border-b border-gray-700 px-2">
            {TABS.filter(tab => {
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
                  aria-current={isActive ? 'page' : undefined}
                  style={isActive ? { borderTopColor: accent } : undefined}
                  className={`relative -mb-px rounded-t-lg border border-gray-700 px-5 text-sm font-medium transition-all outline-none focus-visible:ring-2 focus-visible:ring-white/40 ${
                    isActive
                      ? 'bg-gray-900 text-white border-t-2 border-b-gray-900 pt-1.5 pb-2.5 -translate-y-px shadow-sm'
                      : 'bg-gray-800/60 text-gray-400 border-b-transparent pt-1.5 pb-2 hover:bg-gray-700/70 hover:text-gray-200'
                  }`}
                >
                  {tab.label}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* RIGHT: Chat + Bell, pinned to right edge */}
        <div className="px-4 pt-3 flex items-center gap-2">
          <ChatIcon onClick={() => setChatOpen(!chatOpen)} unreadCount={chatUnread} />
          <NotificationBell />
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
