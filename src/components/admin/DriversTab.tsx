'use client';

import { useEffect, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { getFirebaseDatabase, getFirestoreDb, getFirebaseFunctions } from '@/lib/firebase';
import { ref, get, set, remove, update, push, serverTimestamp } from 'firebase/database';
import { collection, getDocs } from 'firebase/firestore';
import { fetchCompanyRouteNames } from '@/lib/wells';
import { probeDriverHistory, type DriverHistorySummary } from '@/lib/driverHistory';
import { type UserRole, DEFAULT_ROLE_LABELS } from '@/lib/auth';
import { useAuth } from '@/contexts/AuthContext';
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
  archived?: boolean;    // hidden from the normal employee list (login also disabled)
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
  _legacy?: boolean;     // true if stored in old {hash}/{deviceId}/ format
  _legacyDeviceId?: string; // the device sub-key for legacy records
}

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
  // Lifecycle: archived drivers are hidden unless this toggle is on.
  const [showArchived, setShowArchived] = useState(false);

  // Guarded hard-delete modal
  const [deleteTarget, setDeleteTarget] = useState<ApprovedDriver | null>(null);
  const [deleteProbe, setDeleteProbe] = useState<DriverHistorySummary | null>(null);
  const [deleteProbing, setDeleteProbing] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [deleteOverride, setDeleteOverride] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Pre-delete explanation/acknowledgement modal (shown before the guarded modal).
  const [explainTarget, setExplainTarget] = useState<ApprovedDriver | null>(null);

  // Assign customer modal
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [assignTarget, setAssignTarget] = useState<ApprovedDriver | null>(null);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerCompanyId, setNewCustomerCompanyId] = useState('');

  // Assign company modal (WB admin only)
  const [showCompanyModal, setShowCompanyModal] = useState(false);
  const [companyTarget, setCompanyTarget] = useState<ApprovedDriver | null>(null);
  const [assignCompanyId, setAssignCompanyId] = useState('');
  const [assignCompanyName, setAssignCompanyName] = useState('');
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

  const { userCompany, user } = useAuth();
  const db = getFirebaseDatabase();

  const loadDrivers = async () => {
    setLoading(true);
    try {
      // Load approved drivers
      const approvedSnap = await get(ref(db, 'drivers/approved'));
      const approved: ApprovedDriver[] = [];
      if (approvedSnap.exists()) {
        const data = approvedSnap.val();
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
              archived: val.archived === true,
              companyId: val.companyId || undefined,
              companyName: val.companyName || undefined,
              assignedCustomers: Array.isArray(val.assignedCustomers) ? val.assignedCustomers : [],
              assignedRoutes: Array.isArray(val.assignedRoutes) ? val.assignedRoutes : [],
              assignedWells: Array.isArray(val.assignedWells) ? val.assignedWells : [],
              defaultPackageId: val.defaultPackageId || undefined,
              dashboardUid: val.dashboardUid || undefined,
              dashboardRole: val.dashboardRole || undefined,
            });
          } else {
            // Legacy structure: drivers/approved/{hash}/{deviceId}/ = { displayName, active, ... }
            // Each sub-key is a device ID with its own record — pick the first one with a displayName
            let foundName = '';
            let foundAdmin = false;
            let foundViewer = false;
            let foundActive = true;
            let foundArchived = false;
            for (const subKey of Object.keys(val)) {
              const entry = val[subKey];
              if (entry && typeof entry === 'object' && entry.displayName) {
                foundName = entry.displayName;
                foundAdmin = entry.isAdmin === true;
                foundViewer = entry.isViewer === true;
                foundActive = entry.active !== false;
                foundArchived = entry.archived === true;
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
              archived: foundArchived,
              assignedCustomers: Array.isArray(val.assignedCustomers) ? val.assignedCustomers : [],
              assignedRoutes: Array.isArray(val.assignedRoutes) ? val.assignedRoutes : [],
              assignedWells: Array.isArray(val.assignedWells) ? val.assignedWells : [],
              _legacy: true,
              _legacyDeviceId: legacyDeviceId,
            });
          }
        });
      }
      approved.sort((a, b) => a.displayName.localeCompare(b.displayName));
      setApprovedDrivers(approved);

      // Load pending drivers
      const pendingSnap = await get(ref(db, 'drivers/pending'));
      const pending: PendingDriver[] = [];
      if (pendingSnap.exists()) {
        const data = pendingSnap.val();
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
          });
        });
      }
      pending.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      setPendingDrivers(pending);

      // Load dashboard users (users/{uid}). Purely-dashboard employees
      // (not linked to a driver record) appear only here; drivers who have
      // been promoted via inviteEmployee appear in BOTH lists and are linked
      // via driverHash on the user side + dashboardUid on the driver side.
      const usersSnap = await get(ref(db, 'users'));
      const userList: DashboardUser[] = [];
      if (usersSnap.exists()) {
        const data = usersSnap.val();
        Object.entries(data).forEach(([uid, val]: [string, any]) => {
          if (!val?.role || val.role === 'driver') return; // skip plain drivers
          userList.push({
            uid,
            email: val.email || '',
            displayName: val.displayName || val.email || 'Unknown',
            role: val.role as UserRole,
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

  // Company-scoped routes for the approval modal (Model B — no global bleed).
  // Reloads whenever the approval company changes and clears any prior route
  // selection so routes never carry across tenants.
  useEffect(() => {
    setApprovalRoutes([]);
    let cancelled = false;
    (async () => {
      try {
        const routes = approvalCompanyId ? await fetchCompanyRouteNames(approvalCompanyId) : [];
        if (!cancelled) setAvailableRoutes(routes);
      } catch (err) {
        console.error('Failed to load company routes:', err);
        if (!cancelled) setAvailableRoutes([]);
      }
    })();
    return () => { cancelled = true; };
  }, [approvalCompanyId]);

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
  const assignDriverCompany = async () => {
    if (!companyTarget) return;
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
          ? `${companyTarget.displayName} assigned to ${assignCompanyName.trim() || assignCompanyId.trim()}`
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
    // Routes are required ONLY when the company actually has routes configured.
    // Operator-only companies (no maintained wells/routes) approve with [].
    if (availableRoutes.length > 0 && approvalRoutes.length === 0) {
      setMessage('Please assign at least one route');
      return;
    }

    try {
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
  const rejectDriver = async (driver: PendingDriver) => {
    try {
      await update(ref(db, `drivers/pending/${driver.key}`), {
        status: 'rejected',
      });
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

  // ── Archive / Unarchive (lifecycle) ──────────────────────────────────
  // Archive hides the driver from the normal list AND disables login
  // (active:false). It NEVER touches tickets/invoices/JSA/shifts/payroll.
  const driverPath = (driver: ApprovedDriver) =>
    driver._legacy && driver._legacyDeviceId
      ? `drivers/approved/${driver.key}/${driver._legacyDeviceId}`
      : `drivers/approved/${driver.key}`;

  const archiveDriver = async (driver: ApprovedDriver) => {
    try {
      await update(ref(db, driverPath(driver)), { archived: true, active: false });
      setMessage(`Archived ${driver.displayName} — login disabled, hidden from list. History preserved.`);
      await loadDrivers();
    } catch (err) {
      console.error('Failed to archive driver:', err);
      setMessage('Failed to archive driver');
    }
  };

  // Unarchive restores visibility ONLY. It does not reactivate login — the
  // admin must explicitly Activate to restore access.
  const unarchiveDriver = async (driver: ApprovedDriver) => {
    try {
      await update(ref(db, driverPath(driver)), { archived: false });
      setMessage(`Unarchived ${driver.displayName} — still inactive. Use Activate to restore login.`);
      await loadDrivers();
    } catch (err) {
      console.error('Failed to unarchive driver:', err);
      setMessage('Failed to unarchive driver');
    }
  };

  // ── Guarded hard delete ──────────────────────────────────────────────
  // Opens a modal that probes for linked history. Delete is blocked when any
  // history/dashboard link exists unless the admin uses the explicit test-data
  // override. Deletes ONLY the drivers/approved record — never history.
  const openDeleteModal = async (driver: ApprovedDriver) => {
    setDeleteTarget(driver);
    setDeleteProbe(null);
    setDeleteConfirmName('');
    setDeleteReason('');
    setDeleteOverride(false);
    setDeleteProbing(true);
    try {
      setDeleteProbe(await probeDriverHistory(driver.key, driver.dashboardUid));
    } catch (err) {
      console.error('History probe failed:', err);
      // Fail safe: unknown history → treat as present so we never delete blind.
      setDeleteProbe({
        hasAny: true, tickets: false, invoices: false, canonicalJobs: false,
        jsa: false, dispatches: false, shifts: false, dashboardLink: false, probeError: true,
      });
    } finally {
      setDeleteProbing(false);
    }
  };

  const closeDeleteModal = () => {
    setDeleteTarget(null);
    setDeleteProbe(null);
    setDeleteConfirmName('');
    setDeleteReason('');
    setDeleteOverride(false);
    setDeleting(false);
  };

  const confirmHardDelete = async () => {
    if (!deleteTarget || !deleteProbe) return;
    const hasHistory = deleteProbe.hasAny;
    // History present requires the explicit override; name must always match;
    // a written reason (>= 5 chars) is mandatory for the audit record.
    if (hasHistory && !deleteOverride) return;
    if (deleteConfirmName.trim() !== deleteTarget.displayName) return;
    if (deleteReason.trim().length < 5) return;
    setDeleting(true);
    try {
      // Audit FIRST — never delete a driver without a recorded reason. If the
      // audit write fails, the catch aborts and nothing is removed.
      // Stored in RTDB (open .read/.write) because the new collection has no
      // Firestore rule and Firestore denies unmatched collections by default.
      await push(ref(db, 'driver_delete_audit'), {
        driverHash: deleteTarget.key,
        driverName: deleteTarget.displayName,
        legalName: deleteTarget.legalName || null,
        companyId: deleteTarget.companyId || null,
        companyName: deleteTarget.companyName || null,
        deleteType: isWbAdmin ? 'platform' : 'customer',
        reason: deleteReason.trim(),
        deletedByUid: user?.uid || null,
        deletedByEmail: user?.email || null,
        deletedByName: user?.displayName || null,
        deletedAt: serverTimestamp(),
        historyProbe: {
          hasAny: deleteProbe.hasAny,
          tickets: deleteProbe.tickets,
          invoices: deleteProbe.invoices,
          canonicalJobs: deleteProbe.canonicalJobs,
          jsa: deleteProbe.jsa,
          dispatches: deleteProbe.dispatches,
          shifts: deleteProbe.shifts,
          dashboardLink: deleteProbe.dashboardLink,
          probeError: deleteProbe.probeError,
        },
        overrideUsed: hasHistory ? deleteOverride : false,
        typedNameConfirmed: true,
        explanationAcknowledged: true,
      });

      await remove(ref(db, `drivers/approved/${deleteTarget.key}`));
      setMessage(`Hard-deleted driver record: ${deleteTarget.displayName}. Reason logged; history untouched.`);
      closeDeleteModal();
      await loadDrivers();
    } catch (err) {
      console.error('Failed to delete driver:', err);
      setMessage('Delete aborted — could not write the audit record or remove the login record. Nothing deleted.');
      setDeleting(false);
    }
  };

  // Company-scoped filtering: if scopeCompanyId is set, only show drivers for that company
  const companyDrivers = scopeCompanyId
    ? approvedDrivers.filter(d => d.companyId === scopeCompanyId)
    : approvedDrivers;

  const archivedCount = companyDrivers.filter(d => d.archived).length;
  const filteredDrivers = (search.trim()
    ? companyDrivers.filter(d =>
        d.displayName.toLowerCase().includes(search.toLowerCase())
      )
    : companyDrivers
  ).filter(d => showArchived || !d.archived);

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
  const renderDriverRow = (driver: ApprovedDriver) => {
    // Lifecycle gating: deactivated/archived drivers are read-only except for
    // their permitted lifecycle actions. Settings edits are hidden until the
    // driver is active again.
    const isArchived = driver.archived === true;
    const isInactive = driver.active === false;
    const isLifecycleLocked = isArchived || isInactive;
    // Delete authority: WB platform admin may delete any driver (Platform Delete);
    // a company-scoped admin may delete only drivers in their own company
    // (Delete Employee). The list is already company-scoped, but we guard the
    // companyId match explicitly so no admin can act outside their authority.
    const canDelete = isWbAdmin || (!!scopeCompanyId && driver.companyId === scopeCompanyId);
    return (
    <div key={driver.key} className={`rounded ${driver.archived ? 'bg-gray-800 opacity-60' : 'bg-gray-700'}`}>
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
          {driver.archived && (
            <span className="px-1.5 py-0.5 bg-amber-800 text-amber-200 text-xs rounded font-medium">Archived</span>
          )}
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
            {/* Activate/Deactivate — hidden when archived (must Unarchive first) */}
            {!isArchived && (
              <button
                onClick={() => toggleDriverActive(driver)}
                className={`px-3 py-1 text-sm rounded ${driver.active ? 'bg-gray-600 hover:bg-gray-500 text-gray-300' : 'bg-green-600 hover:bg-green-500 text-white'}`}
              >
                {driver.active ? 'Deactivate' : 'Activate'}
              </button>
            )}
            {driver.archived ? (
              <button
                onClick={() => unarchiveDriver(driver)}
                className="px-3 py-1 text-sm rounded bg-amber-600 hover:bg-amber-500 text-white"
                title="Restore to the normal list. Does NOT reactivate login — use Activate for that."
              >
                Unarchive
              </button>
            ) : (
              <button
                onClick={() => archiveDriver(driver)}
                className="px-3 py-1 text-sm rounded bg-gray-600 hover:bg-gray-500 text-gray-300"
                title="Disable login and hide from the normal list. History is preserved."
              >
                Archive
              </button>
            )}
            {!isLifecycleLocked && (
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
            )}
            {isWbAdmin && !isLifecycleLocked && (
              <button
                onClick={() => toggleDriverAdmin(driver)}
                className={`px-3 py-1 text-sm rounded ${driver.isAdmin ? 'bg-gray-600 hover:bg-gray-500 text-gray-300' : 'bg-slate-600 hover:bg-slate-500 text-gray-200'}`}
                title="Toggles the driver-app (WB T / WB S) admin menu access — separate from dashboard role"
              >
                {driver.isAdmin ? 'App Admin \u2713' : 'App Admin'}
              </button>
            )}
            {!isLifecycleLocked && (
            <button
              onClick={() => { setAssignTarget(driver); setShowAssignModal(true); }}
              className="px-3 py-1 text-sm rounded bg-yellow-600 hover:bg-yellow-500 text-white"
            >
              + Assign Operator
            </button>
            )}
            {!isLifecycleLocked && (
            <button
              onClick={async () => {
                setRouteTarget(driver);
                setSelectedRoutes(driver.assignedRoutes || []);
                setShowRoutesModal(true);
                try {
                  setAvailableRoutes(driver.companyId ? await fetchCompanyRouteNames(driver.companyId) : []);
                } catch (err) {
                  console.error('Failed to load company routes:', err);
                  setAvailableRoutes([]);
                }
              }}
              className="px-3 py-1 text-sm rounded bg-blue-600 hover:bg-blue-500 text-white"
            >
              {(driver.assignedRoutes?.length || 0) > 0 ? 'Edit Routes' : '+ Assign Routes'}
            </button>
            )}
            {!isLifecycleLocked && (
            <button
              onClick={() => { setPackageTarget(driver); setSelectedPackageId(driver.defaultPackageId || ''); setShowPackageModal(true); }}
              className={`px-3 py-1 text-sm rounded ${driver.defaultPackageId ? 'bg-indigo-600 hover:bg-indigo-500 text-white' : 'bg-gray-600 hover:bg-gray-500 text-gray-300'}`}
            >
              {driver.defaultPackageId ? `Pkg: ${availablePackages.find(p => p.id === driver.defaultPackageId)?.name || driver.defaultPackageId}` : 'Default Package'}
            </button>
            )}
            {isWbAdmin && !isLifecycleLocked && (
              <button
                onClick={() => { setCompanyTarget(driver); setAssignCompanyId(driver.companyId || ''); setAssignCompanyName(driver.companyName || ''); setShowCompanyModal(true); }}
                className="px-3 py-1 text-sm rounded bg-teal-600 hover:bg-teal-500 text-white"
              >
                {driver.companyId ? 'Change Customer' : 'Assign Customer'}
              </button>
            )}
            {isWbAdmin && driver._legacy && !isLifecycleLocked && (
              <button
                onClick={() => migrateDriver(driver)}
                className="px-3 py-1 text-sm rounded bg-orange-600 hover:bg-orange-500 text-white"
                title="Convert from legacy device-based format to new flat format"
              >
                Migrate
              </button>
            )}
            {canDelete && (
              <button
                onClick={() => setExplainTarget(driver)}
                title={isWbAdmin
                  ? "Platform cleanup only — not normal customer employee management. Use Archive to remove a customer's employee."
                  : "Delete this employee's login record. History is preserved."}
                className="px-3 py-1 text-sm rounded bg-red-700 hover:bg-red-600 text-red-200 ml-auto"
              >
                {isWbAdmin ? 'Platform Delete' : 'Delete Employee'}
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
                    {!isLifecycleLocked && (
                      <button onClick={() => removeCustomer(driver, c.companyId)} className="text-red-400 hover:text-red-300 text-xs">Remove</button>
                    )}
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
  };

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
            {archivedCount > 0 && (
              <button
                onClick={() => setShowArchived(s => !s)}
                className={`px-3 py-1.5 text-sm rounded ${showArchived ? 'bg-amber-600 hover:bg-amber-500 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}
                title="Archived drivers are hidden from the normal list"
              >
                {showArchived ? 'Hide Archived' : `Show Archived (${archivedCount})`}
              </button>
            )}
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

      {/* ── Assign Company Modal (WB admin only) ── */}
      {showCompanyModal && companyTarget && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-white font-medium mb-1">Assign to Customer</h3>
            <p className="text-gray-400 text-sm mb-4">
              Assign <span className="text-white">{companyTarget.displayName}</span> to a customer
            </p>

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
                  }}
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

            <div className="flex gap-2 mt-4">
              <button
                onClick={assignDriverCompany}
                className="flex-1 px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white rounded"
              >
                {assignCompanyId.trim() ? 'Assign' : 'Remove from Customer'}
              </button>
              <button
                onClick={() => {
                  setShowCompanyModal(false);
                  setCompanyTarget(null);
                  setAssignCompanyId('');
                  setAssignCompanyName('');
                }}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
              >
                Cancel
              </button>
            </div>
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
        const routesRequired = availableRoutes.length > 0;
        const canApprove = !!approvalCompanyId && approvalCustomers.length > 0 && (!routesRequired || approvalRoutes.length > 0);

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
                  Route {routesRequired
                    ? <span className="text-red-400">*</span>
                    : <span className="normal-case text-gray-500">(optional)</span>}
                  {approvalRoutes.length > 0 && (
                    <span className="text-blue-400 ml-2 normal-case">{approvalRoutes.length} selected</span>
                  )}
                </label>
                {availableRoutes.length === 0 ? (
                  <p className="text-gray-500 text-sm">No routes configured for this company.</p>
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
              <p className="text-yellow-400 text-sm">No routes configured for this company.</p>
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

      {/* ── Pre-Delete Explanation / Acknowledgement ── */}
      {explainTarget && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
            <h3 className="text-white font-medium text-lg mb-3">
              {isWbAdmin ? 'Platform Delete' : 'Delete Employee'}
            </h3>
            <div className="text-gray-300 text-sm space-y-3 mb-5">
              {isWbAdmin && (
                <>
                  <p>This action exists to protect the WellBuilt platform, remove abusive/test accounts, or perform administrative cleanup.</p>
                  <p>It is <strong>not</strong> intended for normal employee management.</p>
                  <div>
                    <p>Customer employee management should normally use:</p>
                    <ul className="list-disc list-inside text-gray-400 mt-1">
                      <li>Deactivate</li>
                      <li>Archive</li>
                      <li>Customer Delete</li>
                    </ul>
                  </div>
                </>
              )}
              <p>Deleting an employee removes their login record.</p>
              <div>
                <p>It does <strong>NOT</strong> delete:</p>
                <ul className="list-disc list-inside text-gray-400 mt-1">
                  <li>Tickets</li>
                  <li>Invoices</li>
                  <li>Payroll history</li>
                  <li>JSA records</li>
                  <li>Dispatches</li>
                  <li>Audit history</li>
                </ul>
              </div>
              <p>Historical records may remain and may become orphaned.</p>
              <p className="text-amber-300">Proceed only if you understand these consequences.</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setExplainTarget(null)}
                className="flex-1 px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
              >
                Cancel
              </button>
              <button
                onClick={() => { const d = explainTarget; setExplainTarget(null); openDeleteModal(d); }}
                className="flex-1 px-4 py-2 bg-red-700 hover:bg-red-600 text-white rounded font-medium"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Guarded Hard-Delete Modal ── */}
      {deleteTarget && (() => {
        const hasHistory = !!deleteProbe?.hasAny;
        const nameOk = deleteConfirmName.trim() === deleteTarget.displayName;
        const reasonOk = deleteReason.trim().length >= 5;
        const canDelete = !!deleteProbe && !deleteProbing && nameOk && reasonOk && (!hasHistory || deleteOverride);
        const found: string[] = [];
        if (deleteProbe) {
          if (deleteProbe.tickets) found.push('tickets');
          if (deleteProbe.invoices) found.push('invoices');
          if (deleteProbe.jsa) found.push('JSA');
          if (deleteProbe.shifts) found.push('shifts');
          if (deleteProbe.dispatches) found.push('dispatches');
          if (deleteProbe.canonicalJobs) found.push('canonical jobs');
          if (deleteProbe.dashboardLink) found.push('dashboard account');
        }
        return (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-gray-800 rounded-lg p-6 max-w-lg w-full mx-4">
              <h3 className="text-white font-medium text-lg mb-1">
                {isWbAdmin ? 'Platform Delete' : 'Delete Employee'} — {deleteTarget.displayName}
              </h3>
              {isWbAdmin && (
                <div className="bg-amber-900/30 border border-amber-700 rounded p-3 mb-3">
                  <p className="text-amber-200 text-sm font-medium">⚠️ Platform cleanup only.</p>
                  <p className="text-amber-200/90 text-sm">This is not normal customer employee management.</p>
                  <p className="text-amber-200/90 text-sm">To remove a customer&apos;s employee from daily use, use Archive.</p>
                </div>
              )}
              <p className="text-gray-400 text-xs mb-3">
                Company: {deleteTarget.companyName || deleteTarget.companyId || 'Unknown'}
              </p>
              <p className="text-gray-400 text-sm mb-4">
                Hard delete removes only the driver login record. Tickets, invoices, JSA, shifts,
                dispatches, and payroll are never touched.
              </p>

              {deleteProbing ? (
                <p className="text-gray-300 text-sm py-4">Checking for linked history…</p>
              ) : deleteProbe?.probeError ? (
                <div className="bg-red-900/40 border border-red-700 rounded p-3 mb-4">
                  <p className="text-red-300 text-sm">
                    Couldn&apos;t verify history (probe error). For safety this driver is treated as
                    having history — use Archive instead, or retry.
                  </p>
                </div>
              ) : hasHistory ? (
                <div className="bg-red-900/30 border border-red-700 rounded p-3 mb-4">
                  <p className="text-red-300 text-sm font-medium mb-1">This driver has linked history:</p>
                  <p className="text-red-200 text-sm">{found.join(', ')}</p>
                  <p className="text-gray-400 text-xs mt-2">
                    Recommended: <span className="text-amber-300">Archive</span> instead — it disables
                    login and hides the driver while preserving every record.
                  </p>
                </div>
              ) : (
                <div className="bg-green-900/20 border border-green-800 rounded p-3 mb-4">
                  <p className="text-green-300 text-sm">No linked history found — safe to delete this test/clean driver.</p>
                </div>
              )}

              {!deleteProbing && hasHistory && (
                <label className="flex items-start gap-2 mb-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={deleteOverride}
                    onChange={e => setDeleteOverride(e.target.checked)}
                    className="w-4 h-4 mt-0.5"
                  />
                  <span className="text-red-300 text-sm">
                    ⚠️ Override: permanently delete this driver record <strong>even though it has history</strong>.
                    Only do this for explicit test-data cleanup. The history documents are orphaned, not deleted.
                  </span>
                </label>
              )}

              <div className="mb-4">
                <label className="text-gray-400 text-xs uppercase tracking-wider block mb-1">
                  Reason for deletion <span className="text-red-400">*</span>
                </label>
                <textarea
                  value={deleteReason}
                  onChange={e => setDeleteReason(e.target.value)}
                  rows={2}
                  placeholder="e.g. Employee terminated by customer · Duplicate test driver · Security concern · Customer requested cleanup · Platform abuse investigation"
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm placeholder-gray-500"
                />
                {deleteReason.trim().length > 0 && deleteReason.trim().length < 5 && (
                  <p className="text-amber-400 text-xs mt-1">Reason must be at least 5 characters.</p>
                )}
              </div>

              <div className="mb-4">
                <label className="text-gray-400 text-xs uppercase tracking-wider block mb-1">
                  Type <span className="text-white font-mono">{deleteTarget.displayName}</span> to confirm{' '}
                  <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={deleteConfirmName}
                  onChange={e => setDeleteConfirmName(e.target.value)}
                  placeholder={deleteTarget.displayName}
                  className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm"
                />
              </div>

              <div className="flex gap-2">
                <button
                  onClick={confirmHardDelete}
                  disabled={!canDelete || deleting}
                  className="flex-1 px-4 py-2 bg-red-700 hover:bg-red-600 text-white rounded font-medium disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {deleting ? 'Deleting…' : 'Hard Delete'}
                </button>
                <button
                  onClick={closeDeleteModal}
                  className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
