'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { WellBuiltUser, subscribeToAuthState, signIn, signOut, hasRole, UserRole } from '@/lib/auth';

// DEV MODE - set to false once Firebase Auth is enabled
const DEV_MODE = true;
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
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  hasRole: (role: UserRole) => boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<WellBuiltUser | null>(DEV_MODE ? DEV_USER : null);
  const [loading, setLoading] = useState(!DEV_MODE);

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
