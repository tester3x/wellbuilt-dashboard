'use client';

/**
 * vc51.9Z — the one-time bootstrap surface.
 *
 * Shown ONLY when the session is authenticated but carries no
 * wellbuiltAdmin claim ('ordinary'). It is a display affordance, nothing
 * more: the server re-decides authorization on the call, an unauthorized
 * caller is refused with a bare "denied", and this card being visible
 * grants no one anything.
 *
 * TEMPORARY. The endpoint is deleted immediately after the first
 * successful use, at which point this card's action returns
 * bootstrap_completed and the card should be removed with it.
 */

import { useState } from 'react';
import { runFirstAdminBootstrap } from '@/lib/firstAdminBootstrap';

export function FirstAdminBootstrapCard({ onGranted }: { onGranted: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await runFirstAdminBootstrap();
      if (r.ok) {
        setNote('Platform administrator access granted. Re-checking your session…');
        // runFirstAdminBootstrap already forced the token refresh.
        await onGranted();
      } else {
        setNote(r.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-gray-800 border border-amber-600/50 rounded-lg p-4 max-w-xl mb-4">
      <h3 className="text-white text-sm font-medium mb-1">Platform administration not yet activated</h3>
      <p className="text-gray-300 text-sm">
        This installation has no enabled platform administrator. If this account is the
        designated platform owner, activate it once here. Your password is never sent —
        your existing sign-in is the proof.
      </p>
      <button
        onClick={() => { void run(); }}
        disabled={busy}
        className="mt-3 px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
      >
        {busy ? 'Activating…' : 'Activate platform administration'}
      </button>
      {note && <p className="mt-3 text-sm text-gray-200 break-words">{note}</p>}
    </div>
  );
}
