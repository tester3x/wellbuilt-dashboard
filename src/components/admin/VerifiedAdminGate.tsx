'use client';

/**
 * vc51.9A7 — renders protected admin surfaces only for a verified
 * session; every other state shows the honest bounded message from
 * adminUiLogic.sessionMessage with an accessible deliberate refresh
 * control. Display gate only — the server re-authorizes every call.
 */

import { sessionMessage, type AdminSessionState } from '@/lib/adminUiLogic';
import type { ReactNode } from 'react';
import { useState } from 'react';

export function VerifiedAdminGate({ session, onRefresh, children }: {
  session: AdminSessionState;
  onRefresh: () => Promise<void>;
  children: ReactNode;
}) {
  const [refreshing, setRefreshing] = useState(false);
  if (session.status === 'verified') return <>{children}</>;
  const msg = sessionMessage(session);
  return (
    <div role="status" aria-live="polite" className="bg-gray-800 border border-gray-600 rounded-lg p-4 max-w-xl">
      <h3 className="text-white text-sm font-medium mb-1">{msg.title}</h3>
      <p className="text-gray-300 text-sm">{msg.body}</p>
      {msg.showRefresh && (
        <button
          onClick={async () => {
            if (refreshing) return;
            setRefreshing(true);
            try { await onRefresh(); } finally { setRefreshing(false); }
          }}
          disabled={refreshing}
          className="mt-3 px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
        >
          {refreshing ? 'Refreshing…' : 'Refresh administrator access'}
        </button>
      )}
    </div>
  );
}
