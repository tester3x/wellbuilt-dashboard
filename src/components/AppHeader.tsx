'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ref, onValue } from 'firebase/database';
import { useAuth } from '@/contexts/AuthContext';
import { TABS, getActiveTab } from '@/lib/tabs';
import { hasRole } from '@/lib/auth';
import { NotificationBell } from './NotificationBell';
import { getFirebaseDatabase } from '@/lib/firebase';

export function AppHeader() {
  const { user, signOut } = useAuth();
  const pathname = usePathname();
  const activeTabId = getActiveTab(pathname);
  const [pendingDriverCount, setPendingDriverCount] = useState(0);

  // Real-time listener: pending driver count → drives Admin button pulse
  // This is independent of the notification bell. Bell = awareness, pulse = persistent reminder.
  // Pulse stops ONLY when the actual pending drivers are approved/rejected.
  useEffect(() => {
    if (!user) return;
    if (user.role !== 'admin' && user.role !== 'it' && user.role !== 'manager') return;

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
  }, [user]);

  if (!user) return null;

  return (
    <header className="bg-gray-800 border-b border-gray-700">
      {/* Three-column grid: buttons | title+tabs | bell */}
      <div className="w-full grid grid-cols-[auto_1fr_auto] items-start">
        {/* LEFT: Admin + Sign Out, pinned to left edge */}
        <div className="flex items-center gap-2 px-4 pt-3">
          {(user.role === 'admin' || user.role === 'it') && (
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
          <button
            onClick={signOut}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors text-sm"
          >
            Sign Out
          </button>
        </div>

        {/* CENTER: Title + user info + tabs */}
        <div className="flex flex-col items-center">
          <div className="pt-2 pb-1 text-center">
            <h1 className="text-3xl font-bold text-white">WellBuilt Suite</h1>
            <p className="text-gray-400 text-sm">
              {user.email} &bull; <span className="capitalize">{user.role}</span>
            </p>
          </div>
          <nav className="flex gap-0">
            {TABS.filter(tab => !tab.minRole || hasRole(user, tab.minRole)).map((tab) => {
              const isActive = tab.id === activeTabId;
              return (
                <Link
                  key={tab.id}
                  href={tab.href}
                  className={`relative px-5 py-3 text-sm font-medium transition-colors border-b-2 ${
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

        {/* RIGHT: Bell, pinned to right edge */}
        <div className="px-4 pt-3 flex items-center">
          <NotificationBell />
        </div>
      </div>
    </header>
  );
}
