'use client';

// Settings card — Roles & Permissions.
// Per-company editor for two concepts:
//   1. roleLabels    — display strings ("Dispatcher" -> "Coordinator")
//   2. roleCapabilities — which capabilities each role has at this company
// Only users with the `manageRolesAndCapabilities` capability (default:
// role 'it') can open this card — caller gates via Settings page.
//
// Unset = inherit the built-in DEFAULT_ROLE_LABELS / DEFAULT_ROLE_CAPABILITIES
// from @/lib/auth. Saving writes Partial overrides so unset roles continue
// to inherit from defaults if we change the defaults later.

import { useMemo, useState } from 'react';
import {
  type Capability,
  type UserRole,
  DEFAULT_ROLE_CAPABILITIES,
  DEFAULT_ROLE_LABELS,
} from '@/lib/auth';
import { type CompanyConfig, updateCompanyFields } from '@/lib/companySettings';

interface Props {
  company: CompanyConfig;
  onSave: () => void;
  /** If false, all controls are read-only (for non-'it' admins who view but can't edit). */
  canEdit: boolean;
}

// Capability groups — for readable checkbox layout. Each group renders as
// its own section within a role's panel.
const CAPABILITY_GROUPS: { title: string; caps: { cap: Capability; label: string; hint?: string }[] }[] = [
  {
    title: 'Dashboard tabs (view-only)',
    caps: [
      { cap: 'viewHome', label: 'Home' },
      { cap: 'viewMobile', label: 'WB Mobile (wells, performance)' },
      { cap: 'viewTickets', label: 'WB Tickets' },
      { cap: 'viewDispatch', label: 'Dispatch board' },
      { cap: 'viewBilling', label: 'WB Billing' },
      { cap: 'viewPayroll', label: 'WB Payroll' },
      { cap: 'viewDriverLogs', label: 'Driver Logs' },
      { cap: 'viewSettings', label: 'Settings' },
      { cap: 'viewAdmin', label: 'Admin panel' },
      { cap: 'viewChat', label: 'Chat sidebar + /chat page' },
    ],
  },
  {
    title: 'Actions',
    caps: [
      { cap: 'createDispatch', label: 'Create / edit dispatches' },
      { cap: 'manageDrivers', label: 'Approve / reject / delete driver registrations' },
      { cap: 'manageCompany', label: 'Edit company config (rates, features)' },
      { cap: 'editBilling', label: 'Generate bills, set fuel prices' },
      { cap: 'approvePayroll', label: 'Approve payroll runs' },
      { cap: 'manageWells', label: 'Add / edit / remove wells' },
      { cap: 'manageRoutes', label: 'Approve / edit GPS routes' },
      { cap: 'manageEquipment', label: 'Equipment documents, truck/trailer admin' },
      { cap: 'sendChat', label: 'Send chat messages' },
    ],
  },
  {
    title: 'Meta (owner-only surfaces)',
    caps: [
      {
        cap: 'manageRolesAndCapabilities',
        label: 'Edit this page',
        hint: 'Whether this role can rename roles and edit capabilities.',
      },
      { cap: 'viewAllCompanies', label: 'WB-admin cross-company view', hint: 'For WB platform admins only.' },
      { cap: 'viewTruthDebug', label: 'Truth Debug + RAG Exports', hint: 'Platform-level debug tools.' },
    ],
  },
];

const ROLES_IN_DISPLAY_ORDER: UserRole[] = ['it', 'admin', 'manager', 'dispatch', 'payroll', 'driver', 'viewer'];

export function RolesCard({ company, onSave, canEdit }: Props) {
  const [saving, setSaving] = useState(false);
  const [expandedRole, setExpandedRole] = useState<UserRole | null>(null);

  // Draft state: when the user edits anything, it lives here until save.
  const [draftLabels, setDraftLabels] = useState<Partial<Record<UserRole, string>>>(
    () => ({ ...(company.roleLabels || {}) }),
  );
  const [draftCaps, setDraftCaps] = useState<Partial<Record<UserRole, Capability[]>>>(
    () => ({ ...(company.roleCapabilities || {}) }),
  );

  const isDirty = useMemo(() => {
    return (
      JSON.stringify(draftLabels) !== JSON.stringify(company.roleLabels || {}) ||
      JSON.stringify(draftCaps) !== JSON.stringify(company.roleCapabilities || {})
    );
  }, [draftLabels, draftCaps, company.roleLabels, company.roleCapabilities]);

  const effectiveLabel = (role: UserRole): string => draftLabels[role] || DEFAULT_ROLE_LABELS[role];
  const effectiveCaps = (role: UserRole): Capability[] =>
    draftCaps[role] ?? DEFAULT_ROLE_CAPABILITIES[role];

  const updateLabel = (role: UserRole, value: string) => {
    setDraftLabels(prev => {
      const next = { ...prev };
      const trimmed = value.trim();
      // If value matches the built-in default, remove the override so we
      // inherit future default changes. Store only when customized.
      if (!trimmed || trimmed === DEFAULT_ROLE_LABELS[role]) {
        delete next[role];
      } else {
        next[role] = trimmed;
      }
      return next;
    });
  };

  const toggleCap = (role: UserRole, cap: Capability, on: boolean) => {
    setDraftCaps(prev => {
      const next = { ...prev };
      const current = [...effectiveCaps(role)];
      const filtered = on
        ? Array.from(new Set([...current, cap]))
        : current.filter(c => c !== cap);
      // Same idea as labels: if the set is identical to the default, unset.
      const defaultSet = DEFAULT_ROLE_CAPABILITIES[role];
      const equalsDefault =
        filtered.length === defaultSet.length &&
        filtered.every(c => defaultSet.includes(c));
      if (equalsDefault) {
        delete next[role];
      } else {
        next[role] = filtered;
      }
      return next;
    });
  };

  const resetRole = (role: UserRole) => {
    setDraftLabels(prev => {
      const next = { ...prev };
      delete next[role];
      return next;
    });
    setDraftCaps(prev => {
      const next = { ...prev };
      delete next[role];
      return next;
    });
  };

  const handleSave = async () => {
    if (!canEdit || saving) return;
    setSaving(true);
    try {
      await updateCompanyFields(company.id, {
        roleLabels: draftLabels,
        roleCapabilities: draftCaps,
      });
      onSave();
    } catch (err) {
      console.error('[RolesCard] save failed:', err);
      alert('Save failed. Check console for details.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-purple-500/30 bg-purple-900/20 flex items-center justify-between">
        <div>
          <h3 className="text-purple-300 font-medium text-sm">Roles &amp; Permissions</h3>
          <p className="text-gray-500 text-xs mt-0.5">
            Rename roles for display and pick which surfaces + actions each role can access.
            Unset values inherit defaults.
          </p>
        </div>
        {canEdit && (
          <button
            onClick={handleSave}
            disabled={!isDirty || saving}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              isDirty && !saving
                ? 'bg-purple-600 text-white hover:bg-purple-500'
                : 'bg-gray-700 text-gray-500 cursor-not-allowed'
            }`}
          >
            {saving ? 'Saving…' : isDirty ? 'Save changes' : 'Saved'}
          </button>
        )}
      </div>

      <div className="divide-y divide-gray-700/60">
        {ROLES_IN_DISPLAY_ORDER.map(role => {
          const expanded = expandedRole === role;
          const caps = effectiveCaps(role);
          const customized =
            !!draftLabels[role] ||
            (draftCaps[role] !== undefined &&
              !(draftCaps[role]!.length === DEFAULT_ROLE_CAPABILITIES[role].length &&
                draftCaps[role]!.every(c => DEFAULT_ROLE_CAPABILITIES[role].includes(c))));

          return (
            <div key={role} className="bg-gray-800">
              <button
                type="button"
                onClick={() => setExpandedRole(expanded ? null : role)}
                className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-750 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-[11px] font-mono text-gray-500 w-16 flex-shrink-0">
                    {role}
                  </span>
                  <span className="text-white text-sm font-medium truncate">
                    {effectiveLabel(role)}
                  </span>
                  {customized && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/30 text-purple-200 border border-purple-500/40">
                      customized
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-gray-500 text-xs">{caps.length} capability{caps.length === 1 ? '' : 'ies'}</span>
                  <span className={`text-gray-400 text-sm transition-transform ${expanded ? 'rotate-90' : ''}`}>▸</span>
                </div>
              </button>

              {expanded && (
                <div className="px-4 pb-4 pt-1 bg-gray-850/50 space-y-3">
                  {/* Label input */}
                  <div>
                    <label className="block text-[11px] text-gray-500 uppercase tracking-wider mb-1">
                      Display label
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={draftLabels[role] ?? ''}
                        onChange={e => updateLabel(role, e.target.value)}
                        placeholder={DEFAULT_ROLE_LABELS[role]}
                        disabled={!canEdit}
                        className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-purple-500 disabled:opacity-60"
                      />
                      {canEdit && (draftLabels[role] || draftCaps[role]) && (
                        <button
                          onClick={() => resetRole(role)}
                          className="text-xs px-2 py-1 rounded bg-gray-700 text-gray-300 hover:bg-gray-600"
                          title="Reset this role's label and capabilities to defaults"
                        >
                          Reset to defaults
                        </button>
                      )}
                    </div>
                    <p className="text-[10px] text-gray-500 mt-1">
                      Leave blank to inherit the default ({DEFAULT_ROLE_LABELS[role]}).
                    </p>
                  </div>

                  {/* Capability checkboxes by group */}
                  {CAPABILITY_GROUPS.map(group => (
                    <div key={group.title}>
                      <p className="text-[11px] text-gray-500 uppercase tracking-wider mb-1">
                        {group.title}
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                        {group.caps.map(({ cap, label, hint }) => {
                          const checked = caps.includes(cap);
                          const idSuffix = `${role}-${cap}`;
                          return (
                            <label
                              key={cap}
                              htmlFor={`rc-${idSuffix}`}
                              className={`flex items-start gap-2 text-xs py-1 ${canEdit ? 'cursor-pointer' : 'cursor-default opacity-80'}`}
                              title={hint || undefined}
                            >
                              <input
                                id={`rc-${idSuffix}`}
                                type="checkbox"
                                checked={checked}
                                onChange={e => toggleCap(role, cap, e.target.checked)}
                                disabled={!canEdit}
                                className="mt-0.5 accent-purple-500"
                              />
                              <span className={`${checked ? 'text-gray-200' : 'text-gray-500'} leading-tight`}>
                                {label}
                                {hint && (
                                  <span className="text-[10px] text-gray-600 block">{hint}</span>
                                )}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
