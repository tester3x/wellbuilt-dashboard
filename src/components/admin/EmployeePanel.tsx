'use client';

// ── Unified Employee panel (7/9 employee refactor, dev) ─────────────────────
// One expandable row per PERSON (merged driver + dashboard records — see
// lib/employees.mergeEmployees). Replaces the split "Approved Drivers" vs
// "Dashboard Users" presentation; the legacy lists remain behind a toggle in
// DriversTab until this panel is field-approved. All writes happen in the
// parent via callbacks — this component is presentational + local edit state.
import { useMemo, useState } from 'react';
import { UserRole, getPrimaryRole } from '@/lib/auth';
import { EmployeeRow } from '@/lib/employees';

// Order shown in the role checkbox grid. 'it' is labeled Owner/IT.
const ROLE_CHECKBOXES: { role: UserRole; label: string }[] = [
  { role: 'driver', label: 'Driver' },
  { role: 'dispatch', label: 'Dispatch' },
  { role: 'payroll', label: 'Payroll / Billing' },
  { role: 'manager', label: 'Manager' },
  { role: 'admin', label: 'Admin' },
  { role: 'it', label: 'IT / Owner' },
  { role: 'viewer', label: 'Viewer' },
];

interface EmployeePanelProps<D, U> {
  employees: EmployeeRow<any, any>[];
  isWbAdmin: boolean;
  scopeCompanyId?: string;
  /** Toggle WB-T mobile login (drivers/approved active flag). */
  onToggleMobile: (row: EmployeeRow<any, any>) => void;
  /** Open the existing Invite Employee modal for a driver row. */
  onInvite: (row: EmployeeRow<any, any>) => void;
  /** Persist users/{uid}.roles[] + primary role. */
  onSaveRoles: (uid: string, roles: UserRole[]) => Promise<void>;
  /** Optional existing driver actions (routes / company / package modals). */
  onAssignRoutes?: (row: EmployeeRow<any, any>) => void;
  onAssignCompany?: (row: EmployeeRow<any, any>) => void;
}

export function EmployeePanel<D, U>({
  employees, isWbAdmin, scopeCompanyId,
  onToggleMobile, onInvite, onSaveRoles, onAssignRoutes, onAssignCompany,
}: EmployeePanelProps<D, U>) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Local role edits per row id (uncommitted until Save)
  const [roleEdits, setRoleEdits] = useState<Record<string, UserRole[]>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  // Group by company. Legacy dashboard users may lack companyId but carry a
  // companyName — group them by name so e.g. Liquid Gold's pre-companyId
  // admins land under Liquid Gold instead of "WellBuilt (platform)" (P5).
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; rows: EmployeeRow<any, any>[] }>();
    for (const row of employees) {
      const key = row.companyId || (row.companyName ? `name:${row.companyName}` : 'wb-platform');
      const label = row.companyName || (row.companyId ? row.companyId : 'WellBuilt (platform / unassigned)');
      if (!map.has(key)) map.set(key, { label, rows: [] });
      map.get(key)!.rows.push(row);
    }
    return [...map.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label));
  }, [employees]);

  const canEditRow = (row: EmployeeRow<any, any>) =>
    isWbAdmin || (!!scopeCompanyId && row.companyId === scopeCompanyId);

  const effectiveRoles = (row: EmployeeRow<any, any>): UserRole[] =>
    roleEdits[row.id] ?? row.dashboardRoles;

  const toggleRole = (row: EmployeeRow<any, any>, role: UserRole) => {
    const cur = effectiveRoles(row);
    const next = cur.includes(role) ? cur.filter(r => r !== role) : [...cur, role];
    setRoleEdits(prev => ({ ...prev, [row.id]: next }));
  };

  const saveRoles = async (row: EmployeeRow<any, any>) => {
    if (!row.dashboardUid) return;
    const roles = effectiveRoles(row);
    setSavingId(row.id);
    try {
      await onSaveRoles(row.dashboardUid, roles);
      setRoleEdits(prev => { const n = { ...prev }; delete n[row.id]; return n; });
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <h3 className="text-white font-medium mb-4">
        Employees ({employees.length})
      </h3>

      {groups.map(([key, group]) => (
        <div key={key} className="mb-4">
          <button
            onClick={() => setCollapsed(p => ({ ...p, [key]: !p[key] }))}
            className="w-full flex items-center justify-between text-left px-2 py-1.5 bg-gray-700/60 rounded"
          >
            <span className="text-gray-200 text-sm font-medium">
              {group.label} <span className="text-gray-500">({group.rows.length})</span>
            </span>
            <span className="text-gray-500 text-xs">{collapsed[key] ? '▸' : '▾'}</span>
          </button>

          {!collapsed[key] && group.rows.map(row => {
            const expanded = expandedId === row.id;
            const roles = effectiveRoles(row);
            const dirty = !!roleEdits[row.id];
            const editable = canEditRow(row);
            return (
              <div key={row.id} className="mt-1 bg-gray-700 rounded overflow-hidden">
                {/* Summary row */}
                <button
                  onClick={() => setExpandedId(expanded ? null : row.id)}
                  className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-gray-600/50"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-white text-sm font-medium truncate">{row.name}</span>
                    {row.email && <span className="text-gray-400 text-xs truncate">{row.email}</span>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {row.mobileLoginActive !== undefined && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${row.mobileLoginActive ? 'bg-green-900/60 text-green-300' : 'bg-gray-600 text-gray-300'}`}>
                        WB-T {row.mobileLoginActive ? 'active' : 'inactive'}
                      </span>
                    )}
                    {row.hasDashboardLogin ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/60 text-blue-300">
                        Dashboard: {row.dashboardRoles.join(', ')}
                      </span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-600 text-gray-400">
                        no dashboard login
                      </span>
                    )}
                  </div>
                </button>

                {/* Expanded panel */}
                {expanded && (
                  <div className="px-4 pb-3 pt-1 border-t border-gray-600 space-y-3">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                      <div><span className="text-gray-500 block">Name</span><span className="text-gray-200">{row.name}</span></div>
                      <div><span className="text-gray-500 block">Email</span><span className="text-gray-200">{row.email || '—'}</span></div>
                      <div><span className="text-gray-500 block">Company</span><span className="text-gray-200">{row.companyName || row.companyId || '—'}</span></div>
                      <div><span className="text-gray-500 block">Status</span><span className="text-gray-200">
                        {row.mobileLoginActive === false ? 'Mobile disabled' : row.hasDashboardLogin || row.mobileLoginActive ? 'Active' : '—'}
                      </span></div>
                    </div>

                    {/* Logins */}
                    <div className="flex flex-wrap gap-4 text-sm">
                      <label className={`flex items-center gap-2 ${row.driver && editable ? 'cursor-pointer text-gray-200' : 'text-gray-500'}`}>
                        <input
                          type="checkbox"
                          checked={row.mobileLoginActive === true}
                          disabled={!row.driver || !editable}
                          onChange={() => onToggleMobile(row)}
                        />
                        WB-T Mobile Login
                        {!row.driver && <span className="text-[10px] text-gray-500">(no driver record — registers via WB-T app)</span>}
                      </label>
                      <label className="flex items-center gap-2 text-gray-200">
                        <input type="checkbox" checked={row.hasDashboardLogin} disabled readOnly />
                        Dashboard Login
                        {!row.hasDashboardLogin && row.driver && editable && (
                          <button
                            onClick={() => onInvite(row)}
                            className="ml-1 px-2 py-0.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded"
                          >
                            Invite to Dashboard
                          </button>
                        )}
                      </label>
                    </div>

                    {/* Role checkboxes (dashboard accounts only) */}
                    {row.hasDashboardLogin && (
                      <div>
                        <div className="text-gray-500 text-xs mb-1">Roles (permissions — job titles are set per-company in Settings)</div>
                        <div className="flex flex-wrap gap-3">
                          {ROLE_CHECKBOXES.map(({ role, label }) => (
                            <label key={role} className={`flex items-center gap-1.5 text-sm ${editable ? 'cursor-pointer text-gray-200' : 'text-gray-500'}`}>
                              <input
                                type="checkbox"
                                checked={roles.includes(role)}
                                disabled={!editable}
                                onChange={() => toggleRole(row, role)}
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                        {dirty && (
                          <div className="mt-2 flex items-center gap-2">
                            <button
                              onClick={() => saveRoles(row)}
                              disabled={savingId === row.id || roles.length === 0}
                              className="px-3 py-1 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 text-white text-xs rounded"
                            >
                              {savingId === row.id ? 'Saving…' : `Save roles (primary: ${getPrimaryRole(roles)})`}
                            </button>
                            <button
                              onClick={() => setRoleEdits(prev => { const n = { ...prev }; delete n[row.id]; return n; })}
                              className="px-3 py-1 bg-gray-600 hover:bg-gray-500 text-white text-xs rounded"
                            >
                              Cancel
                            </button>
                            {roles.length === 0 && <span className="text-amber-400 text-xs">at least one role required</span>}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Existing driver actions */}
                    {row.driver && editable && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {onAssignRoutes && (
                          <button onClick={() => onAssignRoutes(row)} className="px-2 py-1 bg-gray-600 hover:bg-gray-500 text-gray-200 text-xs rounded">
                            Routes
                          </button>
                        )}
                        {isWbAdmin && onAssignCompany && (
                          <button onClick={() => onAssignCompany(row)} className="px-2 py-1 bg-gray-600 hover:bg-gray-500 text-gray-200 text-xs rounded">
                            Company
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {employees.length === 0 && (
        <div className="text-gray-500 text-center py-6">No employees yet</div>
      )}
    </div>
  );
}
