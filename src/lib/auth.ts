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

// ── Role primitives ─────────────────────────────────────────────────────────
// Seven canonical roles. Customers can RELABEL (roleLabels on companies/{id})
// but cannot invent new role primitives — security rules / Cloud Functions
// reference these strings. Relabelling does not change logic, only display.
export type UserRole = 'driver' | 'viewer' | 'dispatch' | 'payroll' | 'manager' | 'admin' | 'it';

// Role hierarchy — kept for backwards-compatibility with hasRole(). New code
// should prefer hasCapability() instead; hasRole() is only useful for coarse
// gates like "is this person anything above a driver?"
export const ROLE_LEVELS: Record<UserRole, number> = {
  driver: 1,
  viewer: 1,
  dispatch: 2,
  payroll: 2,
  manager: 3,
  admin: 4,
  it: 5,
};

// ── Capabilities ────────────────────────────────────────────────────────────
// Each capability = one gated surface or action. Add new ones here when new
// features land. Capability names are stable strings — security rules and
// Cloud Functions reference them. Customers cannot invent new capabilities.
export type Capability =
  // Tabs / surfaces
  | 'viewHome'
  | 'viewMobile'
  | 'viewTickets'
  | 'viewDispatch'
  | 'viewBilling'
  | 'viewPayroll'
  | 'viewDriverLogs'
  | 'viewSettings'
  | 'viewAdmin'
  | 'viewChat'
  // Actions
  | 'createDispatch'
  | 'manageDrivers'          // approve / reject / delete driver registrations
  | 'manageCompany'          // edit company config (rates, features)
  | 'editBilling'            // generate bills, set fuel prices
  | 'approvePayroll'
  | 'manageWells'            // add / edit / remove wells
  | 'manageRoutes'           // add / approve / edit GPS routes
  | 'manageEquipment'        // equipment docs, truck/trailer admin
  | 'sendChat'
  // Meta (system owner only)
  | 'manageRolesAndCapabilities'  // edit roleLabels / roleCapabilities per company
  | 'viewAllCompanies'            // WB-admin-only — cross-company visibility
  | 'viewTruthDebug'              // Phase 26/27 truth layer tools
  ;

// Default capability sets per role. Customers can OVERRIDE per-company via
// companies/{id}.roleCapabilities. Unset → fallback to this default.
//
// Philosophy:
//   `it`      — company owner, every capability (including meta)
//   `admin`   — everything except meta (can't rewrite roles themselves)
//   `manager` — dispatch + payroll oversight, no company-level admin
//   `dispatch`— dispatch work only
//   `payroll` — payroll + billing only
//   `viewer`  — read-only across core surfaces
//   `driver`  — nothing admin-level (WB T / WB S apps only)
export const DEFAULT_ROLE_CAPABILITIES: Record<UserRole, Capability[]> = {
  it: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewBilling',
    'viewPayroll', 'viewDriverLogs', 'viewSettings', 'viewAdmin', 'viewChat',
    'createDispatch', 'manageDrivers', 'manageCompany', 'editBilling',
    'approvePayroll', 'manageWells', 'manageRoutes', 'manageEquipment',
    'sendChat',
    'manageRolesAndCapabilities', 'viewAllCompanies', 'viewTruthDebug',
  ],
  admin: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewBilling',
    'viewPayroll', 'viewDriverLogs', 'viewSettings', 'viewAdmin', 'viewChat',
    'createDispatch', 'manageDrivers', 'manageCompany', 'editBilling',
    'approvePayroll', 'manageWells', 'manageRoutes', 'manageEquipment',
    'sendChat',
  ],
  manager: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewPayroll',
    'viewDriverLogs', 'viewChat',
    'createDispatch', 'sendChat', 'manageDrivers',
  ],
  dispatch: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewChat',
    'createDispatch', 'sendChat',
  ],
  payroll: [
    'viewHome', 'viewBilling', 'viewPayroll', 'viewChat',
    'editBilling', 'approvePayroll', 'sendChat',
  ],
  viewer: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewBilling',
    'viewPayroll', 'viewDriverLogs',
  ],
  driver: [],
};

// Default labels — customer can relabel per-company via companies/{id}.roleLabels.
export const DEFAULT_ROLE_LABELS: Record<UserRole, string> = {
  it: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  dispatch: 'Dispatcher',
  payroll: 'Payroll',
  viewer: 'Viewer',
  driver: 'Driver',
};

export interface WellBuiltUser {
  uid: string;
  email: string;
  role: UserRole;
  displayName?: string;
  companyId?: string;     // If set, scopes dashboard to this company only
  companyName?: string;   // Display name for the company
}

// ── Capability / label helpers ──────────────────────────────────────────────
// Per-company override shape — kept separate so lib/auth.ts doesn't import
// from companySettings.ts (avoids circular deps).
export interface RoleConfig {
  roleCapabilities?: Partial<Record<UserRole, Capability[]>>;
  roleLabels?: Partial<Record<UserRole, string>>;
}

/**
 * True iff the user has a specific capability. If the user's company has a
 * `roleCapabilities` override for the user's role, that list wins; otherwise
 * fall back to DEFAULT_ROLE_CAPABILITIES.
 *
 * Null user → always false. Caller-friendly: pass `null` without having to
 * guard yourself.
 */
export function hasCapability(
  user: WellBuiltUser | null,
  capability: Capability,
  companyConfig?: RoleConfig | null,
): boolean {
  if (!user) return false;
  const override = companyConfig?.roleCapabilities?.[user.role];
  const caps = override ?? DEFAULT_ROLE_CAPABILITIES[user.role] ?? [];
  return caps.includes(capability);
}

/**
 * Display label for a role. Per-company override wins, else default. Never
 * returns empty — falls back to the capitalized role primitive as last resort.
 */
export function getRoleLabel(role: UserRole, companyConfig?: RoleConfig | null): string {
  return (
    companyConfig?.roleLabels?.[role] ||
    DEFAULT_ROLE_LABELS[role] ||
    role.charAt(0).toUpperCase() + role.slice(1)
  );
}

// Sign in with email/password
export async function signIn(email: string, password: string): Promise<WellBuiltUser> {
  const auth = getFirebaseAuth();
  const result = await signInWithEmailAndPassword(auth, email, password);
  return await getUserWithRole(result.user);
}

// Register a new dashboard account with email/password. Creates only the
// Firebase Auth user — no RTDB users/{uid} record is written, so the new
// account resolves to role = 'viewer' via getUserWithRole's default. A
// WellBuilt admin must manually promote role to 'admin' or 'it' in RTDB to
// grant admin page access.
export async function registerWithEmail(
  email: string,
  password: string
): Promise<WellBuiltUser> {
  const auth = getFirebaseAuth();
  const result = await createUserWithEmailAndPassword(auth, email, password);
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
