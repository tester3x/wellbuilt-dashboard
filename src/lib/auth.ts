// Authentication utilities
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User
} from 'firebase/auth';
import { ref, get, set } from 'firebase/database';
import { getFirebaseAuth, getFirebaseDatabase } from './firebase';

// Role hierarchy (higher number = more access)
export type UserRole = 'driver' | 'viewer' | 'admin' | 'manager' | 'it';

export const ROLE_LEVELS: Record<UserRole, number> = {
  driver: 1,
  viewer: 1,
  admin: 2,
  manager: 3,
  it: 4,
};

export interface WellBuiltUser {
  uid: string;
  email: string;
  role: UserRole;
  displayName?: string;
  companyId?: string;     // If set, scopes dashboard to this company only
  companyName?: string;   // Display name for the company
}

// Sign in with email/password
export async function signIn(email: string, password: string): Promise<WellBuiltUser> {
  const auth = getFirebaseAuth();
  const result = await signInWithEmailAndPassword(auth, email, password);
  return await getUserWithRole(result.user);
}

// Sign out
export async function signOut(): Promise<void> {
  const auth = getFirebaseAuth();
  await firebaseSignOut(auth);
}

// Get user with role from database
async function getUserWithRole(user: User): Promise<WellBuiltUser> {
  const db = getFirebaseDatabase();
  const userRef = ref(db, `users/${user.uid}`);
  const snapshot = await get(userRef);

  let role: UserRole = 'viewer'; // Default role
  let displayName = user.email || '';

  let companyId: string | undefined;
  let companyName: string | undefined;

  if (snapshot.exists()) {
    const userData = snapshot.val();
    role = userData.role || 'viewer';
    displayName = userData.displayName || displayName;
    companyId = userData.companyId || undefined;
    companyName = userData.companyName || undefined;
  }

  return {
    uid: user.uid,
    email: user.email || '',
    role,
    displayName,
    companyId,
    companyName,
  };
}

// Subscribe to auth state changes
export function subscribeToAuthState(callback: (user: WellBuiltUser | null) => void): () => void {
  const auth = getFirebaseAuth();

  const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
    if (firebaseUser) {
      const user = await getUserWithRole(firebaseUser);
      callback(user);
    } else {
      callback(null);
    }
  });

  return unsubscribe;
}

// Check if user has required role level
export function hasRole(user: WellBuiltUser | null, requiredRole: UserRole): boolean {
  if (!user) return false;
  return ROLE_LEVELS[user.role] >= ROLE_LEVELS[requiredRole];
}

// Check if user can edit a specific pull
// Drivers can only edit their own pulls within time limit
// Admin+ can edit any pull
export function canEditPull(
  user: WellBuiltUser | null,
  pullDriverId: string,
  pullTimestamp: number,
  timeLimitMinutes: number = 30
): boolean {
  if (!user) return false;

  // Admin, manager, IT can edit anything
  if (hasRole(user, 'admin')) return true;

  // Drivers can only edit their own pulls within time limit
  if (user.role === 'driver') {
    const isOwnPull = pullDriverId === user.uid;
    const withinTimeLimit = (Date.now() - pullTimestamp) < (timeLimitMinutes * 60 * 1000);
    return isOwnPull && withinTimeLimit;
  }

  return false;
}

// Check if user can delete pulls (admin+ only)
export function canDeletePull(user: WellBuiltUser | null): boolean {
  return hasRole(user, 'admin');
}
