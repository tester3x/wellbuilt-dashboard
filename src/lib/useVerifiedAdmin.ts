/**
 * vc51.9A7 — verified-admin session hook.
 *
 * Wraps the pure state machine in adminUiLogic.ts with the real token
 * source (getIdTokenResult / getIdToken(true)) and a single bounded
 * protected probe (adminListPlans limit 1) so "claim present but server
 * record disabled" surfaces honestly at entry instead of on the first
 * mutation. ONE verification pass per trigger — no refresh loop, no
 * polling, no logging of tokens or claim values. The client state only
 * controls what is DISPLAYED; every protected callable re-decides
 * authority server-side.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { getFirebaseAuth } from './firebase';
import { createAdminContractService } from './adminContractService';
import { verifyAdminSession, type AdminSessionState } from './adminUiLogic';

export function useVerifiedAdmin(): {
  session: AdminSessionState;
  /** Deliberate "Refresh administrator access" — getIdToken(true), once. */
  refreshAccess: () => Promise<void>;
} {
  const { user, loading } = useAuth();
  const [session, setSession] = useState<AdminSessionState>({ status: 'verifying' });
  const inFlight = useRef(false);

  const verify = useCallback(async (forceRefresh: boolean) => {
    if (inFlight.current) return; // no overlapping passes, ever
    inFlight.current = true;
    setSession({ status: 'verifying' });
    try {
      const service = createAdminContractService();
      const next = await verifyAdminSession({
        signedIn: !!getFirebaseAuth().currentUser,
        getClaims: async (force) => {
          const current = getFirebaseAuth().currentUser;
          if (!current) return null;
          if (force) await current.getIdToken(true);
          const result = await current.getIdTokenResult();
          return result.claims as Record<string, unknown>;
        },
        probe: async () => { await service.listPlans({ limit: 1 }); },
      }, { forceRefresh });
      setSession(next);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!user) { setSession({ status: 'signed_out' }); return; }
    void verify(false);
  }, [user, loading, verify]);

  const refreshAccess = useCallback(async () => { await verify(true); }, [verify]);

  return { session, refreshAccess };
}
