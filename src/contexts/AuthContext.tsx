'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { WellBuiltUser, subscribeToAuthState, signIn, signOut, hasRole, UserRole } from '@/lib/auth';
import { loadCompanyById, type CompanyConfig } from '@/lib/companySettings';
import { computeAuthResolved } from '@/lib/authGateCore';

// Firebase Auth is enabled. DEV_MODE exists only as an emergency escape hatch
// for local work when real auth is unavailable; deployed builds must run with
// DEV_MODE = false so sign-out and admin-gated callables behave correctly.
const DEV_MODE = false;
const DEV_USER: WellBuiltUser = {
  uid: 'dev',
  email: 'dev@wellbuilt.com',
  role: 'it',
  displayName: 'Dev Admin',
  // No companyId = WB admin (sees everything)
  // To test company-scoped view, set: companyId: 'liquidgold', companyName: 'Liquid Gold'
};

interface AuthContextType {
  user: WellBuiltUser | null;
  loading: boolean;
  /**
   * The user's company config, loaded once auth resolves and user.companyId is set.
   * WB admins (no companyId) get null — their capability checks use defaults only.
   * Consumers pass this to hasCapability(user, cap, userCompany) / getRoleLabel.
   */
  userCompany: CompanyConfig | null;
  /** True while a scoped user's company config is still being fetched. */
  companyLoading: boolean;
  /**
   * True only once BOTH auth and (for company-scoped users) company hydration have
   * settled. Capability-gated pages MUST wait on this before any fallback navigation,
   * so a slow company load can never bounce a deep-linked screen to home.
   */
  authResolved: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  hasRole: (role: UserRole) => boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<WellBuiltUser | null>(DEV_MODE ? DEV_USER : null);
  const [loading, setLoading] = useState(!DEV_MODE);
  const [userCompany, setUserCompany] = useState<CompanyConfig | null>(null);
  // Starts true (non-dev) so authResolved stays false through the window between
  // auth settling and the company effect running — no premature home redirect.
  const [companyLoading, setCompanyLoading] = useState(!DEV_MODE);

  useEffect(() => {
    // Skip Firebase auth subscription in dev mode
    if (DEV_MODE) {
      return;
    }

    const unsubscribe = subscribeToAuthState((user) => {
      setUser(user);
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  // Whenever the user's companyId changes (login, role reassignment, logout),
  // load that company's config. WB admins (no companyId) get null — their
  // capability checks fall back to DEFAULT_ROLE_CAPABILITIES.
  useEffect(() => {
    const cid = user?.companyId;
    if (!cid) {
      setUserCompany(null);
      setCompanyLoading(false); // no company to hydrate (WB admin / signed out)
      return;
    }
    let cancelled = false;
    setCompanyLoading(true); // explicit unresolved state while the config loads
    loadCompanyById(cid)
      .then(cfg => { if (!cancelled) setUserCompany(cfg); })
      .catch(err => {
        console.warn('[AuthContext] failed to load userCompany:', err);
        if (!cancelled) setUserCompany(null);
      })
      .finally(() => { if (!cancelled) setCompanyLoading(false); });
    return () => { cancelled = true; };
  }, [user?.companyId]);

  const handleSignIn = async (email: string, password: string) => {
    if (DEV_MODE) {
      // In dev mode, any login works
      setUser({ ...DEV_USER, email });
      return;
    }
    const user = await signIn(email, password);
    setUser(user);
  };

  const handleSignOut = async () => {
    if (DEV_MODE) {
      // In dev mode, just reset to dev user
      setUser(DEV_USER);
      return;
    }
    await signOut();
    setUser(null);
  };

  const checkRole = (role: UserRole) => hasRole(user, role);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        userCompany,
        companyLoading,
        authResolved: computeAuthResolved({ loading, companyLoading }),
        signIn: handleSignIn,
        signOut: handleSignOut,
        hasRole: checkRole,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
