// Authentication utilities
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User
} from 'firebase/auth';
import { ref, get, set, update, serverTimestamp } from 'firebase/database';
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
  | 'viewDiagnostics'             // wb_diagnostics admin viewer
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
    'viewDiagnostics',
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
  requestedCompanyName?: string;  // Pending signup: company name the user requested
  onboardingStatus?: string;      // e.g. 'pending_company_assignment'
  status?: string;                // e.g. 'pending'
}

/**
 * True only for WellBuilt platform staff: a user with NO companyId AND an
 * elevated role (it/admin). This is the company-picker / sees-everything gate.
 *
 * IMPORTANT: a company-less user is NOT automatically a platform admin. An
 * unassigned viewer (no companyId, role 'viewer') must fall through to an
 * empty state, never auto-scope to another company's data. Use this instead of
 * the loose `!user.companyId` check everywhere that grants cross-company access.
 */
export function isWbPlatformAdmin(user: WellBuiltUser | null): boolean {
  return !!user && !user.companyId && (user.role === 'it' || user.role === 'admin');
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

// Register a new dashboard account with email/password. Creates the Firebase
// Auth user AND a pending RTDB users/{uid} record that preserves the requested
// company name. The account starts unassigned (role 'viewer', companyId null,
// status 'pending'); a WellBuilt admin reviews the pending request and assigns
// a company + promotes the role later. No company is created here.
export async function registerWithEmail(
  email: string,
  password: string,
  companyName?: string,
): Promise<WellBuiltUser> {
  const auth = getFirebaseAuth();
  const result = await createUserWithEmailAndPassword(auth, email, password);
  // Capture the signup so the requested company name isn't lost.
  try {
    const db = getFirebaseDatabase();
    await set(ref(db, `users/${result.user.uid}`), {
      status: 'pending',
      requestedCompanyName: companyName?.trim() || null,
      requestedAt: serverTimestamp(),
      role: 'viewer',
      companyId: null,
      onboardingStatus: 'pending_company_assignment',
      email: result.user.email || email,
      displayName: result.user.email || email,
    });
  } catch (err) {
    console.warn('[auth] failed to write pending signup record (non-fatal):', err);
  }
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
  let requestedCompanyName: string | undefined;
  let onboardingStatus: string | undefined;
  let status: string | undefined;

  if (snapshot.exists()) {
    const userData = snapshot.val();
    role = userData.role || 'viewer';
    displayName = userData.displayName || displayName;
    companyId = userData.companyId || undefined;
    companyName = userData.companyName || undefined;
    requestedCompanyName = userData.requestedCompanyName || undefined;
    onboardingStatus = userData.onboardingStatus || undefined;
    status = userData.status || undefined;
  }

  // Backfill email + displayName onto the RTDB record if either is missing.
  // Firebase Auth has the canonical email/displayName; the RTDB users/{uid}
  // record was historically only storing { role }, so the Employees tab (and
  // any other surface that reads users/{uid} standalone) had no way to show
  // a friendly identity. Write the Auth-side values back so they're visible
  // without re-auth. Fire-and-forget — never block login on this.
  try {
    const rtdbRaw = snapshot.exists() ? snapshot.val() : {};
    const writeBack: Record<string, any> = {};
    if (user.email && !rtdbRaw.email) writeBack.email = user.email;
    if (user.displayName && !rtdbRaw.displayName) {
      writeBack.displayName = user.displayName;
    } else if (user.email && !rtdbRaw.displayName) {
      // Use the email local-part as a readable fallback ("Unknown" becomes
      // "mike" instead of a blank label) until an admin sets a proper name.
      writeBack.displayName = user.email.split('@')[0];
    }
    if (Object.keys(writeBack).length > 0) {
      update(userRef, writeBack).catch(err => {
        console.warn('[auth] backfill users/{uid} failed (non-fatal):', err);
      });
    }
  } catch { /* non-fatal */ }

  return {
    uid: user.uid,
    email: user.email || '',
    role,
    displayName,
    companyId,
    companyName,
    requestedCompanyName,
    onboardingStatus,
    status,
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
