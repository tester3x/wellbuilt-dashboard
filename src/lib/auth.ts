// Authentication utilities
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User
} from 'firebase/auth';
import { ref, get, set } from 'firebase/database';
import { httpsCallable } from 'firebase/functions';
import { getFirebaseAuth, getFirebaseDatabase, getFirebaseFunctions } from './firebase';

// ── Role primitives ─────────────────────────────────────────────────────────
// Canonical employee responsibilities. Customers can RELABEL (roleLabels on
// companies/{id}) but cannot invent new primitives — security rules / Cloud
// Functions reference these strings. Relabelling does not change logic.
// `safety` and `lead` are first-class responsibilities for Safety / spills.
export type UserRole = 'driver' | 'viewer' | 'dispatch' | 'payroll' | 'manager' | 'admin' | 'it' | 'safety' | 'lead';

// Role hierarchy — kept for backwards-compatibility with hasRole(). New code
// should prefer hasCapability() instead; hasRole() is only useful for coarse
// gates like "is this person anything above a driver?"
export const ROLE_LEVELS: Record<UserRole, number> = {
  driver: 1,
  viewer: 1,
  dispatch: 2,
  payroll: 2,
  safety: 2,
  lead: 3,
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
  | 'viewSafety'
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
  | 'viewEQuipment'          // WB eQuipment tab (read surfaces)
  | 'manageEquipment'        // equipment registry admin
  | 'manageEquipmentAssignments' // equipment custody assignments
  | 'viewDVIR'               // read submitted inspections
  | 'manageDVIR'             // future DVIR management
  | 'viewEquipmentDocuments' // read driver documents
  | 'manageEquipmentDocuments' // future document approval/admin
  | 'sendChat'
  | 'manageSafety'              // acknowledge / resolve / policy editor
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
    'viewPayroll', 'viewDriverLogs', 'viewSafety', 'viewSettings', 'viewAdmin', 'viewChat',
    'createDispatch', 'manageDrivers', 'manageCompany', 'editBilling',
    'approvePayroll', 'manageWells', 'manageRoutes',
    'viewEQuipment', 'manageEquipment', 'manageEquipmentAssignments',
    'viewDVIR', 'manageDVIR', 'viewEquipmentDocuments', 'manageEquipmentDocuments',
    'sendChat', 'manageSafety',
    'manageRolesAndCapabilities', 'viewAllCompanies', 'viewTruthDebug',
    'viewDiagnostics',
  ],
  admin: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewBilling',
    'viewPayroll', 'viewDriverLogs', 'viewSafety', 'viewSettings', 'viewAdmin', 'viewChat',
    'createDispatch', 'manageDrivers', 'manageCompany', 'editBilling',
    'approvePayroll', 'manageWells', 'manageRoutes',
    'viewEQuipment', 'manageEquipment', 'manageEquipmentAssignments',
    'viewDVIR', 'manageDVIR', 'viewEquipmentDocuments', 'manageEquipmentDocuments',
    'sendChat', 'manageSafety',
  ],
  manager: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewPayroll',
    'viewDriverLogs', 'viewSafety', 'viewChat',
    'createDispatch', 'sendChat', 'manageDrivers', 'manageEquipmentAssignments',
    'viewEQuipment', 'viewDVIR', 'viewEquipmentDocuments', 'manageSafety',
  ],
  dispatch: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewSafety', 'viewChat',
    'createDispatch', 'sendChat', 'manageEquipmentAssignments',
    'viewEQuipment', 'viewDVIR', 'viewEquipmentDocuments',
  ],
  safety: [
    'viewHome', 'viewTickets', 'viewDispatch', 'viewSafety', 'viewChat',
    'sendChat', 'manageSafety', 'viewEQuipment', 'viewDVIR',
  ],
  lead: [
    'viewHome', 'viewTickets', 'viewDispatch', 'viewSafety', 'viewChat',
    'sendChat', 'manageSafety', 'viewEQuipment', 'viewDVIR',
  ],
  payroll: [
    'viewHome', 'viewBilling', 'viewPayroll', 'viewChat',
    'editBilling', 'approvePayroll', 'sendChat',
  ],
  viewer: [
    'viewHome', 'viewMobile', 'viewTickets', 'viewDispatch', 'viewBilling',
    'viewPayroll', 'viewDriverLogs',
    'viewEQuipment', 'viewDVIR', 'viewEquipmentDocuments',
  ],
  driver: [],
};

// Default labels — customer can relabel per-company via companies/{id}.roleLabels.
export const DEFAULT_ROLE_LABELS: Record<UserRole, string> = {
  it: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  lead: 'Lead',
  safety: 'Safety',
  dispatch: 'Dispatcher',
  payroll: 'Payroll',
  viewer: 'Viewer',
  driver: 'Driver',
};

export interface WellBuiltUser {
  uid: string;
  email: string;
  role: UserRole;
  // Multi-role (7/9 employee refactor, dev): OPTIONAL roles array. When
  // present, effective capabilities are the UNION across all roles and
  // `role` is dual-written as the PRIMARY role (highest ROLE_LEVELS) so
  // security rules / Cloud Functions / mobile apps that read the single
  // string keep working unchanged. Absent → behaves exactly as before.
  roles?: UserRole[];
  displayName?: string;
  companyId?: string;     // If set, scopes dashboard to this company only
  companyName?: string;   // Display name for the company
  requestedCompanyName?: string;  // Pending signup: company name the user requested
  onboardingStatus?: string;      // e.g. 'pending_company_assignment'
  status?: string;                // e.g. 'pending'
}

/** Effective roles for a user: roles[] when present + non-empty, else [role]. */
export function getUserRoles(user: WellBuiltUser | null): UserRole[] {
  if (!user) return [];
  if (Array.isArray(user.roles) && user.roles.length > 0) {
    return user.roles.filter((r): r is UserRole => r in ROLE_LEVELS);
  }
  return [user.role];
}

/** Primary role for legacy single-string consumers: highest ROLE_LEVELS entry. */
export function getPrimaryRole(roles: UserRole[]): UserRole {
  if (roles.length === 0) return 'viewer';
  return roles.reduce((best, r) => (ROLE_LEVELS[r] > ROLE_LEVELS[best] ? r : best), roles[0]);
}

/** WB PLATFORM admin: unscoped (no companyId) + admin/it role. This is the
 *  load-bearing platform-vs-tenant distinction (named per 7/9 audit so
 *  multi-role logic can never accidentally widen it). */
export function isPlatformAdmin(user: WellBuiltUser | null): boolean {
  if (!user || user.companyId) return false;
  return getUserRoles(user).some(r => r === 'it' || r === 'admin');
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
export const EQUIPMENT_ACCESS_CAPABILITIES: Capability[] = [
  'viewEQuipment',
  'manageEquipment',
  'manageEquipmentAssignments',
  'viewDVIR',
  'manageDVIR',
  'viewEquipmentDocuments',
  'manageEquipmentDocuments',
];

export function hasEQuipmentAccess(
  user: WellBuiltUser | null,
  companyConfig?: RoleConfig | null,
): boolean {
  return EQUIPMENT_ACCESS_CAPABILITIES.some((cap) => hasCapability(user, cap, companyConfig));
}

export function hasCapability(
  user: WellBuiltUser | null,
  capability: Capability,
  companyConfig?: RoleConfig | null,
): boolean {
  if (!user) return false;
  // Multi-role (7/9): UNION of capabilities across the user's roles. Per
  // role, a per-company override wins over the default (same rule as
  // before); the union happens across the resolved per-role lists. With no
  // roles[] this is exactly the previous single-role behavior.
  return getUserRoles(user).some((role) => {
    const override = companyConfig?.roleCapabilities?.[role];
    const caps = override ?? DEFAULT_ROLE_CAPABILITIES[role] ?? [];
    return caps.includes(capability);
  });
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
  const requested = companyName?.trim() || '';
  if (requested.length < 2) {
    throw { code: 'invalid-argument', message: 'Company name must be 2–120 characters' };
  }
  const fn = httpsCallable(getFirebaseFunctions(), 'requestCompanyOnboarding');
  await fn({ companyName: requested });
  return await getUserWithRole(result.user);
}

// Sign out
export async function signOut(): Promise<void> {
  const auth = getFirebaseAuth();
  await firebaseSignOut(auth);
}

/**
 * Send a password-reset email via Firebase's hosted reset flow. NON-ENUMERATING:
 * a missing account resolves as success (the caller always shows the generic ack).
 * Only invalid-email / network / rate-limit re-throw (as a bare {code}) so the UI can
 * message them distinctly. Never logs the email, reset link, action code, or the raw
 * Firebase error payload.
 */
export async function sendDashboardPasswordReset(email: string): Promise<void> {
  const auth = getFirebaseAuth();
  try {
    await sendPasswordResetEmail(auth, email.trim());
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'auth/user-not-found') return; // do not reveal non-existence
    // Strip the payload — propagate only the non-sensitive error code.
    throw { code } as { code?: string };
  }
}

// Get user with role from database
async function getUserWithRole(user: User): Promise<WellBuiltUser> {
  const db = getFirebaseDatabase();
  const userRef = ref(db, `users/${user.uid}`);
  const snapshot = await get(userRef);

  let role: UserRole = 'viewer'; // Default role
  let roles: UserRole[] | undefined; // Multi-role (7/9) — optional array
  let displayName = user.email || '';

  let companyId: string | undefined;
  let companyName: string | undefined;
  let requestedCompanyName: string | undefined;
  let onboardingStatus: string | undefined;
  let status: string | undefined;

  if (snapshot.exists()) {
    const userData = snapshot.val();
    role = userData.role || 'viewer';
    roles = Array.isArray(userData.roles) && userData.roles.length > 0 ? userData.roles : undefined;
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
      // Child-path writes only. A parent update(users/{uid}) is denied under
      // default-deny even when email/displayName children are writable.
      const writes = Object.entries(writeBack).map(([field, value]) =>
        set(ref(db, `users/${user.uid}/${field}`), value),
      );
      Promise.all(writes).catch(err => {
        console.warn('[auth] backfill users/{uid} failed (non-fatal):', err);
      });
    }
  } catch { /* non-fatal */ }

  return {
    uid: user.uid,
    email: user.email || '',
    role,
    roles,
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
