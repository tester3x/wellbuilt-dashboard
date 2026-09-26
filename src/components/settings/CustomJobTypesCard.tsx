'use client';

// Custom Job Types Card — Upgraded v2 Editor.
// Every custom job type must define what it IS operationally, not just what it is called:
// 1. Job Type Name (display label)
// 2. Family (Production Water -> 'pw', Service Work -> 'service-work')
// 3. Pay Basis (Per BBL -> 'per_bbl', Hourly -> 'hourly')
// 4. Lifecycle (Pickup -> Drop-off -> 'pickup_dropoff', On Site only -> 'onsite_only')
// 5. Packages (one or more active packages)

import { useState, useEffect, useRef } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { getFirestoreDb } from '@/lib/firebase';
import {
  type CompanyConfig,
  type CustomJobType,
  type CustomJobTypeFamily,
  type CustomJobTypePayBasis,
  type CustomJobTypeLifecycle,
  CUSTOM_JOB_TYPE_FAMILIES,
  CUSTOM_JOB_TYPE_PAY_BASES,
  CUSTOM_JOB_TYPE_LIFECYCLES,
  updateCompanyFields,
} from '@/lib/companySettings';
import {
  validateNewCustomJobType,
  normalizeCustomJobType,
  defaultCapabilitiesForLifecycle,
  slugifyCustomJobType,
} from '@/lib/customJobTypesCore';

interface AvailablePackage {
  id: string;
  name: string;
  icon?: string;
}

const PACKAGE_ICONS: Record<string, string> = {
  'water': '💧',
  'dump-truck': '🚛',
  'truck-delivery': '🚚',
  'oil-barrel': '🛢️',
  'gas-pump': '⛽',
};

interface Props {
  company: CompanyConfig;
  onSave: () => void;
  /** Whether the current user may edit custom job types (manageCompany). */
  canEdit: boolean;
}

export function CustomJobTypesCard({ company, onSave, canEdit }: Props) {
  // Form fields
  const [newLabel, setNewLabel] = useState('');
  const [newFamily, setNewFamily] = useState<CustomJobTypeFamily | ''>('service-work');
  const [newPayBasis, setNewPayBasis] = useState<CustomJobTypePayBasis | ''>('per_bbl');
  const [newLifecycle, setNewLifecycle] = useState<CustomJobTypeLifecycle | ''>('pickup_dropoff');
  const [selectedPackages, setSelectedPackages] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [packages, setPackages] = useState<AvailablePackage[]>([]);
  const [showPackageDropdown, setShowPackageDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Normalize all existing custom job types into full objects
  const customTypes: CustomJobType[] = (company.customJobTypes || [])
    .map(t => normalizeCustomJobType(t))
    .filter((t): t is CustomJobType => t !== null);

  // Load available packages from Firestore
  useEffect(() => {
    const load = async () => {
      try {
        const firestore = getFirestoreDb();
        const snap = await getDocs(collection(firestore, 'job_packages'));
        const list: AvailablePackage[] = [];
        snap.forEach(d => {
          const data = d.data();
          list.push({ id: d.id, name: data.name || d.id, icon: data.icon });
        });
        setPackages(list);
        if (company.activePackages?.length) {
          setSelectedPackages([...company.activePackages]);
        } else if (list.length > 0) {
          setSelectedPackages([list[0].id]);
        }
      } catch (err) {
        console.error('Failed to load packages:', err);
      }
    };
    load();
  }, [company.activePackages]);

  // Close package dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowPackageDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const togglePackage = (pkgId: string) => {
    setSelectedPackages(prev =>
      prev.includes(pkgId)
        ? prev.filter(p => p !== pkgId)
        : [...prev, pkgId]
    );
  };

  // Pre-save validation evaluation
  const validation = validateNewCustomJobType(
    {
      label: newLabel,
      baseJobTypeId: newFamily,
      payBasis: newPayBasis,
      lifecycleShape: newLifecycle,
      packages: selectedPackages,
    },
    customTypes,
  );

  const isFormFilled = Boolean(
    newLabel.trim() && newFamily && newPayBasis && newLifecycle && selectedPackages.length > 0,
  );

  const handleAddType = async () => {
    if (!canEdit || saving) return;
    if (!validation.ok) {
      setError(validation.error);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const updatedList = [...customTypes, validation.value];
      await updateCompanyFields(company.id, {
        customJobTypes: updatedList,
      });
      setNewLabel('');
      onSave();
    } catch (err) {
      console.error('Failed to add custom job type:', err);
      setError('Could not add that job type — write rejected. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveType = async (typeToRemove: CustomJobType) => {
    if (!canEdit || saving) return;
    const identifier = typeToRemove.id || slugifyCustomJobType(typeToRemove.label);
    const confirmDelete = window.confirm(`Remove custom job type "${typeToRemove.label}"?`);
    if (!confirmDelete) return;

    setSaving(true);
    setError(null);
    try {
      const updatedList = customTypes.filter(
        t => (t.id || slugifyCustomJobType(t.label)) !== identifier,
      );
      await updateCompanyFields(company.id, {
        customJobTypes: updatedList,
      });
      onSave();
    } catch (err) {
      console.error('Failed to remove custom job type:', err);
      setError('Could not remove that job type. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdatePayBasis = async (targetType: CustomJobType, basis: CustomJobTypePayBasis) => {
    if (!canEdit || saving) return;
    setSaving(true);
    setError(null);
    try {
      const identifier = targetType.id || slugifyCustomJobType(targetType.label);
      const updatedList = customTypes.map(t => {
        if ((t.id || slugifyCustomJobType(t.label)) === identifier) {
          return { ...t, payBasis: basis };
        }
        return t;
      });
      await updateCompanyFields(company.id, {
        customJobTypes: updatedList,
      });
      onSave();
    } catch (err) {
      console.error('Failed to update pay basis:', err);
      setError('Could not update pay basis. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const getPackageIcon = (pkgId: string) => {
    const pkg = packages.find(p => p.id === pkgId);
    if (pkg?.icon && PACKAGE_ICONS[pkg.icon]) return PACKAGE_ICONS[pkg.icon];
    return '📦';
  };

  const getPackageName = (pkgId: string) => {
    return packages.find(p => p.id === pkgId)?.name || pkgId;
  };

  const activePackages = packages.filter(p =>
    !company.activePackages?.length || company.activePackages.includes(p.id)
  );

  const selectedLabel = selectedPackages.length === 0
    ? 'Select packages...'
    : selectedPackages.length === activePackages.length
      ? 'All packages'
      : selectedPackages.map(id => getPackageName(id)).join(', ');

  return (
    <div className={`bg-gray-800 rounded-lg border border-gray-700 overflow-visible relative ${showPackageDropdown ? 'z-20' : ''}`}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
        <div>
          <h3 className="text-white font-semibold text-sm">Custom Job Types</h3>
          <p className="text-gray-400 text-xs mt-0.5">
            Add company-specific job types with explicit governed family, pay basis, and lifecycle shape.
          </p>
        </div>
        <span className="text-gray-400 text-xs font-mono bg-gray-700 px-2 py-0.5 rounded">
          {customTypes.length} configured
        </span>
      </div>

      {!canEdit && (
        <div className="px-4 pt-3 text-gray-400 text-xs">
          View-only — you do not have permission to change custom job types (requires manageCompany).
        </div>
      )}

      {error && (
        <div className="mx-4 mt-3 px-3 py-2 bg-red-900/40 border border-red-700 rounded text-red-300 text-xs" role="alert">
          {error}
        </div>
      )}

      {/* Editor Form */}
      {canEdit && (
        <div className="p-4 border-b border-gray-700 bg-gray-850/50 space-y-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-300">
            Create New Custom Job Type
          </div>

          {/* Row 1: Name and Packages */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-300 mb-1">
                Job Type Name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={newLabel}
                onChange={e => {
                  setNewLabel(e.target.value);
                  setError(null);
                }}
                placeholder="e.g. Ground Water, Vac Pipe Support"
                className="w-full px-3 py-2 bg-gray-700 text-white rounded text-sm placeholder-gray-500 border border-gray-600 focus:outline-none focus:border-blue-500"
                maxLength={50}
                disabled={saving}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-300 mb-1">
                Assigned Packages <span className="text-red-400">*</span>
              </label>
              <div className="relative" ref={dropdownRef}>
                <button
                  type="button"
                  onClick={() => setShowPackageDropdown(!showPackageDropdown)}
                  disabled={saving}
                  className="w-full px-3 py-2 bg-gray-700 text-gray-200 text-sm rounded border border-gray-600 hover:border-gray-500 transition-colors flex items-center justify-between"
                >
                  <span className="truncate">{selectedLabel}</span>
                  <span className="text-gray-400 text-xs ml-2">▾</span>
                </button>
                {showPackageDropdown && (
                  <div className="absolute top-full left-0 mt-1 bg-gray-750 border border-gray-600 rounded-lg shadow-2xl z-50 min-w-full py-1">
                    {activePackages.map(pkg => (
                      <label
                        key={pkg.id}
                        className="flex items-center gap-2 px-3 py-2 hover:bg-gray-700 cursor-pointer text-sm text-gray-200"
                      >
                        <input
                          type="checkbox"
                          checked={selectedPackages.includes(pkg.id)}
                          onChange={() => togglePackage(pkg.id)}
                          className="rounded border-gray-500 text-blue-500 focus:ring-blue-500 bg-gray-800"
                        />
                        <span>{getPackageIcon(pkg.id)}</span>
                        <span>{pkg.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Row 2: Family, Pay Basis, Lifecycle */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Family */}
            <div>
              <label className="block text-xs font-medium text-gray-300 mb-1">
                Governed Family <span className="text-red-400">*</span>
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                {CUSTOM_JOB_TYPE_FAMILIES.map(fam => (
                  <button
                    key={fam.value}
                    type="button"
                    onClick={() => {
                      setNewFamily(fam.value);
                      setError(null);
                    }}
                    className={`px-2 py-2 text-xs font-medium rounded border transition-colors text-center ${
                      newFamily === fam.value
                        ? 'bg-blue-600 border-blue-500 text-white shadow'
                        : 'bg-gray-700 border-gray-600 text-gray-300 hover:bg-gray-650'
                    }`}
                  >
                    {fam.label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 mt-1">
                Internal mapping: {newFamily === 'pw' ? 'baseJobTypeId = pw' : 'baseJobTypeId = service-work'}
              </p>
            </div>

            {/* Pay Basis */}
            <div>
              <label className="block text-xs font-medium text-gray-300 mb-1">
                Pay Basis <span className="text-red-400">*</span>
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                {CUSTOM_JOB_TYPE_PAY_BASES.map(pb => (
                  <button
                    key={pb.value}
                    type="button"
                    onClick={() => {
                      setNewPayBasis(pb.value);
                      setError(null);
                    }}
                    className={`px-2 py-2 text-xs font-medium rounded border transition-colors text-center ${
                      newPayBasis === pb.value
                        ? 'bg-emerald-600 border-emerald-500 text-white shadow'
                        : 'bg-gray-700 border-gray-600 text-gray-300 hover:bg-gray-650'
                    }`}
                  >
                    {pb.label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 mt-1">
                Independent from family: {newPayBasis === 'per_bbl' ? 'Billed/paid per barrel' : 'Billed/paid hourly'}
              </p>
            </div>

            {/* Lifecycle */}
            <div>
              <label className="block text-xs font-medium text-gray-300 mb-1">
                Lifecycle <span className="text-red-400">*</span>
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                {CUSTOM_JOB_TYPE_LIFECYCLES.map(lc => (
                  <button
                    key={lc.value}
                    type="button"
                    onClick={() => {
                      setNewLifecycle(lc.value);
                      setError(null);
                    }}
                    className={`px-2 py-2 text-xs font-medium rounded border transition-colors text-center ${
                      newLifecycle === lc.value
                        ? 'bg-purple-600 border-purple-500 text-white shadow'
                        : 'bg-gray-700 border-gray-600 text-gray-300 hover:bg-gray-650'
                    }`}
                  >
                    {lc.label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 mt-1">
                {newLifecycle === 'pickup_dropoff' ? 'Capabilities: lifecycle, pickup' : 'Capabilities: lifecycle only'}
              </p>
            </div>
          </div>

          {/* Form Actions */}
          <div className="flex items-center justify-between pt-1">
            <div className="text-xs text-gray-400">
              {!isFormFilled ? (
                <span className="text-amber-400">All 5 fields required before adding.</span>
              ) : !validation.ok ? (
                <span className="text-red-400">{validation.error}</span>
              ) : (
                <span className="text-emerald-400">
                  Ready to add &ldquo;{newLabel.trim()}&rdquo; ({validation.value.id})
                </span>
              )}
            </div>

            <button
              type="button"
              onClick={handleAddType}
              disabled={saving || !validation.ok}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded transition-colors"
            >
              {saving ? 'Adding...' : 'Add Custom Job Type'}
            </button>
          </div>
        </div>
      )}

      {/* Configured Custom Job Types List */}
      <div className="p-4 space-y-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          Configured Types ({customTypes.length})
        </div>

        {customTypes.length === 0 ? (
          <div className="text-gray-400 text-xs text-center py-6 border border-dashed border-gray-700 rounded-lg">
            No custom job types configured yet. Add types specific to your company&apos;s operations above.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2.5">
            {customTypes.map(t => {
              const needsPayBasis = !t.payBasis;
              const identifier = t.id || slugifyCustomJobType(t.label);

              return (
                <div
                  key={identifier}
                  className="bg-gray-750 border border-gray-700 rounded-lg p-3 flex flex-col md:flex-row md:items-center justify-between gap-3 hover:border-gray-600 transition-colors"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-medium text-sm">{t.label}</span>
                      <span className="text-[11px] font-mono text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded">
                        id: {identifier}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      {/* Family badge */}
                      <span className="px-2 py-0.5 rounded bg-blue-900/40 text-blue-300 border border-blue-800/60">
                        {t.baseJobTypeId === 'pw' ? 'Production Water' : 'Service Work'}
                      </span>

                      {/* Pay basis badge */}
                      {t.payBasis === 'per_bbl' && (
                        <span className="px-2 py-0.5 rounded bg-emerald-900/40 text-emerald-300 border border-emerald-800/60">
                          Per BBL
                        </span>
                      )}
                      {t.payBasis === 'hourly' && (
                        <span className="px-2 py-0.5 rounded bg-indigo-900/40 text-indigo-300 border border-indigo-800/60">
                          Hourly
                        </span>
                      )}
                      {needsPayBasis && (
                        <span className="px-2 py-0.5 rounded bg-amber-900/50 text-amber-300 border border-amber-600 flex items-center gap-1 font-medium">
                          ⚠️ Needs Pay Basis
                        </span>
                      )}

                      {/* Lifecycle badge */}
                      <span className="px-2 py-0.5 rounded bg-purple-900/40 text-purple-300 border border-purple-800/60">
                        {t.lifecycleShape === 'onsite_only' ? 'On Site only' : 'Pickup -> Drop-off'}
                      </span>

                      {/* Packages */}
                      {t.packages.length > 0 && (
                        <span className="px-2 py-0.5 rounded bg-gray-700 text-gray-300 flex items-center gap-1">
                          <span>{t.packages.map(p => getPackageIcon(p)).join('')}</span>
                          <span>{t.packages.map(p => getPackageName(p)).join(', ')}</span>
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions / Legacy payBasis selection */}
                  <div className="flex items-center gap-2 self-end md:self-center">
                    {needsPayBasis && canEdit && (
                      <div className="flex items-center gap-1 bg-amber-950/60 border border-amber-700/80 px-2 py-1 rounded text-xs">
                        <span className="text-amber-300 text-[11px] whitespace-nowrap">Set basis:</span>
                        <button
                          type="button"
                          onClick={() => handleUpdatePayBasis(t, 'per_bbl')}
                          disabled={saving}
                          className="px-2 py-0.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded text-[11px] transition-colors"
                        >
                          Per BBL
                        </button>
                        <button
                          type="button"
                          onClick={() => handleUpdatePayBasis(t, 'hourly')}
                          disabled={saving}
                          className="px-2 py-0.5 bg-indigo-700 hover:bg-indigo-600 text-white rounded text-[11px] transition-colors"
                        >
                          Hourly
                        </button>
                      </div>
                    )}

                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => handleRemoveType(t)}
                        disabled={saving}
                        className="px-2.5 py-1 text-gray-400 hover:text-red-400 hover:bg-red-900/20 rounded text-xs transition-colors"
                        title="Remove custom job type"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
