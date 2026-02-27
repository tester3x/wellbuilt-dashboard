'use client';

import { useEffect, useState } from 'react';
import { getFirebaseDatabase, getFirestoreDb } from '@/lib/firebase';
import { ref, get, set, remove, update } from 'firebase/database';
import { collection, getDocs } from 'firebase/firestore';

interface AssignedCustomer {
  name: string;
  companyId: string;
}

interface ApprovedDriver {
  key: string;           // passcode hash (Firebase key)
  displayName: string;
  name?: string;         // legacy field
  isAdmin?: boolean;
  isViewer?: boolean;
  active?: boolean;
  companyId?: string;    // which trucking company this driver belongs to
  companyName?: string;  // display name of the company
  assignedCustomers?: AssignedCustomer[];
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
  passcodeHash: string;
  timestamp?: number;
  companyName?: string;    // company name driver entered during registration
  requestedAt?: string;    // ISO timestamp from registration
}

export function DriversTab({ scopeCompanyId, isWbAdmin = false }: DriversTabProps) {
  const [approvedDrivers, setApprovedDrivers] = useState<ApprovedDriver[]>([]);
  const [pendingDrivers, setPendingDrivers] = useState<PendingDriver[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');

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

  // Expanded driver (shows details + assigned customers)
  const [expandedDriver, setExpandedDriver] = useState<string | null>(null);

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
              name: val.name,
              isAdmin: val.isAdmin || false,
              isViewer: val.isViewer || false,
              active: val.active !== false,
              companyId: val.companyId || undefined,
              companyName: val.companyName || undefined,
              assignedCustomers: Array.isArray(val.assignedCustomers) ? val.assignedCustomers : [],
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
            passcodeHash: val.passcodeHash || '',
            timestamp: val.timestamp || (val.requestedAt ? new Date(val.requestedAt).getTime() : undefined),
            companyName: val.companyName || undefined,
            requestedAt: val.requestedAt || undefined,
          });
        });
      }
      pending.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      setPendingDrivers(pending);
    } catch (err) {
      console.error('Failed to load drivers:', err);
      setMessage('Failed to load drivers');
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

  // ── Assign driver to a company (WB admin only) ──
  const assignDriverCompany = async () => {
    if (!companyTarget) return;
    try {
      const updates: Record<string, any> = {
        companyId: assignCompanyId.trim().toLowerCase() || null,
        companyName: assignCompanyName.trim() || null,
      };
      await update(ref(db, `drivers/approved/${companyTarget.key}`), updates);
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
        name: driver.displayName,
        active: true,
        isAdmin: false,
        isViewer: false,
        approvedAt: Date.now(),
      };
      if (scopeCompanyId) {
        // Company admin approving — assign to their company
        approvedData.companyId = scopeCompanyId;
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

  // ── Toggle admin role ──
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

  // ── Assign a customer to a driver ──
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
      setMessage(`Removed customer assignment from ${driver.displayName}`);
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

  // For pending drivers, company admins see all pending (they'll approve into their company)
  const visiblePending = pendingDrivers;

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
                    onClick={() => approveDriver(driver)}
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
            {scopeCompanyId ? 'Your Drivers' : 'All Drivers'} ({companyDrivers.length})
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

        {filteredDrivers.length === 0 ? (
          <div className="text-gray-500 text-center py-6">
            {search ? 'No drivers match search' : 'No approved drivers yet'}
          </div>
        ) : (
          <div className="space-y-2">
            {filteredDrivers.map(driver => (
              <div key={driver.key} className="bg-gray-700 rounded overflow-hidden">
                {/* Driver row */}
                <div
                  className="flex items-center justify-between p-3 cursor-pointer hover:bg-gray-600"
                  onClick={() => setExpandedDriver(expandedDriver === driver.key ? null : driver.key)}
                >
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full ${driver.active ? 'bg-green-400' : 'bg-gray-500'}`} />
                    <span className="text-white font-medium">{driver.displayName}</span>
                    {isWbAdmin && driver._legacy && (
                      <span className="px-1.5 py-0.5 bg-orange-700 text-orange-200 text-xs rounded font-medium">Legacy</span>
                    )}
                    {driver.isAdmin && (
                      <span className="px-1.5 py-0.5 bg-purple-600 text-purple-200 text-xs rounded font-medium">Admin</span>
                    )}
                    {driver.isViewer && !driver.isAdmin && (
                      <span className="px-1.5 py-0.5 bg-blue-600 text-blue-200 text-xs rounded font-medium">Viewer</span>
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
                  </div>
                  <span className="text-gray-400 text-sm">
                    {expandedDriver === driver.key ? '▲' : '▼'}
                  </span>
                </div>

                {/* Expanded details */}
                {expandedDriver === driver.key && (
                  <div className="border-t border-gray-600 p-3 space-y-3">
                    {/* Controls */}
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => toggleDriverActive(driver)}
                        className={`px-3 py-1 text-sm rounded ${
                          driver.active
                            ? 'bg-gray-600 hover:bg-gray-500 text-gray-300'
                            : 'bg-green-600 hover:bg-green-500 text-white'
                        }`}
                      >
                        {driver.active ? 'Deactivate' : 'Activate'}
                      </button>
                      {isWbAdmin && (
                        <button
                          onClick={() => toggleDriverAdmin(driver)}
                          className={`px-3 py-1 text-sm rounded ${
                            driver.isAdmin
                              ? 'bg-gray-600 hover:bg-gray-500 text-gray-300'
                              : 'bg-purple-600 hover:bg-purple-500 text-white'
                          }`}
                        >
                          {driver.isAdmin ? 'Remove Admin' : 'Make Admin'}
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setAssignTarget(driver);
                          setShowAssignModal(true);
                        }}
                        className="px-3 py-1 text-sm rounded bg-yellow-600 hover:bg-yellow-500 text-white"
                      >
                        + Assign Customer
                      </button>
                      {isWbAdmin && (
                        <button
                          onClick={() => {
                            setCompanyTarget(driver);
                            setAssignCompanyId(driver.companyId || '');
                            setAssignCompanyName(driver.companyName || '');
                            setShowCompanyModal(true);
                          }}
                          className="px-3 py-1 text-sm rounded bg-teal-600 hover:bg-teal-500 text-white"
                        >
                          {driver.companyId ? 'Change Company' : 'Assign Company'}
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

                    {/* Assigned Customers */}
                    <div>
                      <h4 className="text-gray-400 text-xs font-medium uppercase tracking-wider mb-2">
                        Assigned Customers
                      </h4>
                      {(driver.assignedCustomers?.length || 0) === 0 ? (
                        <p className="text-gray-500 text-sm">No customers assigned</p>
                      ) : (
                        <div className="space-y-1">
                          {driver.assignedCustomers!.map(c => (
                            <div key={c.companyId} className="flex items-center justify-between bg-gray-800 rounded p-2">
                              <div>
                                <span className="text-yellow-300 text-sm font-medium">{c.name}</span>
                                <span className="text-gray-500 text-xs ml-2">({c.companyId})</span>
                              </div>
                              <button
                                onClick={() => removeCustomer(driver, c.companyId)}
                                className="text-red-400 hover:text-red-300 text-xs"
                              >
                                Remove
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Hash (for debugging) — WB admin only */}
                    {isWbAdmin && (
                      <div className="text-gray-500 text-xs font-mono">
                        Hash: {driver.key.slice(0, 12)}...
                        {driver._legacy && (
                          <span className="text-orange-400 ml-2">
                            (legacy format — device: {driver._legacyDeviceId?.slice(0, 8)}...)
                          </span>
                        )}
                        {driver.companyId && (
                          <span className="text-teal-400 ml-2">
                            Company: {driver.companyId}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Assign Company Modal (WB admin only) ── */}
      {showCompanyModal && companyTarget && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-white font-medium mb-1">Assign to Company</h3>
            <p className="text-gray-400 text-sm mb-4">
              Assign <span className="text-white">{companyTarget.displayName}</span> to a trucking company
            </p>

            <div className="space-y-3">
              <div>
                <label className="text-gray-400 text-sm block mb-1">Company</label>
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
                  <option value="">— No Company (Remove) —</option>
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
                {assignCompanyId.trim() ? 'Assign' : 'Remove from Company'}
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

      {/* ── Assign Customer Modal ── */}
      {showAssignModal && assignTarget && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-white font-medium mb-1">Assign Customer</h3>
            <p className="text-gray-400 text-sm mb-4">
              Assign a customer to <span className="text-white">{assignTarget.displayName}</span>
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
                      This driver is not assigned to a company yet. Assign a company first, then add customers.
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
    </div>
  );
}
