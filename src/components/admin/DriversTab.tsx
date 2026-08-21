'use client';

import { useCallback, useEffect, useState, useMemo } from 'react';
import { httpsCallable } from 'firebase/functions';
import { getFirebaseDatabase, getFirestoreDb, getFirebaseFunctions } from '@/lib/firebase';
import { ref, get, set, remove, update } from 'firebase/database';
import { collection, getDocs } from 'firebase/firestore';
import { fetchRouteNames } from '@/lib/wells';
import { type UserRole, DEFAULT_ROLE_LABELS, getPrimaryRole } from '@/lib/auth';
import { mergeEmployees, EmployeeRow } from '@/lib/employees';
import { EmployeePanel } from './EmployeePanel';
import { useAuth } from '@/contexts/AuthContext';
import {
  buildSetPasscodeRequest,
  canSubmit,
  companyActionRouteFor,
  confirmationCopyFor,
  credentialActionFor,
  hasCanonicalDriverId,
  localPolicyError,
  PASSCODE_GUIDANCE,
} from '@/lib/secureLoginProvisioning';
import { getRoleLabel } from '@/lib/auth';

interface AssignedCustomer {
  name: string;
  companyId: string;
}

interface ApprovedDriver {
  key: string;           // passcode hash (Firebase key)
  displayName: string;
  legalName?: string;    // full legal name for payroll/printed docs
  name?: string;         // legacy field
  isAdmin?: boolean;
  isViewer?: boolean;
  active?: boolean;
  companyId?: string;    // which trucking company this driver belongs to
  companyName?: string;  // display name of the company
  assignedCustomers?: AssignedCustomer[];
  assignedRoutes?: string[];   // routes this driver can see
  assignedWells?: string[];    // one-off well assignments (dispatch overrides)
  defaultPackageId?: string;   // default job package for shift start
  // Dashboard account link — set by inviteEmployee Cloud Function when a
  // driver is promoted to a dashboard role.
  dashboardUid?: string;
  dashboardRole?: UserRole;
  /**
   * Canonical secure driver id, when the row is known to be linked to one
   * (migration stamps migratedToDriverId on the legacy row). Display/gating
   * only — the decision layer (hasCanonicalDriverId) still rejects any id
   * equal to the RTDB key, so a legacy `driverId: hash` echo can never read
   * as secured.
   */
  driverId?: string;
  _legacy?: boolean;     // true if stored in old {hash}/{deviceId}/ format
  _legacyDeviceId?: string; // the device sub-key for legacy records
}

/** Secure-credential presentation state shared by BOTH employee views. */
type SecureLoginState = 'create' | 'secured' | 'none';

interface DriversTabProps {
  scopeCompanyId?: string;  // if set, only show drivers for this company
  isWbAdmin?: boolean;      // true = WellBuilt IT/admin (sees everything)
}

interface PendingDriver {
  key: string;
  displayName: string;
  legalName?: string;      // full legal name from registration
  passcodeHash: string;
  timestamp?: number;
  companyName?: string;    // company name driver entered during registration
  requestedAt?: string;    // ISO timestamp from registration
}

// ── Dashboard user (from RTDB users/{uid}) ─────────────────────────────────
// Pure-dashboard accounts (no driver record) and drivers who've been promoted
// via inviteEmployee both have an entry here. We show them as a separate
// subsection inside each company group in the Employees tab.
interface DashboardUser {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  roles?: UserRole[];      // multi-role (7/9); role stays the primary
  companyId?: string;      // '' / undefined = WB staff (spans all companies)
  companyName?: string;
  driverHash?: string;     // linked driver record, if promoted from a driver
}

export function DriversTab({ scopeCompanyId, isWbAdmin = false }: DriversTabProps) {
  const [approvedDrivers, setApprovedDrivers] = useState<ApprovedDriver[]>([]);
  const [dashboardUsers, setDashboardUsers] = useState<DashboardUser[]>([]);
  // Per-company collapse state for WB-admin grouped view. Key = companyId
  // (empty string = WellBuilt Staff). Defaults vary: when there's only one
  // company in the list we expand it; multi-company views start collapsed.
  const [collapsedCompanies, setCollapsedCompanies] = useState<Record<string, boolean>>({});
  const [pendingDrivers, setPendingDrivers] = useState<PendingDriver[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');

  // Assign customer modal
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [assignTarget, setAssignTarget] = useState<ApprovedDriver | null>(null);

  // ── Create secure login ────────────────────────────────────────────────
  // These rows come from RTDB drivers/approved/{hash}, where the key IS the
  // passcode hash — there is no trustworthy canonical driverId to reset
  // against, so this tranche only CREATES a new secure identity. Reset is
  // deliberately not offered here.
  const [secureTarget, setSecureTarget] = useState<ApprovedDriver | null>(null);
  const [securePass, setSecurePass] = useState('');
  const [secureConfirm, setSecureConfirm] = useState('');
  const [secureBusy, setSecureBusy] = useState(false);
  const [secureError, setSecureError] = useState('');
  const [secureDone, setSecureDone] = useState('');
  // Rows provisioned during THIS session. The create path deliberately stamps
  // nothing on the legacy row (no credential-derived linkage), so until a
  // reload surfaces server-side state this set is the only signal that a row
  // is already secured — it keeps the create action from being re-offered.
  const [securedKeys, setSecuredKeys] = useState<Set<string>>(new Set());

  /** Drop every secret the modal holds. Used on cancel, success, and unmount. */
  const clearSecureSecrets = useCallback(() => {
    setSecurePass('');
    setSecureConfirm('');
    setSecureError('');
  }, []);

  const closeSecureModal = useCallback(() => {
    clearSecureSecrets();
    setSecureDone('');
    setSecureBusy(false);
    setSecureTarget(null);
  }, [clearSecureSecrets]);

  // Switching rows or unmounting must not leave a typed password in state.
  useEffect(() => {
    clearSecureSecrets();
    setSecureDone('');
    return clearSecureSecrets;
  }, [secureTarget, clearSecureSecrets]);

  const handleCreateSecureLogin = useCallback(async () => {
    if (!secureTarget || secureBusy) return; // double-submit guard
    if (!canSubmit({ passcode: securePass, confirm: secureConfirm, submitting: secureBusy })) {
      return;
    }
    setSecureBusy(true);
    setSecureError('');
    try {
      const { adminSetPasscode } = await import('@/lib/secureDriverAdmin');
      // Built by the tested decision layer: no driverId, no legacyHash,
      // temporary:false. The callable owns name-conflict enforcement, so no
      // client-side index read happens here.
      const req = buildSetPasscodeRequest(secureTarget, securePass);
      // The response carries the new canonical UUID; it is deliberately NOT
      // rendered — success copy stays masked (display name only).
      await adminSetPasscode(req);
      clearSecureSecrets();
      setSecuredKeys(prev => new Set(prev).add(secureTarget.key));
      setSecureDone(`Secure login created for ${secureTarget.displayName}.`);
    } catch (err) {
      // Sanitized: render only our own copy, never the raw error, so a
      // server message can never echo submitted input back into the DOM.
      const code = (err as { code?: string })?.code || '';
      setSecureError(
        /already-exists/.test(code)
          ? 'That login name is already assigned to another secure driver.'
          : /permission-denied|unauthenticated/.test(code)
            ? 'You are not authorized to create secure logins.'
            : 'Could not create the secure login. Please try again.',
      );
    } finally {
      setSecureBusy(false);
    }
  }, [secureTarget, secureBusy, securePass, secureConfirm, clearSecureSecrets]);

  // ── One secure-credential state for BOTH employee views ────────────────
  // The primary EmployeePanel and the legacy list must not drift: each asks
  // this resolver, which delegates to the tested decision layer.
  //   'secured' — the row carries a canonical (non-key) driverId, or was
  //               provisioned in this session;
  //   'create'  — active legacy-only row, eligible for a new secure login;
  //   'none'    — not eligible (inactive row, or caller is not WB admin).
  const secureLoginStateFor = useCallback((driver: ApprovedDriver): SecureLoginState => {
    if (!isWbAdmin) return 'none';
    if (securedKeys.has(driver.key) || credentialActionFor(driver) === 'reset_passcode') {
      return 'secured';
    }
    return driver.active !== false ? 'create' : 'none';
  }, [isWbAdmin, securedKeys]);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerCompanyId, setNewCustomerCompanyId] = useState('');

  // Assign company modal (WB admin only)
  const [showCompanyModal, setShowCompanyModal] = useState(false);
  const [companyTarget, setCompanyTarget] = useState<ApprovedDriver | null>(null);
  const [assignCompanyId, setAssignCompanyId] = useState('');
  const [assignCompanyName, setAssignCompanyName] = useState('');
  const [companyBusy, setCompanyBusy] = useState(false);
  const [companyError, setCompanyError] = useState('');
  const [companiesList, setCompaniesList] = useState<{ id: string; name: string; assignedOperators: string[] }[]>([]);

  // Assign routes modal
  const [showRoutesModal, setShowRoutesModal] = useState(false);
  const [routeTarget, setRouteTarget] = useState<ApprovedDriver | null>(null);
  const [selectedRoutes, setSelectedRoutes] = useState<string[]>([]);
  const [availableRoutes, setAvailableRoutes] = useState<string[]>([]);

  // Combined approval modal (forces company + customers + route on approve)
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const [approvalTarget, setApprovalTarget] = useState<PendingDriver | null>(null);
  const [approvalCompanyId, setApprovalCompanyId] = useState('');
  const [approvalCompanyName, setApprovalCompanyName] = useState('');
  const [approvalCustomers, setApprovalCustomers] = useState<string[]>([]);
  const [approvalRoutes, setApprovalRoutes] = useState<string[]>([]);
  const [approvalRoles, setApprovalRoles] = useState<string[]>(['driver']);

  // Default package modal
  const [showPackageModal, setShowPackageModal] = useState(false);
  const [packageTarget, setPackageTarget] = useState<ApprovedDriver | null>(null);
  const [selectedPackageId, setSelectedPackageId] = useState('');
  const [availablePackages, setAvailablePackages] = useState<{ id: string; name: string }[]>([]);

  // Expanded driver (shows details + assigned customers)
  const [expandedDriver, setExpandedDriver] = useState<string | null>(null);

  // ── Role dropdown + invite modal ───────────────────────────────────────
  // Clicking the "Role" button toggles this state open for that driver.
  const [roleMenuForKey, setRoleMenuForKey] = useState<string | null>(null);
  // Invite flow for promoting a driver into a dashboard role.
  const [inviteTarget, setInviteTarget] = useState<ApprovedDriver | null>(null);
  const [inviteRole, setInviteRole] = useState<UserRole>('dispatch');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteSending, setInviteSending] = useState(false);
  const [inviteResult, setInviteResult] = useState<null | {
    resetLink: string | null;
    email: string;
    role: UserRole;
    existed: boolean;
  }>(null);

  const { userCompany } = useAuth();
  const db = getFirebaseDatabase();

  // ── Unified employee rows (7/9 refactor) — one row per PERSON, merging
  // drivers/approved + users/{uid} via the dashboardUid/driverHash link.
  // Pure derivation; the underlying stores and modals are unchanged.
  const employees: EmployeeRow<ApprovedDriver, DashboardUser>[] = useMemo(
    () => mergeEmployees(approvedDrivers, dashboardUsers),
    [approvedDrivers, dashboardUsers],
  );
  // Dev refactor (7/9): the unified panel is primary; the pre-refactor
  // Approved Drivers / dashboard-user lists stay behind this toggle until
  // the panel is field-approved. Nothing was deleted.
  const [showLegacyView, setShowLegacyView] = useState(false);


  const loadDrivers = async () => {
    setLoading(true);
    try {
      const { adminGetDashboardCatalog, catalogErrorCode } = await import('@/lib/adminDashboardCatalog');
      let catalog;
      try {
        catalog = await adminGetDashboardCatalog();
      } catch (catalogErr) {
        setApprovedDrivers([]);
        setDashboardUsers([]);
        setMessage(`Failed to load employees [${catalogErrorCode(catalogErr)}]`);
        throw catalogErr;
      }
      // Load approved drivers
      const approved: ApprovedDriver[] = [];
      {
        const data = (catalog.approved || {}) as Record<string, any>;
        Object.entries(data).forEach(([hash, val]: [string, any]) => {
          // New flat structure: drivers/approved/{hash}/ = { displayName, active, ... }
          if (val.displayName || val.name) {
            approved.push({
              key: hash,
              displayName: val.displayName || val.name || 'Unknown',
              legalName: val.legalName || val.profile?.legalName || undefined,
              name: val.name,
              isAdmin: val.isAdmin || false,
              isViewer: val.isViewer || false,
              active: val.active !== false,
              companyId: val.companyId || undefined,
              companyName: val.companyName || undefined,
              assignedCustomers: Array.isArray(val.assignedCustomers) ? val.assignedCustomers : [],
              assignedRoutes: Array.isArray(val.assignedRoutes) ? val.assignedRoutes : [],
              assignedWells: Array.isArray(val.assignedWells) ? val.assignedWells : [],
              defaultPackageId: val.defaultPackageId || undefined,
              dashboardUid: val.dashboardUid || undefined,
              dashboardRole: val.dashboardRole || undefined,
              // Canonical linkage when the server stamped one (migration
              // path). The decision layer ignores a hash echoed as its own
              // driverId, so mapping this is safe for gating.
              driverId:
                (typeof val.driverId === 'string' && val.driverId)
                || (typeof val.migratedToDriverId === 'string' && val.migratedToDriverId)
                || undefined,
            });
          } else {
            // Legacy structure: drivers/approved/{hash}/{deviceId}/ = { displayName, active, ... }
            // Each sub-key is a device ID with its own record — pick the first one with a displayName
            let foundName = '';
            let foundAdmin = false;
            let foundViewer = false;
            let foundActive = true;
            for (const subKey of Object.keys(val)) {
              const entry = val[subKey];
              if (entry && typeof entry === 'object' && entry.displayName) {
                foundName = entry.displayName;
                foundAdmin = entry.isAdmin === true;
                foundViewer = entry.isViewer === true;
                foundActive = entry.active !== false;
                break;
              }
            }
            // Find the device key so we can reference it later
            let legacyDeviceId = '';
            for (const subKey of Object.keys(val)) {
              const entry = val[subKey];
              if (entry && typeof entry === 'object' && entry.displayName) {
                legacyDeviceId = subKey;
                break;
              }
            }
            approved.push({
              key: hash,
              displayName: foundName || 'Unknown',
              isAdmin: foundAdmin,
              isViewer: foundViewer,
              active: foundActive,
              assignedCustomers: Array.isArray(val.assignedCustomers) ? val.assignedCustomers : [],
              assignedRoutes: Array.isArray(val.assignedRoutes) ? val.assignedRoutes : [],
              assignedWells: Array.isArray(val.assignedWells) ? val.assignedWells : [],
              driverId: typeof val.migratedToDriverId === 'string' ? val.migratedToDriverId : undefined,
              _legacy: true,
              _legacyDeviceId: legacyDeviceId,
            });
          }
        });
      }
      approved.sort((a, b) => a.displayName.localeCompare(b.displayName));
      setApprovedDrivers(approved);

      // Load pending drivers from the same Admin catalog (parent RTDB is denied)
      const pending: PendingDriver[] = [];
      {
        const data = (catalog.pending || {}) as Record<string, any>;
        Object.entries(data).forEach(([key, val]: [string, any]) => {
          // Skip already-processed pending records (status: approved/rejected)
          if (val.status === 'approved' || val.status === 'rejected') return;
          pending.push({
            key,
            displayName: val.displayName || 'Unknown',
            legalName: val.legalName || undefined,
            passcodeHash: val.passcodeHash || '',
            timestamp: val.timestamp || (val.requestedAt ? new Date(val.requestedAt).getTime() : undefined),
            companyName: val.companyName || undefined,
            requestedAt: val.requestedAt || undefined,
            // secure dual-run field (may be absent on legacy spam records)
            ...(val.securePendingId ? { securePendingId: val.securePendingId } as any : {}),
          });
        });
      }
      pending.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      setPendingDrivers(pending);

      // Load dashboard users (users/{uid}). Purely-dashboard employees
      // (not linked to a driver record) appear only here; drivers who have
      // been promoted via inviteEmployee appear in BOTH lists and are linked
      // via driverHash on the user side + dashboardUid on the driver side.
      const userList: DashboardUser[] = [];
      {
        const data = (catalog.users || {}) as Record<string, any>;
        Object.entries(data).forEach(([uid, val]: [string, any]) => {
          if (!val?.role || val.role === 'driver') return; // skip plain drivers
          userList.push({
            uid,
            email: val.email || '',
            displayName: val.displayName || val.email || 'Unknown',
            role: val.role as UserRole,
            roles: Array.isArray(val.roles) && val.roles.length > 0 ? (val.roles as UserRole[]) : undefined,
            companyId: val.companyId || undefined,
            companyName: val.companyName || undefined,
            driverHash: val.driverHash || undefined,
          });
        });
      }
      userList.sort((a, b) => a.displayName.localeCompare(b.displayName));
      setDashboardUsers(userList);
    } catch (err) {
      console.error('Failed to load employees:', err);
      setMessage('Failed to load employees');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadDrivers(); }, []);

  // Load companies list for assign dropdown
  useEffect(() => {
    (async () => {
      try {
        const firestore = getFirestoreDb();
        const snap = await getDocs(collection(firestore, 'companies'));
        const list: { id: string; name: string; assignedOperators: string[] }[] = [];
        snap.forEach(d => {
          const data = d.data();
          list.push({ id: d.id, name: data.name || d.id, assignedOperators: data.assignedOperators || [] });
        });
        list.sort((a, b) => a.name.localeCompare(b.name));
        setCompaniesList(list);
      } catch (err) {
        console.error('Failed to load companies list:', err);
      }
    })();
  }, []);

  // Load available routes from well_config
  useEffect(() => {
    (async () => {
      try {
        const routes = await fetchRouteNames();
        setAvailableRoutes(routes);
      } catch (err) {
        console.error('Failed to load routes:', err);
      }
    })();
  }, []);

  // Load available job packages
  useEffect(() => {
    (async () => {
      try {
        const firestore = getFirestoreDb();
        const snap = await getDocs(collection(firestore, 'job_packages'));
        const list: { id: string; name: string }[] = [];
        snap.forEach(d => {
          const data = d.data();
          list.push({ id: d.id, name: data.name || d.id });
        });
        list.sort((a, b) => a.name.localeCompare(b.name));
        setAvailablePackages(list);
      } catch (err) {
        console.error('Failed to load packages:', err);
      }
    })();
  }, []);

  // ── Set default package for driver ──
  const setDriverDefaultPackage = async () => {
    if (!packageTarget) return;
    try {
      await update(ref(db, `drivers/approved/${packageTarget.key}`), {
        defaultPackageId: selectedPackageId || null,
      });
      setMessage(
        selectedPackageId
          ? `Default package set for ${packageTarget.displayName}`
          : `Default package cleared for ${packageTarget.displayName}`
      );
      setShowPackageModal(false);
      setPackageTarget(null);
      setSelectedPackageId('');
      await loadDrivers();
    } catch (err) {
      console.error('Failed to set default package:', err);
      setMessage('Failed to set default package');
    }
  };

  // ── Assign routes to driver ──
  const assignDriverRoutes = async () => {
    if (!routeTarget) return;
    try {
      await update(ref(db, `drivers/approved/${routeTarget.key}`), {
        assignedRoutes: selectedRoutes.length > 0 ? selectedRoutes : null,
      });
      setMessage(`Assigned ${selectedRoutes.length} route(s) to ${routeTarget.displayName}`);
      setShowRoutesModal(false);
      setRouteTarget(null);
      await loadDrivers();
    } catch (err) {
      console.error('Failed to assign routes:', err);
      setMessage('Failed to assign routes');
    }
  };

  // ── Assign driver to a company (WB admin only) ──
  //
  // TWO ROUTES, decided by the tested companyActionRouteFor:
  //   canonical row  → governed adminBindDriverCompany callable (initial
  //                    binding only; transfer/unbind refused with copy);
  //   legacy-only row → the pre-existing RTDB staging write, which is
  //                    metadata for the future secure creation — it never
  //                    binds a canonical profile.
  const assignDriverCompany = async () => {
    if (!companyTarget || companyBusy) return; // double-submit guard
    const route = companyActionRouteFor(companyTarget, assignCompanyId);

    if (route === 'blocked_unbind') {
      setCompanyError(
        'A secure driver cannot be removed from its company here. Unbinding is a separate governed operation.',
      );
      return;
    }
    if (route === 'blocked_transfer') {
      setCompanyError(
        `${companyTarget.displayName} is already bound to ${companyTarget.companyName || 'a company'}. `
        + 'Moving a secure driver between companies is a separate transfer workflow — initial binding cannot rebind.',
      );
      return;
    }

    if (route === 'governed_bind') {
      setCompanyBusy(true);
      setCompanyError('');
      try {
        const { adminBindCompany } = await import('@/lib/secureDriverAdmin');
        // Exact payload: canonical driverId + companyId. Nothing else — the
        // server owns name/company resolution and the authority ensure.
        const res = await adminBindCompany({
          driverId: (companyTarget.driverId || '').trim(),
          companyId: assignCompanyId.trim().toLowerCase(),
        });
        // Display mirror ONLY: the governed bind wrote the canonical
        // profile + authority; the legacy approved row is what this list
        // renders, so reflect the result there. Never authority.
        try {
          await update(ref(db, `drivers/approved/${companyTarget.key}`), {
            companyId: res.companyId,
            companyName: res.companyName || null,
          });
        } catch { /* display mirror is best-effort */ }
        setMessage(
          `${companyTarget.displayName} bound to ${res.companyName || res.companyId}`
          + (res.alreadyBound ? ' (was already bound — no change)' : ''),
        );
        setShowCompanyModal(false);
        setCompanyTarget(null);
        setAssignCompanyId('');
        setAssignCompanyName('');
        await loadDrivers();
      } catch (err) {
        // Sanitized: our own copy only — the modal stays open so the admin
        // can retry the SAME logical binding (the server journal converges).
        const code = (err as { code?: string; message?: string })?.code || '';
        const detail = (err as { message?: string })?.message || '';
        setCompanyError(
          /failed-precondition/.test(code)
            ? (/already_bound_elsewhere/.test(detail)
              ? 'This driver is already bound to a different company. Transfers are a separate workflow.'
              : /open_shift/.test(detail)
                ? 'This driver has an open shift. Close it before changing the company binding.'
                : 'The binding was refused by a server precondition. Nothing was changed — you can retry.'
              )
            : /permission-denied|unauthenticated/.test(code)
              ? 'You are not authorized to bind drivers to this company.'
              : 'Could not complete the binding. Nothing partial was kept — you can retry.',
        );
      } finally {
        setCompanyBusy(false);
      }
      return;
    }

    // legacy_staging — pre-existing behavior, now labeled for what it is.
    try {
      const updates: Record<string, any> = {
        companyId: assignCompanyId.trim().toLowerCase() || null,
        companyName: assignCompanyName.trim() || null,
      };
      // Sync tier from company doc
      if (assignCompanyId.trim()) {
        try {
          const firestore = getFirestoreDb();
          const { getDoc, doc: firestoreDoc } = await import('firebase/firestore');
          const companySnap = await getDoc(firestoreDoc(firestore, 'companies', assignCompanyId.trim().toLowerCase()));
          if (companySnap.exists()) {
            const tier = companySnap.data().tier;
            if (tier) updates.tier = tier;
            else updates.tier = null;
          }
        } catch { /* tier sync is non-blocking */ }
      } else {
        updates.tier = null;
      }
      if (companyTarget._legacy && companyTarget._legacyDeviceId) {
        await update(ref(db, `drivers/approved/${companyTarget.key}/${companyTarget._legacyDeviceId}`), updates);
      } else {
        await update(ref(db, `drivers/approved/${companyTarget.key}`), updates);
      }
      setMessage(
        assignCompanyId.trim()
          ? `${companyTarget.displayName} staged for ${assignCompanyName.trim() || assignCompanyId.trim()} (applies when the secure login is created)`
          : `${companyTarget.displayName} removed from company`
      );
      setShowCompanyModal(false);
      setCompanyTarget(null);
      setAssignCompanyId('');
      setAssignCompanyName('');
      await loadDrivers();
    } catch (err) {
      console.error('Failed to assign company:', err);
      setMessage('Failed to assign company');
    }
  };

  // ── Approve a pending driver ──
  const approveDriver = async (driver: PendingDriver) => {
    try {
      // Prefer secure callable when dual-run securePendingId is present
      const secureId = (driver as PendingDriver & { securePendingId?: string }).securePendingId;
      if (secureId) {
        try {
          const { adminApproveSecure } = await import('@/lib/secureDriverAdmin');
          await adminApproveSecure({
            pendingId: secureId,
            companyId: scopeCompanyId || undefined,
            companyName: driver.companyName,
          });
          setMessage(`Approved (secure): ${driver.displayName}`);
          await loadDrivers();
          return;
        } catch (secErr) {
          console.warn('Secure approve failed, falling back to legacy RTDB:', secErr);
        }
      }
      // Move from pending to approved
      // If a company admin is approving, auto-assign to their company
      // Also carry forward the companyName the driver entered during registration
      const approvedData: Record<string, any> = {
        displayName: driver.displayName,
        legalName: driver.legalName || driver.displayName,
        name: driver.displayName,
        active: true,
        isAdmin: false,
        isViewer: false,
        approvedAt: Date.now(),
        roles: ['driver'],
      };
      if (scopeCompanyId) {
        // Company admin approving — assign to their company
        approvedData.companyId = scopeCompanyId;
        // Look up company tier
        try {
          const firestore = getFirestoreDb();
          const { getDoc, doc: firestoreDoc } = await import('firebase/firestore');
          const companySnap = await getDoc(firestoreDoc(firestore, 'companies', scopeCompanyId));
          if (companySnap.exists()) {
            const companyData = companySnap.data();
            if (companyData.tier) approvedData.tier = companyData.tier;
            if (companyData.name) approvedData.companyName = companyData.name;
          }
        } catch (tierErr) {
          console.warn('Company tier lookup failed (non-blocking):', tierErr);
        }
      } else if (driver.companyName) {
        // WB admin approving — try to auto-match company name to Firestore companies
        try {
          const firestore = getFirestoreDb();
          const companiesSnap = await getDocs(collection(firestore, 'companies'));
          const driverCoLower = driver.companyName.toLowerCase().trim();
          companiesSnap.forEach((d) => {
            const data = d.data();
            const coNameLower = (data.name || '').toLowerCase().trim();
            // Match: exact, contains, or contained-in
            if (coNameLower === driverCoLower ||
                coNameLower.includes(driverCoLower) ||
                driverCoLower.includes(coNameLower)) {
              approvedData.companyId = d.id;
              approvedData.companyName = data.name;
              if (data.tier) approvedData.tier = data.tier;
            }
          });
        } catch (matchErr) {
          console.warn('Company auto-match failed (non-blocking):', matchErr);
        }
      }
      if (driver.companyName) {
        // Always carry forward the registration company name as a reference
        approvedData.registrationCompany = driver.companyName;
      }
      await set(ref(db, `drivers/approved/${driver.passcodeHash}`), approvedData);
      // Mark pending as approved (don't delete yet — the client app polls this)
      await update(ref(db, `drivers/pending/${driver.key}`), {
        status: 'approved',
      });
      setMessage(`Approved: ${driver.displayName}`);
      await loadDrivers();
    } catch (err) {
      console.error('Failed to approve driver:', err);
      setMessage('Failed to approve driver');
    }
  };

  // ── Approve driver with forced assignments (company + customers + route) ──
  const approveDriverWithAssignments = async () => {
    if (!approvalTarget) return;
    if (!approvalCompanyId) {
      setMessage('Please select a company');
      return;
    }
    if (approvalCustomers.length === 0) {
      setMessage('Please assign at least one customer (operator)');
      return;
    }
    if (approvalRoutes.length === 0) {
      setMessage('Please assign at least one route');
      return;
    }

    try {
      // Prefer secure callable when dual-run securePendingId is present
      const secureId = (approvalTarget as PendingDriver & { securePendingId?: string }).securePendingId;
      if (secureId) {
        try {
          const { adminApproveSecure } = await import('@/lib/secureDriverAdmin');
          await adminApproveSecure({
            pendingId: secureId,
            companyId: approvalCompanyId,
            companyName: approvalCompanyName,
            assignedCustomers: approvalCustomers.map((name) => ({
              name,
              companyId: approvalCompanyId,
            })),
            assignedRoutes: approvalRoutes,
            roles: approvalRoles,
          });
          setMessage(
            `Approved (secure): ${approvalTarget.displayName} with ${approvalCustomers.length} customer(s) and ${approvalRoutes.length} route(s)`,
          );
          setShowApprovalModal(false);
          setApprovalTarget(null);
          setApprovalCompanyId('');
          setApprovalCompanyName('');
          setApprovalCustomers([]);
          setApprovalRoutes([]);
          setApprovalRoles(['driver']);
          await loadDrivers();
          return;
        } catch (secErr) {
          console.warn('Secure approve-with-assignments failed, falling back to legacy RTDB:', secErr);
        }
      }

      const approvedData: Record<string, any> = {
        displayName: approvalTarget.displayName,
        legalName: approvalTarget.legalName || approvalTarget.displayName,
        name: approvalTarget.displayName,
        active: true,
        isAdmin: approvalRoles.includes('admin'),
        isViewer: approvalRoles.includes('viewer'),
        approvedAt: Date.now(),
        companyId: approvalCompanyId,
        companyName: approvalCompanyName,
        assignedCustomers: approvalCustomers.map(name => ({
          name,
          companyId: approvalCompanyId,
        })),
        assignedRoutes: approvalRoutes,
        roles: approvalRoles,
      };

      // Sync tier from company doc
      try {
        const firestore = getFirestoreDb();
        const { getDoc, doc: firestoreDoc } = await import('firebase/firestore');
        const companySnap = await getDoc(firestoreDoc(firestore, 'companies', approvalCompanyId));
        if (companySnap.exists()) {
          const tier = companySnap.data().tier;
          if (tier) approvedData.tier = tier;
        }
      } catch { /* tier sync is non-blocking */ }

      if (approvalTarget.companyName) {
        approvedData.registrationCompany = approvalTarget.companyName;
      }

      // Single write — complete record at once
      await set(ref(db, `drivers/approved/${approvalTarget.passcodeHash}`), approvedData);

      // Mark pending as approved
      await update(ref(db, `drivers/pending/${approvalTarget.key}`), {
        status: 'approved',
      });

      setMessage(`Approved: ${approvalTarget.displayName} with ${approvalCustomers.length} customer(s) and ${approvalRoutes.length} route(s)`);
      setShowApprovalModal(false);
      setApprovalTarget(null);
      setApprovalCompanyId('');
      setApprovalCompanyName('');
      setApprovalCustomers([]);
      setApprovalRoutes([]);
      setApprovalRoles(['driver']);
      await loadDrivers();
    } catch (err) {
      console.error('Failed to approve driver:', err);
      setMessage('Failed to approve driver');
    }
  };

  // ── Reject a pending driver ──
  // Prefer secure callable (audit + credential cleanup). Always preserve the
  // RTDB pending document (status=rejected only — never delete evidence).
  const rejectDriver = async (driver: PendingDriver) => {
    try {
      try {
        const { adminRejectSecure } = await import('@/lib/secureDriverAdmin');
        const anyDriver = driver as PendingDriver & { securePendingId?: string };
        await adminRejectSecure({
          legacyKey: driver.key,
          pendingId: anyDriver.securePendingId || undefined,
        });
      } catch (callableErr) {
        console.warn('Secure reject callable unavailable, RTDB status only:', callableErr);
        await update(ref(db, `drivers/pending/${driver.key}`), {
          status: 'rejected',
        });
      }
      setMessage(`Rejected: ${driver.displayName}`);
      await loadDrivers();
    } catch (err) {
      console.error('Failed to reject driver:', err);
      setMessage('Failed to reject driver');
    }
  };

  // ── Migrate legacy driver to new flat format ──
  const migrateDriver = async (driver: ApprovedDriver) => {
    if (!driver._legacy) return;
    try {
      // Write new flat structure (preserves the hash key)
      await set(ref(db, `drivers/approved/${driver.key}`), {
        displayName: driver.displayName,
        name: driver.displayName,
        active: driver.active !== false,
        isAdmin: driver.isAdmin || false,
        isViewer: driver.isViewer || false,
        migratedAt: Date.now(),
        ...(driver.companyId ? { companyId: driver.companyId, companyName: driver.companyName } : {}),
        ...(driver.assignedCustomers?.length ? { assignedCustomers: driver.assignedCustomers } : {}),
      });
      setMessage(`Migrated: ${driver.displayName} to new format`);
      await loadDrivers();
    } catch (err) {
      console.error('Failed to migrate driver:', err);
      setMessage('Failed to migrate driver');
    }
  };

  // ── Migrate all legacy drivers at once ──
  const migrateAllLegacy = async () => {
    const legacyDrivers = approvedDrivers.filter(d => d._legacy);
    if (legacyDrivers.length === 0) return;
    try {
      for (const driver of legacyDrivers) {
        await set(ref(db, `drivers/approved/${driver.key}`), {
          displayName: driver.displayName,
          name: driver.displayName,
          active: driver.active !== false,
          isAdmin: driver.isAdmin || false,
          isViewer: driver.isViewer || false,
          migratedAt: Date.now(),
          ...(driver.companyId ? { companyId: driver.companyId, companyName: driver.companyName } : {}),
          ...(driver.assignedCustomers?.length ? { assignedCustomers: driver.assignedCustomers } : {}),
        });
      }
      setMessage(`Migrated ${legacyDrivers.length} drivers to new format`);
      await loadDrivers();
    } catch (err) {
      console.error('Failed to migrate drivers:', err);
      setMessage('Failed to migrate drivers');
    }
  };

  // ── Save multi-role set for a dashboard account (7/9 P4) ─────────────
  // Writes BOTH users/{uid}.roles[] and the legacy single-string primary
  // role (highest ROLE_LEVELS) so security rules / CFs / mobile apps keep
  // working unchanged. Link fields (driverHash / dashboardUid) untouched.
  const saveEmployeeRoles = async (uid: string, roles: UserRole[]) => {
    try {
      const cleaned = roles.length > 0 ? roles : (['viewer'] as UserRole[]);
      await update(ref(db, `users/${uid}`), {
        roles: cleaned,
        role: getPrimaryRole(cleaned),
      });
      setMessage('Roles updated');
      await loadDrivers();
    } catch (err) {
      console.error('Failed to save roles:', err);
      setMessage('Failed to save roles');
    }
  };

  // ── Toggle driver active/inactive ──
  const toggleDriverActive = async (driver: ApprovedDriver) => {
    try {
      const newActive = !driver.active;
      if (driver._legacy && driver._legacyDeviceId) {
        // Update inside the legacy nested path
        await update(ref(db, `drivers/approved/${driver.key}/${driver._legacyDeviceId}`), {
          active: newActive,
        });
      } else {
        await update(ref(db, `drivers/approved/${driver.key}`), {
          active: newActive,
        });
      }
      setMessage(`${driver.displayName} is now ${newActive ? 'active' : 'inactive'}`);
      await loadDrivers();
    } catch (err) {
      console.error('Failed to toggle driver:', err);
      setMessage('Failed to update driver');
    }
  };

  // ── Role picker for the Employees flow ───────────────────────────────
  // When the admin picks a role from the dropdown on a driver's card:
  //   - 'driver': if they currently have a linked dashboard account, offer
  //     to revoke it. Otherwise no-op.
  //   - anything else: open the invite modal so we can prompt for email and
  //     call inviteEmployee to create/update the dashboard account.
  const handleRolePick = async (driver: ApprovedDriver, role: UserRole) => {
    setRoleMenuForKey(null);
    if (role === 'driver') {
      if (driver.dashboardUid) {
        const confirmed = confirm(
          `Remove dashboard access for ${driver.legalName || driver.displayName}?\n\n` +
            `Their driver phone-app login stays intact.`,
        );
        if (!confirmed) return;
        try {
          // Mark the users/{uid} record inactive by clearing role → driver.
          // We keep the auth account so the admin can re-promote without
          // a new invite link cycle.
          await update(ref(db, `users/${driver.dashboardUid}`), { role: 'driver' });
          await update(ref(db, `drivers/approved/${driver.key}`), {
            dashboardUid: null,
            dashboardRole: null,
          });
          setMessage(`Dashboard access removed for ${driver.legalName || driver.displayName}`);
          await loadDrivers();
        } catch (err) {
          console.error('Failed to remove dashboard access:', err);
          setMessage('Failed to remove dashboard access');
        }
      }
      return;
    }
    // Non-driver role → open invite modal
    setInviteTarget(driver);
    setInviteRole(role);
    setInviteEmail(''); // admin enters this
    setInviteResult(null);
  };

  const handleInviteSubmit = async () => {
    if (!inviteTarget || !inviteEmail.trim()) return;
    setInviteSending(true);
    try {
      const fn = httpsCallable(getFirebaseFunctions(), 'inviteEmployee');
      const resp: any = await fn({
        email: inviteEmail.trim(),
        displayName: inviteTarget.legalName || inviteTarget.displayName,
        role: inviteRole,
        companyId: inviteTarget.companyId || scopeCompanyId || undefined,
        driverHash: inviteTarget.key,
      });
      const data = resp?.data || {};
      setInviteResult({
        resetLink: data.resetLink || null,
        email: data.email || inviteEmail.trim(),
        role: inviteRole,
        existed: !!data.existed,
      });
      await loadDrivers(); // refresh so dashboardUid / dashboardRole appear
    } catch (err: any) {
      console.error('[DriversTab] inviteEmployee failed:', err);
      alert(`Invite failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setInviteSending(false);
    }
  };

  // ── Toggle admin role (driver-app-side isAdmin flag — kept as-is) ───
  const toggleDriverAdmin = async (driver: ApprovedDriver) => {
    try {
      const newAdmin = !driver.isAdmin;
      if (driver._legacy && driver._legacyDeviceId) {
        await update(ref(db, `drivers/approved/${driver.key}/${driver._legacyDeviceId}`), {
          isAdmin: newAdmin,
          isViewer: newAdmin ? false : driver.isViewer,
        });
      } else {
        await update(ref(db, `drivers/approved/${driver.key}`), {
          isAdmin: newAdmin,
          isViewer: newAdmin ? false : driver.isViewer,
        });
      }
      setMessage(`${driver.displayName} is ${newAdmin ? 'now an admin' : 'no longer an admin'}`);
      await loadDrivers();
    } catch (err) {
      console.error('Failed to toggle admin:', err);
    }
  };

  // ── Assign an operator to a driver ──
  const assignCustomer = async () => {
    if (!assignTarget || !newCustomerName.trim() || !newCustomerCompanyId.trim()) return;

    const existing = assignTarget.assignedCustomers || [];
    // Prevent duplicates
    if (existing.some(c => c.companyId === newCustomerCompanyId.trim())) {
      setMessage('This customer is already assigned');
      return;
    }

    const updated = [...existing, {
      name: newCustomerName.trim(),
      companyId: newCustomerCompanyId.trim().toLowerCase(),
    }];

    try {
      await set(ref(db, `drivers/approved/${assignTarget.key}/assignedCustomers`), updated);
      setMessage(`Assigned "${newCustomerName.trim()}" to ${assignTarget.displayName}`);
      setShowAssignModal(false);
      setNewCustomerName('');
      setNewCustomerCompanyId('');
      setAssignTarget(null);
      await loadDrivers();
    } catch (err) {
      console.error('Failed to assign customer:', err);
      setMessage('Failed to assign customer');
    }
  };

  // ── Remove an assigned customer ──
  const removeCustomer = async (driver: ApprovedDriver, companyId: string) => {
    const updated = (driver.assignedCustomers || []).filter(c => c.companyId !== companyId);
    try {
      await set(ref(db, `drivers/approved/${driver.key}/assignedCustomers`), updated);
      setMessage(`Removed operator assignment from ${driver.displayName}`);
      await loadDrivers();
    } catch (err) {
      console.error('Failed to remove customer:', err);
    }
  };

  // ── Delete a driver permanently ──
  const deleteDriver = async (driver: ApprovedDriver) => {
    if (!confirm(`Permanently delete ${driver.displayName}? This cannot be undone.`)) return;
    try {
      await remove(ref(db, `drivers/approved/${driver.key}`));
      setMessage(`Deleted: ${driver.displayName}`);
      await loadDrivers();
    } catch (err) {
      console.error('Failed to delete driver:', err);
      setMessage('Failed to delete driver');
    }
  };

  // Company-scoped filtering: if scopeCompanyId is set, only show drivers for that company
  const companyDrivers = scopeCompanyId
    ? approvedDrivers.filter(d => d.companyId === scopeCompanyId)
    : approvedDrivers;

  const filteredDrivers = search.trim()
    ? companyDrivers.filter(d =>
        d.displayName.toLowerCase().includes(search.toLowerCase())
      )
    : companyDrivers;

  // Dashboard users scoped the same way as drivers for search/company-filter
  const companyDashboardUsers = scopeCompanyId
    ? dashboardUsers.filter(u => u.companyId === scopeCompanyId)
    : dashboardUsers;
  const filteredDashboardUsers = search.trim()
    ? companyDashboardUsers.filter(u =>
        (u.displayName || '').toLowerCase().includes(search.toLowerCase()) ||
        (u.email || '').toLowerCase().includes(search.toLowerCase()),
      )
    : companyDashboardUsers;

  // ── WB-admin grouped view ────────────────────────────────────────────
  // For a WB admin (no scopeCompanyId), group employees by companyId into
  // collapsible sections. Company-scoped admins keep the flat list.
  //
  // Group key is the companyId string ('' = WellBuilt Staff — humans with
  // no companyId, typically platform admins like testerxxx).
  type EmployeeGroup = {
    companyId: string;             // '' for WB Staff
    companyName: string;
    drivers: ApprovedDriver[];
    users: DashboardUser[];
  };
  const groupedEmployees: EmployeeGroup[] = (() => {
    if (scopeCompanyId) return []; // grouped view unused for company-scoped admins
    const byCid = new Map<string, EmployeeGroup>();
    const keyFor = (cid: string | undefined) => cid || '';
    const nameFor = (cid: string | undefined, fallback: string | undefined): string => {
      if (!cid) return 'WellBuilt Staff';
      return fallback || cid;
    };
    for (const d of filteredDrivers) {
      const k = keyFor(d.companyId);
      if (!byCid.has(k)) {
        byCid.set(k, {
          companyId: k,
          companyName: nameFor(d.companyId, d.companyName),
          drivers: [],
          users: [],
        });
      }
      byCid.get(k)!.drivers.push(d);
    }
    for (const u of filteredDashboardUsers) {
      const k = keyFor(u.companyId);
      if (!byCid.has(k)) {
        byCid.set(k, {
          companyId: k,
          companyName: nameFor(u.companyId, u.companyName),
          drivers: [],
          users: [],
        });
      }
      byCid.get(k)!.users.push(u);
    }
    // Sort: WellBuilt Staff first (empty companyId), then companies alphabetically by name.
    const groups = Array.from(byCid.values());
    groups.sort((a, b) => {
      if (a.companyId === '' && b.companyId !== '') return -1;
      if (a.companyId !== '' && b.companyId === '') return 1;
      return a.companyName.localeCompare(b.companyName);
    });
    return groups;
  })();

  // Default collapse state: single-company view auto-expands; multi-company
  // starts collapsed so it doesn't scroll forever on first load.
  const defaultCollapsed = groupedEmployees.length > 1;
  const isGroupCollapsed = (cid: string) =>
    collapsedCompanies[cid] !== undefined ? collapsedCompanies[cid] : defaultCollapsed;
  const toggleGroup = (cid: string) =>
    setCollapsedCompanies(prev => ({ ...prev, [cid]: !isGroupCollapsed(cid) }));

  // For pending drivers, company admins see all pending (they'll approve into their company)
  const visiblePending = pendingDrivers;

  // ── Render helpers ────────────────────────────────────────────────────
  // Extracted so the same driver row + dashboard user row JSX can be used
  // by both the flat (company-scoped) list and the grouped (WB admin) list
  // without duplicating ~270 lines of markup.
  const renderDriverRow = (driver: ApprovedDriver) => (
    <div key={driver.key} className="bg-gray-700 rounded">
      {/* Driver row */}
      <div
        className="flex items-center justify-between p-3 cursor-pointer hover:bg-gray-600"
        onClick={() => setExpandedDriver(expandedDriver === driver.key ? null : driver.key)}
      >
        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full ${driver.active ? 'bg-green-400' : 'bg-gray-500'}`} />
          <div className="flex flex-col">
            <span className="text-white font-medium">{driver.displayName}</span>
            {driver.legalName && driver.legalName !== driver.displayName && (
              <span className="text-gray-400 text-xs">{driver.legalName}</span>
            )}
          </div>
          {isWbAdmin && driver._legacy && (
            <span className="px-1.5 py-0.5 bg-orange-700 text-orange-200 text-xs rounded font-medium">Legacy</span>
          )}
          {driver.dashboardRole ? (
            <span className="px-1.5 py-0.5 bg-purple-600 text-white text-xs rounded font-medium">
              {getRoleLabel(driver.dashboardRole, userCompany)}
            </span>
          ) : (
            <span className="px-1.5 py-0.5 bg-gray-600 text-gray-300 text-xs rounded font-medium">
              {getRoleLabel('driver', userCompany)}
            </span>
          )}
          {driver.isAdmin && (
            <span className="px-1.5 py-0.5 bg-slate-600 text-slate-200 text-xs rounded font-medium" title="WB T / WB S phone-app admin — separate from dashboard role">App Admin</span>
          )}
          {driver.isViewer && !driver.isAdmin && (
            <span className="px-1.5 py-0.5 bg-blue-600 text-blue-200 text-xs rounded font-medium" title="WB T / WB S phone-app viewer">App Viewer</span>
          )}
          {isWbAdmin && driver.companyName && (
            <span className="px-1.5 py-0.5 bg-teal-700 text-teal-200 text-xs rounded font-medium">{driver.companyName}</span>
          )}
          {isWbAdmin && !driver.companyId && (
            <span className="px-1.5 py-0.5 bg-gray-600 text-gray-300 text-xs rounded font-medium">No Company</span>
          )}
          {(driver.assignedCustomers?.length || 0) > 0 && (
            <span className="px-1.5 py-0.5 bg-yellow-600 text-yellow-200 text-xs rounded font-medium">
              {driver.assignedCustomers!.length} customer{driver.assignedCustomers!.length > 1 ? 's' : ''}
            </span>
          )}
          {(driver.assignedRoutes?.length || 0) > 0 && (
            <span className="px-1.5 py-0.5 bg-blue-600 text-blue-200 text-xs rounded font-medium">
              {driver.assignedRoutes!.length} route{driver.assignedRoutes!.length > 1 ? 's' : ''}
            </span>
          )}
          {driver.defaultPackageId && (
            <span className="px-1.5 py-0.5 bg-indigo-600 text-indigo-200 text-xs rounded font-medium">
              {availablePackages.find(p => p.id === driver.defaultPackageId)?.name || driver.defaultPackageId}
            </span>
          )}
        </div>
        <span className="text-gray-400 text-sm">
          {expandedDriver === driver.key ? '▲' : '▼'}
        </span>
      </div>

      {expandedDriver === driver.key && (
        <div className="border-t border-gray-600 p-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => toggleDriverActive(driver)}
              className={`px-3 py-1 text-sm rounded ${driver.active ? 'bg-gray-600 hover:bg-gray-500 text-gray-300' : 'bg-green-600 hover:bg-green-500 text-white'}`}
            >
              {driver.active ? 'Deactivate' : 'Activate'}
            </button>
            <div className="relative">
              <button
                onClick={() => setRoleMenuForKey(roleMenuForKey === driver.key ? null : driver.key)}
                className="px-3 py-1 text-sm rounded bg-purple-600 hover:bg-purple-500 text-white flex items-center gap-1"
                title={driver.dashboardRole ? `Currently: ${getRoleLabel(driver.dashboardRole, userCompany)}` : 'Driver only (no dashboard access)'}
              >
                {driver.dashboardRole ? getRoleLabel(driver.dashboardRole, userCompany) : 'Driver'}
                <span className="text-xs">▾</span>
              </button>
              {roleMenuForKey === driver.key && (
                <div className="absolute top-full left-0 mt-1 z-30 bg-gray-800 border border-gray-600 rounded shadow-xl min-w-[200px] max-h-72 overflow-y-auto">
                  {(['driver', 'viewer', 'dispatch', 'payroll', 'manager', 'admin', 'it'] as UserRole[]).map(r => {
                    const isCurrent = (r === 'driver' && !driver.dashboardRole) || r === driver.dashboardRole;
                    return (
                      <button
                        key={r}
                        onClick={() => handleRolePick(driver, r)}
                        className={`block w-full text-left px-3 py-1.5 text-sm hover:bg-purple-700/40 ${isCurrent ? 'bg-purple-700/50 text-white' : 'text-gray-200'}`}
                      >
                        <span className="font-medium">{getRoleLabel(r, userCompany)}</span>
                        <span className="text-[10px] text-gray-500 ml-2 font-mono">{r}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {isWbAdmin && (
              <button
                onClick={() => toggleDriverAdmin(driver)}
                className={`px-3 py-1 text-sm rounded ${driver.isAdmin ? 'bg-gray-600 hover:bg-gray-500 text-gray-300' : 'bg-slate-600 hover:bg-slate-500 text-gray-200'}`}
                title="Toggles the driver-app (WB T / WB S) admin menu access — separate from dashboard role"
              >
                {driver.isAdmin ? 'App Admin \u2713' : 'App Admin'}
              </button>
            )}
              {secureLoginStateFor(driver) === 'create' && (
                <button
                  onClick={() => { setSecureTarget(driver); }}
                  className="px-3 py-1 text-sm rounded bg-emerald-700 hover:bg-emerald-600 text-white"
                  title="Create a new secure login. Existing history stays under the old identity."
                >
                  Create secure login
                </button>
              )}
              {secureLoginStateFor(driver) === 'secured' && (
                <span
                  className="px-3 py-1 text-sm rounded bg-emerald-900/60 text-emerald-300"
                  title="This driver already has a canonical secure WellBuilt login. No create action is offered."
                >
                  Secure login active
                </span>
              )}
            <button
              onClick={() => { setAssignTarget(driver); setShowAssignModal(true); }}
              className="px-3 py-1 text-sm rounded bg-yellow-600 hover:bg-yellow-500 text-white"
            >
              + Assign Operator
            </button>
            <button
              onClick={() => { setRouteTarget(driver); setSelectedRoutes(driver.assignedRoutes || []); setShowRoutesModal(true); }}
              className="px-3 py-1 text-sm rounded bg-blue-600 hover:bg-blue-500 text-white"
            >
              {(driver.assignedRoutes?.length || 0) > 0 ? 'Edit Routes' : '+ Assign Routes'}
            </button>
            <button
              onClick={() => { setPackageTarget(driver); setSelectedPackageId(driver.defaultPackageId || ''); setShowPackageModal(true); }}
              className={`px-3 py-1 text-sm rounded ${driver.defaultPackageId ? 'bg-indigo-600 hover:bg-indigo-500 text-white' : 'bg-gray-600 hover:bg-gray-500 text-gray-300'}`}
            >
              {driver.defaultPackageId ? `Pkg: ${availablePackages.find(p => p.id === driver.defaultPackageId)?.name || driver.defaultPackageId}` : 'Default Package'}
            </button>
            {isWbAdmin && (
              <button
                onClick={() => { setCompanyTarget(driver); setAssignCompanyId(driver.companyId || ''); setAssignCompanyName(driver.companyName || ''); setCompanyError(''); setShowCompanyModal(true); }}
                className="px-3 py-1 text-sm rounded bg-teal-600 hover:bg-teal-500 text-white"
              >
                {driver.companyId ? 'Change Customer' : 'Assign Customer'}
              </button>
            )}
            {isWbAdmin && driver._legacy && (
              <button
                onClick={() => migrateDriver(driver)}
                className="px-3 py-1 text-sm rounded bg-orange-600 hover:bg-orange-500 text-white"
                title="Convert from legacy device-based format to new flat format"
              >
                Migrate
              </button>
            )}
            {isWbAdmin && (
              <button
                onClick={() => deleteDriver(driver)}
                className="px-3 py-1 text-sm rounded bg-red-700 hover:bg-red-600 text-red-200 ml-auto"
              >
                Delete
              </button>
            )}
          </div>

          <div>
            <h4 className="text-gray-400 text-xs font-medium uppercase tracking-wider mb-2">Assigned Operators</h4>
            {(driver.assignedCustomers?.length || 0) === 0 ? (
              <p className="text-gray-500 text-sm">No operators assigned</p>
            ) : (
              <div className="space-y-1">
                {driver.assignedCustomers!.map(c => (
                  <div key={c.companyId} className="flex items-center justify-between bg-gray-800 rounded p-2">
                    <div>
                      <span className="text-yellow-300 text-sm font-medium">{c.name}</span>
                      <span className="text-gray-500 text-xs ml-2">({c.companyId})</span>
                    </div>
                    <button onClick={() => removeCustomer(driver, c.companyId)} className="text-red-400 hover:text-red-300 text-xs">Remove</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h4 className="text-gray-400 text-xs font-medium uppercase tracking-wider mb-2">Assigned Routes</h4>
            {(driver.assignedRoutes?.length || 0) === 0 ? (
              <p className="text-gray-500 text-sm">No routes assigned (sees all wells)</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {driver.assignedRoutes!.map(route => (
                  <span key={route} className="px-2 py-1 bg-blue-900 text-blue-200 text-sm rounded">{route}</span>
                ))}
              </div>
            )}
          </div>

          {isWbAdmin && (
            <div className="text-gray-500 text-xs font-mono">
              Hash: {driver.key.slice(0, 12)}...
              {driver._legacy && (
                <span className="text-orange-400 ml-2">(legacy format — device: {driver._legacyDeviceId?.slice(0, 8)}...)</span>
              )}
              {driver.companyId && (
                <span className="text-teal-400 ml-2">Customer: {driver.companyId}</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );

  // Dashboard-user row — simpler than driver. Shows email + role badge.
  // The role label badge uses the same purple styling as drivers with
  // dashboard access, so both render consistently side-by-side.
  const renderDashboardUserRow = (u: DashboardUser) => (
    <div key={u.uid} className="bg-gray-700/70 rounded p-3 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-purple-400" />
        <div className="flex flex-col">
          <span className="text-white font-medium">{u.displayName}</span>
          <span className="text-gray-400 text-xs">{u.email}</span>
        </div>
        <span className="px-1.5 py-0.5 bg-purple-600 text-white text-xs rounded font-medium">
          {getRoleLabel(u.role, userCompany)}
        </span>
        {u.driverHash && (
          <span className="px-1.5 py-0.5 bg-slate-700 text-slate-300 text-xs rounded font-medium" title="Also has a driver phone-app login linked to this dashboard user">
            + driver login
          </span>
        )}
      </div>
      <span className="text-[10px] text-gray-500 font-mono">{u.uid.slice(0, 10)}…</span>
    </div>
  );

  if (loading) {
    return (
      <div className="text-gray-400 text-center py-12">Loading drivers...</div>
    );
  }

  return (
    <div className="space-y-6">
      {message && (
        <div className="p-3 bg-blue-900 text-blue-200 rounded text-sm">{message}</div>
      )}

      {/* ── Pending Registrations ── */}
      {pendingDrivers.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-yellow-400 font-medium mb-3 flex items-center gap-2">
            <span className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
            Pending Registrations ({pendingDrivers.length})
          </h3>
          <div className="space-y-2">
            {pendingDrivers.map(driver => (
              <div key={driver.key} className="flex items-center justify-between bg-gray-700 rounded p-3">
                <div>
                  <span className="text-white font-medium">{driver.displayName}</span>
                  {driver.legalName && driver.legalName !== driver.displayName && (
                    <span className="text-gray-400 text-xs ml-2">({driver.legalName})</span>
                  )}
                  {driver.companyName && (
                    <span className="px-1.5 py-0.5 bg-teal-700 text-teal-200 text-xs rounded font-medium ml-2">
                      {driver.companyName}
                    </span>
                  )}
                  {driver.timestamp && (
                    <span className="text-gray-400 text-xs ml-2">
                      {new Date(driver.timestamp).toLocaleDateString()}
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setApprovalTarget(driver);
                      // Pre-select company
                      if (scopeCompanyId) {
                        const match = companiesList.find(c => c.id === scopeCompanyId);
                        setApprovalCompanyId(scopeCompanyId);
                        setApprovalCompanyName(match?.name || '');
                      } else if (driver.companyName) {
                        const driverCoLower = driver.companyName.toLowerCase().trim();
                        const match = companiesList.find(c => {
                          const coNameLower = c.name.toLowerCase().trim();
                          return coNameLower === driverCoLower || coNameLower.includes(driverCoLower) || driverCoLower.includes(coNameLower);
                        });
                        if (match) {
                          setApprovalCompanyId(match.id);
                          setApprovalCompanyName(match.name);
                        } else {
                          setApprovalCompanyId('');
                          setApprovalCompanyName('');
                        }
                      } else {
                        setApprovalCompanyId('');
                        setApprovalCompanyName('');
                      }
                      setApprovalCustomers([]);
                      setApprovalRoutes([]);
                      setShowApprovalModal(true);
                    }}
                    className="px-3 py-1 bg-green-600 hover:bg-green-500 text-white text-sm rounded"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => rejectDriver(driver)}
                    className="px-3 py-1 bg-red-600 hover:bg-red-500 text-white text-sm rounded"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Unified Employee panel (7/9 refactor) ── */}
      <EmployeePanel
        employees={scopeCompanyId ? employees.filter(e => e.companyId === scopeCompanyId) : employees}
        isWbAdmin={isWbAdmin}
        scopeCompanyId={scopeCompanyId}
        onToggleMobile={(row) => { if (row.driver) toggleDriverActive(row.driver); }}
        secureLoginStateFor={(row) => (row.driver ? secureLoginStateFor(row.driver) : 'none')}
        onCreateSecureLogin={(row) => {
          // Guarded: the shared modal opens ONLY for a row the resolver
          // deems eligible — a secured or inactive row cannot re-enter.
          if (row.driver && secureLoginStateFor(row.driver) === 'create') {
            setSecureTarget(row.driver);
          }
        }}
        onInvite={(row) => {
          if (!row.driver) return;
          setInviteTarget(row.driver);
          setInviteRole('dispatch');
          setInviteEmail('');
          setInviteResult(null);
        }}
        onSaveRoles={saveEmployeeRoles}
        onAssignRoutes={(row) => {
          if (!row.driver) return;
          setRouteTarget(row.driver); setSelectedRoutes(row.driver.assignedRoutes || []); setShowRoutesModal(true);
        }}
        onAssignCompany={(row) => {
          if (!row.driver) return;
          setCompanyTarget(row.driver); setAssignCompanyId(row.driver.companyId || ''); setAssignCompanyName(row.driver.companyName || ''); setCompanyError(''); setShowCompanyModal(true);
        }}
      />

      <div className="flex justify-end">
        <button
          onClick={() => setShowLegacyView(v => !v)}
          className="text-xs text-gray-500 hover:text-gray-300 underline"
        >
          {showLegacyView ? 'Hide legacy view' : 'Show legacy view'}
        </button>
      </div>

      {showLegacyView && (<>
      {/* ── Approved Drivers ── */}
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-medium">
            {scopeCompanyId ? 'Your Employees' : 'All Employees'} ({companyDrivers.length})
            {isWbAdmin && approvedDrivers.some(d => d._legacy) && (
              <span className="text-orange-400 text-xs ml-2 font-normal">
                ({approvedDrivers.filter(d => d._legacy).length} legacy)
              </span>
            )}
            {isWbAdmin && !scopeCompanyId && approvedDrivers.some(d => !d.companyId) && (
              <span className="text-gray-400 text-xs ml-2 font-normal">
                ({approvedDrivers.filter(d => !d.companyId).length} unassigned)
              </span>
            )}
          </h3>
          <div className="flex gap-2">
            {isWbAdmin && approvedDrivers.some(d => d._legacy) && (
              <button
                onClick={migrateAllLegacy}
                className="px-3 py-1.5 bg-orange-600 hover:bg-orange-500 text-white text-sm rounded"
              >
                Migrate All Legacy
              </button>
            )}
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search drivers..."
              className="px-3 py-1.5 bg-gray-700 text-white rounded text-sm placeholder-gray-500 w-48"
            />
          </div>
        </div>

        {filteredDrivers.length === 0 && filteredDashboardUsers.length === 0 ? (
          <div className="text-gray-500 text-center py-6">
            {search ? 'No employees match search' : 'No approved employees yet'}
          </div>
        ) : scopeCompanyId ? (
          // Company-scoped admin view — flat list of drivers, then a small
          // section for the company's dashboard-only users.
          <div className="space-y-2">
            {filteredDrivers.map(renderDriverRow)}
            {filteredDashboardUsers.length > 0 && (
              <div className="mt-4 pt-4 border-t border-gray-700">
                <h4 className="text-gray-400 text-xs font-medium uppercase tracking-wider mb-2">
                  Dashboard Users ({filteredDashboardUsers.length})
                </h4>
                <div className="space-y-2">
                  {filteredDashboardUsers.map(renderDashboardUserRow)}
                </div>
              </div>
            )}
          </div>
        ) : (
          // WB-admin view — grouped by company with collapsible sections.
          // Platform staff (users with no companyId) sort to the top under
          // "WellBuilt Staff". Each section shows drivers first, then a
          // smaller Dashboard Users subsection inside the same group.
          <div className="space-y-3">
            {groupedEmployees.length === 0 ? (
              <div className="text-gray-500 text-center py-6">
                No approved employees yet
              </div>
            ) : (
              groupedEmployees.map(group => {
                const total = group.drivers.length + group.users.length;
                const collapsed = isGroupCollapsed(group.companyId);
                return (
                  <div key={group.companyId || 'wb-staff'} className="bg-gray-700/40 rounded-lg overflow-hidden">
                    <button
                      onClick={() => toggleGroup(group.companyId)}
                      className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-700/80 hover:bg-gray-600 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className={`text-gray-400 text-sm transition-transform ${collapsed ? '' : 'rotate-90'}`}>▸</span>
                        <span className="text-white font-medium">{group.companyName}</span>
                        {group.companyId === '' && (
                          <span className="px-1.5 py-0.5 bg-indigo-700 text-indigo-200 text-[10px] rounded font-medium">Platform</span>
                        )}
                        <span className="text-gray-400 text-xs">
                          {total} employee{total === 1 ? '' : 's'}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs">
                        {group.drivers.length > 0 && (
                          <span className="text-gray-400">{group.drivers.length} driver{group.drivers.length === 1 ? '' : 's'}</span>
                        )}
                        {group.users.length > 0 && (
                          <span className="text-purple-300">{group.users.length} dashboard</span>
                        )}
                      </div>
                    </button>
                    {!collapsed && (
                      <div className="p-3 space-y-2">
                        {group.drivers.length > 0 && (
                          <div className="space-y-2">
                            {group.drivers.map(renderDriverRow)}
                          </div>
                        )}
                        {group.users.length > 0 && (
                          <div className={`${group.drivers.length > 0 ? 'pt-2 mt-2 border-t border-gray-600' : ''}`}>
                            <h4 className="text-gray-400 text-[10px] font-medium uppercase tracking-wider mb-2">
                              Dashboard Users
                            </h4>
                            <div className="space-y-2">
                              {group.users.map(renderDashboardUserRow)}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      </>)}

      {/* ── Assign Company Modal (WB admin only) ── */}
      {showCompanyModal && companyTarget && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-white font-medium mb-1">Assign to Customer</h3>
            <p className="text-gray-400 text-sm mb-2">
              Assign <span className="text-white">{companyTarget.displayName}</span> to a customer
            </p>

            {/* Route-accurate framing: canonical rows bind server-side with
                shift authority; legacy rows only stage metadata. */}
            {hasCanonicalDriverId(companyTarget) ? (
              companyTarget.companyId ? (
                <p className="text-xs text-gray-400 mb-3">
                  Current company: <span className="text-teal-300">{companyTarget.companyName || companyTarget.companyId}</span>.
                  {' '}This is initial binding only — moving a secure driver to a different
                  company is a separate transfer workflow.
                </p>
              ) : (
                <p className="text-xs text-gray-400 mb-3">
                  Secure driver — binding runs on the server and initializes
                  shift authority for the selected company.
                </p>
              )
            ) : (
              <p className="text-xs text-gray-500 mb-3">
                Legacy row — this selection is staging metadata. It is applied
                to the secure identity when the secure login is created.
              </p>
            )}

            <div className="space-y-3">
              <div>
                <label className="text-gray-400 text-sm block mb-1">Customer</label>
                <select
                  value={assignCompanyId}
                  onChange={e => {
                    const id = e.target.value;
                    setAssignCompanyId(id);
                    const match = companiesList.find(c => c.id === id);
                    setAssignCompanyName(match?.name || '');
                    setCompanyError('');
                  }}
                  disabled={companyBusy}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                  autoFocus
                >
                  <option value="">— No Customer (Remove) —</option>
                  {companiesList.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {companyError && (
              <p className="text-[11px] text-red-400 mt-2 break-words">{companyError}</p>
            )}

            <div className="flex gap-2 mt-4">
              <button
                onClick={assignDriverCompany}
                disabled={companyBusy}
                className="flex-1 px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white rounded disabled:opacity-50"
              >
                {companyBusy ? 'Assigning…' : assignCompanyId.trim() ? 'Assign' : 'Remove from Customer'}
              </button>
              <button
                onClick={() => {
                  setShowCompanyModal(false);
                  setCompanyTarget(null);
                  setAssignCompanyId('');
                  setAssignCompanyName('');
                  setCompanyError('');
                }}
                disabled={companyBusy}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Create Secure Login Modal ── */}
      {secureTarget && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full my-8">
            <h3 className="text-white font-medium mb-1">Create secure login</h3>
            <p className="text-gray-400 text-sm">
              For <span className="text-white">{secureTarget.displayName}</span>
              {secureTarget.companyName ? (
                <span className="text-gray-400"> &middot; {secureTarget.companyName}</span>
              ) : null}
            </p>

            <ul className="mt-3 mb-4 text-xs text-gray-400 list-disc list-inside space-y-1">
              {confirmationCopyFor('create_secure_login').map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>

            {secureDone ? (
              <>
                <p className="text-emerald-400 text-sm break-words">{secureDone}</p>
                <div className="flex justify-end mt-5">
                  <button
                    onClick={closeSecureModal}
                    className="px-4 py-2 text-sm rounded bg-gray-600 hover:bg-gray-500 text-white"
                  >
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <label className="block text-xs text-gray-400 mb-1" htmlFor="secure-pass">
                  New password
                </label>
                <input
                  id="secure-pass"
                  type="password"
                  autoComplete="new-password"
                  value={securePass}
                  onChange={(e) => { setSecurePass(e.target.value); setSecureError(''); }}
                  disabled={secureBusy}
                  className="w-full mb-3 px-3 py-2 rounded bg-gray-900 text-white text-sm border border-gray-700 focus:border-emerald-500 outline-none"
                />

                <label className="block text-xs text-gray-400 mb-1" htmlFor="secure-confirm">
                  Confirm password
                </label>
                <input
                  id="secure-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={secureConfirm}
                  onChange={(e) => { setSecureConfirm(e.target.value); setSecureError(''); }}
                  disabled={secureBusy}
                  className="w-full mb-2 px-3 py-2 rounded bg-gray-900 text-white text-sm border border-gray-700 focus:border-emerald-500 outline-none"
                />

                <p className="text-[11px] text-gray-500 mb-1">{PASSCODE_GUIDANCE}</p>
                {securePass && localPolicyError(securePass) && (
                  <p className="text-[11px] text-amber-400 mb-1">{localPolicyError(securePass)}</p>
                )}
                {securePass && secureConfirm && securePass !== secureConfirm && (
                  <p className="text-[11px] text-amber-400 mb-1">Passwords do not match.</p>
                )}
                {secureError && (
                  <p className="text-[11px] text-red-400 mb-1 break-words">{secureError}</p>
                )}

                <div className="flex flex-wrap justify-end gap-2 mt-5">
                  <button
                    onClick={closeSecureModal}
                    disabled={secureBusy}
                    className="px-4 py-2 text-sm rounded bg-gray-600 hover:bg-gray-500 text-white disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => { void handleCreateSecureLogin(); }}
                    disabled={!canSubmit({ passcode: securePass, confirm: secureConfirm, submitting: secureBusy })}
                    className="px-4 py-2 text-sm rounded bg-emerald-700 hover:bg-emerald-600 text-white disabled:opacity-50"
                  >
                    {secureBusy ? 'Creating…' : 'Create secure login'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}


      {/* ── Assign Operator Modal ── */}
      {showAssignModal && assignTarget && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-white font-medium mb-1">Assign Operator</h3>
            <p className="text-gray-400 text-sm mb-4">
              Assign an operator to <span className="text-white">{assignTarget.displayName}</span>
            </p>

            {(() => {
              // Find the driver's company and its assigned operators
              const driverCompany = assignTarget.companyId
                ? companiesList.find(c => c.id === assignTarget.companyId)
                : null;
              const operators = driverCompany?.assignedOperators || [];
              const alreadyAssigned = (assignTarget.assignedCustomers || []).map(c => c.name);
              const available = operators.filter(op => !alreadyAssigned.includes(op));

              return (
                <div className="space-y-3">
                  {!assignTarget.companyId ? (
                    <p className="text-yellow-400 text-sm">
                      This driver is not assigned to a customer yet. Assign a customer first, then add operators.
                    </p>
                  ) : operators.length === 0 ? (
                    <p className="text-yellow-400 text-sm">
                      {driverCompany?.name || assignTarget.companyId} has no oil companies configured.
                      Add them on the Companies tab first.
                    </p>
                  ) : available.length === 0 ? (
                    <p className="text-yellow-400 text-sm">
                      All oil companies for {driverCompany?.name} are already assigned to this driver.
                    </p>
                  ) : (
                    <div>
                      <label className="text-gray-400 text-sm block mb-1">Oil Company (Operator)</label>
                      <select
                        value={newCustomerName}
                        onChange={e => {
                          setNewCustomerName(e.target.value);
                          setNewCustomerCompanyId(assignTarget.companyId || '');
                        }}
                        className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                        autoFocus
                      >
                        <option value="">Select an operator...</option>
                        {available.map(op => (
                          <option key={op} value={op}>{op}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              );
            })()}

            <div className="flex gap-2 mt-4">
              <button
                onClick={assignCustomer}
                disabled={!newCustomerName.trim() || !newCustomerCompanyId.trim()}
                className="flex-1 px-4 py-2 bg-yellow-600 hover:bg-yellow-500 text-white rounded disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Assign
              </button>
              <button
                onClick={() => {
                  setShowAssignModal(false);
                  setAssignTarget(null);
                  setNewCustomerName('');
                  setNewCustomerCompanyId('');
                }}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Combined Approval Modal ── */}
      {showApprovalModal && approvalTarget && (() => {
        const selectedCompany = companiesList.find(c => c.id === approvalCompanyId);
        const operators = selectedCompany?.assignedOperators || [];
        const isCompanyScoped = !!scopeCompanyId;
        const canApprove = approvalCompanyId && approvalCustomers.length > 0 && approvalRoutes.length > 0;

        return (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-gray-800 rounded-lg p-6 max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
              <h3 className="text-white font-medium text-lg mb-1">Approve Employee</h3>
              <p className="text-gray-400 text-sm mb-4">
                <span className="text-white font-medium">{approvalTarget.displayName}</span>
                {approvalTarget.legalName && approvalTarget.legalName !== approvalTarget.displayName && (
                  <span className="text-gray-500 ml-1">({approvalTarget.legalName})</span>
                )}
                {approvalTarget.companyName && (
                  <span className="text-teal-400 ml-2">registered as: {approvalTarget.companyName}</span>
                )}
              </p>

              {/* Section 1: Customer */}
              <div className="mb-4">
                <label className="text-gray-400 text-xs font-medium uppercase tracking-wider block mb-2">
                  Customer <span className="text-red-400">*</span>
                </label>
                <select
                  value={approvalCompanyId}
                  onChange={e => {
                    const id = e.target.value;
                    setApprovalCompanyId(id);
                    const match = companiesList.find(c => c.id === id);
                    setApprovalCompanyName(match?.name || '');
                    setApprovalCustomers([]); // Reset operators when customer changes
                  }}
                  disabled={isCompanyScoped}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm disabled:opacity-60"
                >
                  <option value="">Select a customer...</option>
                  {companiesList.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              {/* Section 2: Roles / Titles */}
              <div className="mb-4">
                <label className="text-gray-400 text-xs font-medium uppercase tracking-wider block mb-2">
                  Roles <span className="text-red-400">*</span>
                  {approvalRoles.length > 0 && (
                    <span className="text-cyan-400 ml-2 normal-case">{approvalRoles.length} selected</span>
                  )}
                </label>
                <div className="space-y-1 bg-gray-900 rounded p-2">
                  {['driver', 'dispatcher', 'billing', 'payroll', 'mechanic', 'admin', 'manager'].map(role => (
                    <label key={role} className="flex items-center gap-3 cursor-pointer hover:bg-gray-700 rounded p-1.5">
                      <input
                        type="checkbox"
                        checked={approvalRoles.includes(role)}
                        onChange={e => {
                          if (e.target.checked) {
                            setApprovalRoles([...approvalRoles, role]);
                          } else {
                            setApprovalRoles(approvalRoles.filter(r => r !== role));
                          }
                        }}
                        className="w-4 h-4 rounded"
                      />
                      <span className="text-cyan-300 text-sm capitalize">{role}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Section 3: Operators */}
              <div className="mb-4">
                <label className="text-gray-400 text-xs font-medium uppercase tracking-wider block mb-2">
                  Operators <span className="text-red-400">*</span>
                  {approvalCustomers.length > 0 && (
                    <span className="text-yellow-400 ml-2 normal-case">{approvalCustomers.length} selected</span>
                  )}
                </label>
                {!approvalCompanyId ? (
                  <p className="text-gray-500 text-sm">Select a customer first</p>
                ) : operators.length === 0 ? (
                  <p className="text-yellow-400 text-sm">
                    {selectedCompany?.name} has no oil companies configured. Add them on the Companies tab.
                  </p>
                ) : (
                  <div className="space-y-1 max-h-40 overflow-y-auto bg-gray-900 rounded p-2">
                    {operators.map(op => (
                      <label key={op} className="flex items-center gap-3 cursor-pointer hover:bg-gray-700 rounded p-1.5">
                        <input
                          type="checkbox"
                          checked={approvalCustomers.includes(op)}
                          onChange={e => {
                            if (e.target.checked) {
                              setApprovalCustomers([...approvalCustomers, op]);
                            } else {
                              setApprovalCustomers(approvalCustomers.filter(c => c !== op));
                            }
                          }}
                          className="w-4 h-4 rounded"
                        />
                        <span className="text-yellow-300 text-sm">{op}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Section 3: Routes */}
              <div className="mb-4">
                <label className="text-gray-400 text-xs font-medium uppercase tracking-wider block mb-2">
                  Route <span className="text-red-400">*</span>
                  {approvalRoutes.length > 0 && (
                    <span className="text-blue-400 ml-2 normal-case">{approvalRoutes.length} selected</span>
                  )}
                </label>
                {availableRoutes.length === 0 ? (
                  <p className="text-gray-500 text-sm">No routes found in well_config</p>
                ) : (
                  <div className="space-y-1 max-h-40 overflow-y-auto bg-gray-900 rounded p-2">
                    {availableRoutes.map(route => (
                      <label key={route} className="flex items-center gap-3 cursor-pointer hover:bg-gray-700 rounded p-1.5">
                        <input
                          type="checkbox"
                          checked={approvalRoutes.includes(route)}
                          onChange={e => {
                            if (e.target.checked) {
                              setApprovalRoutes([...approvalRoutes, route]);
                            } else {
                              setApprovalRoutes(approvalRoutes.filter(r => r !== route));
                            }
                          }}
                          className="w-4 h-4 rounded"
                        />
                        <span className={`text-sm ${route.startsWith('Unrouted') ? 'text-gray-400' : 'text-white'}`}>
                          {route}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex gap-2">
                <button
                  onClick={approveDriverWithAssignments}
                  disabled={!canApprove}
                  className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded font-medium disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Approve Employee
                </button>
                <button
                  onClick={() => {
                    setShowApprovalModal(false);
                    setApprovalTarget(null);
                    setApprovalCompanyId('');
                    setApprovalCompanyName('');
                    setApprovalCustomers([]);
                    setApprovalRoutes([]);
                    setApprovalRoles(['driver']);
                  }}
                  className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Assign Routes Modal ── */}
      {showRoutesModal && routeTarget && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-white font-medium mb-1">Assign Routes</h3>
            <p className="text-gray-400 text-sm mb-4">
              Select routes for <span className="text-white">{routeTarget.displayName}</span>
            </p>

            {availableRoutes.length === 0 ? (
              <p className="text-yellow-400 text-sm">No routes found in well_config.</p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {availableRoutes.map(route => (
                  <label key={route} className="flex items-center gap-3 cursor-pointer hover:bg-gray-700 rounded p-2">
                    <input
                      type="checkbox"
                      checked={selectedRoutes.includes(route)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedRoutes([...selectedRoutes, route]);
                        } else {
                          setSelectedRoutes(selectedRoutes.filter(r => r !== route));
                        }
                      }}
                      className="w-4 h-4 rounded"
                    />
                    <span className="text-white text-sm">{route}</span>
                  </label>
                ))}
              </div>
            )}

            <div className="flex gap-2 mt-4">
              <button
                onClick={assignDriverRoutes}
                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded"
              >
                {selectedRoutes.length > 0
                  ? `Assign ${selectedRoutes.length} Route${selectedRoutes.length > 1 ? 's' : ''}`
                  : 'Remove All Routes'}
              </button>
              <button
                onClick={() => {
                  setShowRoutesModal(false);
                  setRouteTarget(null);
                  setSelectedRoutes([]);
                }}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Default Package Modal ── */}
      {showPackageModal && packageTarget && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-white font-medium mb-1">Default Job Package</h3>
            <p className="text-gray-400 text-sm mb-4">
              Set the default package for <span className="text-white">{packageTarget.displayName}</span>.
              This is pre-selected when the driver starts their shift.
            </p>

            <div>
              <label className="text-gray-400 text-sm block mb-1">Package</label>
              <select
                value={selectedPackageId}
                onChange={e => setSelectedPackageId(e.target.value)}
                className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                autoFocus
              >
                <option value="">— No Default —</option>
                {availablePackages.map(pkg => (
                  <option key={pkg.id} value={pkg.id}>{pkg.name}</option>
                ))}
              </select>
            </div>

            <div className="flex gap-2 mt-4">
              <button
                onClick={setDriverDefaultPackage}
                className="flex-1 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded"
              >
                {selectedPackageId ? 'Set Default' : 'Clear Default'}
              </button>
              <button
                onClick={() => {
                  setShowPackageModal(false);
                  setPackageTarget(null);
                  setSelectedPackageId('');
                }}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Invite Employee modal ─────────────────────────────────────────
          Opens when a driver's Role dropdown picks a dashboard role. Admin
          enters an email; inviteEmployee Cloud Function creates the
          Firebase Auth account (or reuses an existing one) and returns a
          password-reset link. We render the link for the admin to
          copy/send — no email provider required for v1. */}
      {inviteTarget && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-gray-800 rounded-lg max-w-md w-full max-h-[90vh] overflow-y-auto">
            <div className="p-4 border-b border-gray-700 flex items-start justify-between">
              <div>
                <h3 className="text-lg font-bold text-white">
                  Invite {inviteTarget.legalName || inviteTarget.displayName}
                </h3>
                <p className="text-sm text-gray-400 mt-1">
                  Grant dashboard access as{' '}
                  <span className="text-purple-300 font-medium">
                    {getRoleLabel(inviteRole, userCompany)}
                  </span>
                </p>
              </div>
              <button
                onClick={() => {
                  setInviteTarget(null);
                  setInviteResult(null);
                  setInviteEmail('');
                }}
                className="text-gray-500 hover:text-white text-xl leading-none"
              >
                ✕
              </button>
            </div>

            <div className="p-4 space-y-3">
              {!inviteResult ? (
                <>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1 uppercase tracking-wider">
                      Email address
                    </label>
                    <input
                      type="email"
                      value={inviteEmail}
                      onChange={e => setInviteEmail(e.target.value)}
                      placeholder="employee@example.com"
                      className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-purple-500"
                      autoFocus
                    />
                    <p className="text-[11px] text-gray-500 mt-1">
                      We'll create a dashboard login and return a password-reset link you can send them.
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1 uppercase tracking-wider">
                      Role
                    </label>
                    <select
                      value={inviteRole}
                      onChange={e => setInviteRole(e.target.value as UserRole)}
                      className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500"
                    >
                      {(['viewer', 'dispatch', 'payroll', 'manager', 'admin', 'it'] as UserRole[]).map(r => (
                        <option key={r} value={r}>
                          {getRoleLabel(r, userCompany)} ({r})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      onClick={() => {
                        setInviteTarget(null);
                        setInviteEmail('');
                      }}
                      className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white text-sm rounded"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleInviteSubmit}
                      disabled={!inviteEmail.trim() || inviteSending}
                      className={`px-4 py-2 text-sm rounded font-medium ${
                        !inviteEmail.trim() || inviteSending
                          ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                          : 'bg-purple-600 hover:bg-purple-500 text-white'
                      }`}
                    >
                      {inviteSending ? 'Sending…' : 'Send invite'}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="bg-green-900/30 border border-green-700 rounded p-3">
                    <p className="text-green-300 font-medium text-sm">
                      {inviteResult.existed
                        ? 'Existing Firebase account updated'
                        : 'Dashboard account created'}
                    </p>
                    <p className="text-green-200 text-xs mt-1">
                      {inviteResult.email} now has{' '}
                      <span className="font-medium">
                        {getRoleLabel(inviteResult.role, userCompany)}
                      </span>{' '}
                      access.
                    </p>
                  </div>
                  {inviteResult.resetLink ? (
                    <div>
                      <label className="block text-xs text-gray-400 mb-1 uppercase tracking-wider">
                        Password-reset / setup link
                      </label>
                      <textarea
                        readOnly
                        value={inviteResult.resetLink}
                        onClick={e => (e.target as HTMLTextAreaElement).select()}
                        className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-[11px] font-mono text-green-300 break-all resize-none"
                        rows={4}
                      />
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(inviteResult.resetLink!);
                            setMessage('Invite link copied to clipboard');
                          }}
                          className="flex-1 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs rounded"
                        >
                          Copy link
                        </button>
                        <a
                          href={`mailto:${inviteResult.email}?subject=${encodeURIComponent('Your WellBuilt dashboard invite')}&body=${encodeURIComponent(`Click this link to set your dashboard password:\n\n${inviteResult.resetLink}`)}`}
                          className="flex-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded text-center"
                        >
                          Open email
                        </a>
                      </div>
                      <p className="text-[11px] text-gray-500 mt-2">
                        Send this link to the employee. Firebase Auth's reset page
                        lets them set (or reset) their password. Link expires per
                        Firebase's default (about 1 hour).
                      </p>
                    </div>
                  ) : (
                    <p className="text-yellow-300 text-xs">
                      The account was created, but we couldn't generate a
                      reset link. The employee can use "Forgot password" on
                      the sign-in page.
                    </p>
                  )}
                  <div className="flex justify-end pt-2">
                    <button
                      onClick={() => {
                        setInviteTarget(null);
                        setInviteResult(null);
                        setInviteEmail('');
                      }}
                      className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white text-sm rounded"
                    >
                      Done
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
