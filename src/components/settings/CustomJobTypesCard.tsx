'use client';

// Custom Job Types Card — Companies add their own job type labels.
// Each custom type can be assigned to one or more packages via checkbox dropdown.
// These merge into the package jobTypes lists so dispatch + driver see the same options.
// Usage is tracked in Firestore job_type_usage collection.
// Popular custom types get promoted to official package types (R&D pipeline).

import { useState, useEffect, useRef } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { getFirestoreDb } from '@/lib/firebase';
import { type CompanyConfig, type CustomJobType, updateCompanyFields } from '@/lib/companySettings';

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
}

export function CustomJobTypesCard({ company, onSave }: Props) {
  const [newType, setNewType] = useState('');
  const [saving, setSaving] = useState(false);
  const [packages, setPackages] = useState<AvailablePackage[]>([]);
  const [selectedPackages, setSelectedPackages] = useState<string[]>([]);
  const [showPackageDropdown, setShowPackageDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const customTypes: CustomJobType[] = (company.customJobTypes || []).map(t =>
    typeof t === 'string' ? { label: t, packages: [] } : t
  );

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
        // Default: select all company's active packages
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

  // Close dropdown on outside click
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

  const addType = async () => {
    const label = newType.trim();
    if (!label || selectedPackages.length === 0) return;
    // Don't allow duplicates (case-insensitive)
    if (customTypes.some(t => t.label.toLowerCase() === label.toLowerCase())) {
      setNewType('');
      return;
    }
    setSaving(true);
    try {
      const newEntry: CustomJobType = { label, packages: [...selectedPackages] };
      await updateCompanyFields(company.id, {
        customJobTypes: [...customTypes, newEntry],
      });
      setNewType('');
      onSave();
    } catch (err) {
      console.error('Failed to add custom job type:', err);
    } finally {
      setSaving(false);
    }
  };

  const removeType = async (label: string) => {
    setSaving(true);
    try {
      await updateCompanyFields(company.id, {
        customJobTypes: customTypes.filter(t => t.label !== label),
      });
      onSave();
    } catch (err) {
      console.error('Failed to remove custom job type:', err);
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

  // Active packages only (filter to what company actually has)
  const activePackages = packages.filter(p =>
    !company.activePackages?.length || company.activePackages.includes(p.id)
  );

  const selectedLabel = selectedPackages.length === 0
    ? 'Select packages...'
    : selectedPackages.length === activePackages.length
      ? 'All packages'
      : selectedPackages.map(id => getPackageName(id)).join(', ');

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
        <div>
          <h3 className="text-white font-semibold text-sm">Custom Job Types</h3>
          <p className="text-gray-500 text-xs mt-0.5">
            Add company-specific job types. Drivers see these in their job type list.
          </p>
        </div>
        <span className="text-gray-600 text-xs">{customTypes.length} custom</span>
      </div>

      <div className="p-4 space-y-3">
        {/* Package selector + input row */}
        <div className="flex gap-2">
          {/* Package dropdown */}
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setShowPackageDropdown(!showPackageDropdown)}
              className="px-3 py-2 bg-gray-700 text-gray-300 text-sm rounded border border-gray-600 hover:border-gray-500 transition-colors whitespace-nowrap flex items-center gap-1.5 min-w-[160px]"
            >
              <span className="truncate flex-1 text-left">{selectedLabel}</span>
              <span className="text-gray-500 text-xs">▾</span>
            </button>
            {showPackageDropdown && (
              <div className="absolute top-full left-0 mt-1 bg-gray-700 border border-gray-600 rounded-lg shadow-xl z-50 min-w-[200px]">
                {activePackages.map(pkg => (
                  <label
                    key={pkg.id}
                    className="flex items-center gap-2 px-3 py-2 hover:bg-gray-600 cursor-pointer text-sm text-gray-200"
                  >
                    <input
                      type="checkbox"
                      checked={selectedPackages.includes(pkg.id)}
                      onChange={() => togglePackage(pkg.id)}
                      className="rounded border-gray-500 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 bg-gray-800"
                    />
                    <span>{getPackageIcon(pkg.id)}</span>
                    <span>{pkg.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Type name input */}
          <input
            type="text"
            value={newType}
            onChange={e => setNewType(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addType()}
            placeholder="e.g. Slickline, Chain Up..."
            className="flex-1 px-3 py-2 bg-gray-700 text-white rounded text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            maxLength={50}
            disabled={saving}
          />
          <button
            onClick={addType}
            disabled={saving || !newType.trim() || selectedPackages.length === 0}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 disabled:text-gray-400 text-white text-sm font-medium rounded transition-colors"
          >
            Add
          </button>
        </div>

        {selectedPackages.length === 0 && (
          <p className="text-amber-500 text-xs">Select at least one package above</p>
        )}

        {/* Existing custom types */}
        {customTypes.length === 0 ? (
          <div className="text-gray-500 text-xs text-center py-4">
            No custom job types yet. Add types specific to your operation.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {customTypes.map(t => (
              <span
                key={t.label}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 text-gray-200 text-sm rounded-full group"
                title={t.packages.length > 0 ? `In: ${t.packages.map(p => getPackageName(p)).join(', ')}` : 'No package assigned'}
              >
                {t.packages.length > 0 && (
                  <span className="text-xs opacity-60">
                    {t.packages.map(p => getPackageIcon(p)).join('')}
                  </span>
                )}
                {t.label}
                <button
                  onClick={() => removeType(t.label)}
                  disabled={saving}
                  className="text-gray-500 hover:text-red-400 transition-colors text-xs font-bold ml-0.5"
                  title="Remove"
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
