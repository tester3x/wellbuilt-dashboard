'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { TABS, getActiveTab } from '@/lib/tabs';

export function AppHeader() {
  const { user, signOut } = useAuth();
  const pathname = usePathname();
  const activeTabId = getActiveTab(pathname);

  if (!user) return null;

  return (
    <header className="bg-gray-800 border-b border-gray-700">
      {/* Top bar: branding + user actions */}
      <div className="max-w-7xl mx-auto px-4 pt-4 pb-2 flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-white">WellBuilt Suite</h1>
          <p className="text-gray-400 text-sm">
            {user.email} &bull; <span className="capitalize">{user.role}</span>
          </p>
        </div>
        <div className="flex items-center gap-4">
          {(user.role === 'admin' || user.role === 'it') && (
            <Link
              href="/admin"
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
            >
              Admin
            </Link>
          )}
          <button
            onClick={signOut}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
          >
            Sign Out
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="max-w-7xl mx-auto px-4">
        <nav className="flex gap-0">
          {TABS.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <Link
                key={tab.id}
                href={tab.href}
                className={`px-5 py-3 text-sm font-medium transition-colors border-b-2 ${
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
    </header>
  );
}
