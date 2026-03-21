'use client';

import { useState, useEffect } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { getFirestoreDb } from '@/lib/firebase';
import { type CompanyConfig, updateCompanyFields } from '@/lib/companySettings';

interface JobPackage {
  id: string;
  name: string;
  icon?: string;
  industry: string;
  unit?: string;
  jobTypes?: any[];
  capabilities?: any;
  description?: string;
}

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

const PACKAGE_ICONS: Record<string, string> = {
  'water': '💧',
  'water-plus': '💧',
  'water-alert': '💧',
  'water-pump': '💧',
  'dump-truck': '🚛',
  'truck-delivery': '🚚',
  'wrench': '🔧',
  'oil': '🛢️',
  'barrel': '🛢️',
  'fire': '🔥',
  'vacuum': '🫗',
  'bolt': '⚡',
};

const INDUSTRY_COLORS: Record<string, string> = {
  'Oil & Gas': 'text-amber-400',
  'Construction': 'text-orange-400',
  'Agriculture': 'text-green-400',
  'Mining': 'text-stone-400',
  'General': 'text-gray-400',
  'Oilfield Services': 'text-blue-400',
};

function getIndustryColor(industry: string): string {
  return INDUSTRY_COLORS[industry] || 'text-gray-400';
}

export function PackagesCard({ company, onSave }: Props) {
  const [packages, setPackages] = useState<JobPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activePackages = company.activePackages || [];

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const firestore = getFirestoreDb();
        const snap = await getDocs(collection(firestore, 'job_packages'));
        const list: JobPackage[] = [];
        snap.forEach(d => {
          list.push({ id: d.id, ...d.data() } as JobPackage);
        });
        list.sort((a, b) => a.name.localeCompare(b.name));
        setPackages(list);
      } catch (err) {
        console.error('Failed to load job packages:', err);
        setError('Failed to load packages');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const installPackage = async (packageId: string) => {
    if (activePackages.includes(packageId)) return;
    setSaving(packageId);
    try {
      const updated = [...activePackages, packageId];
      await updateCompanyFields(company.id, { activePackages: updated });
      onSave();
    } catch (err) {
      console.error('Failed to install package:', err);
    } finally {
      setSaving(null);
    }
  };

  const removePackage = async (packageId: string) => {
    if (activePackages.length <= 1) return;
    setSaving(packageId);
    try {
      const updated = activePackages.filter(id => id !== packageId);
      await updateCompanyFields(company.id, { activePackages: updated });
      onSave();
    } catch (err) {
      console.error('Failed to remove package:', err);
    } finally {
      setSaving(null);
    }
  };

  const installedPackages = packages.filter(p => activePackages.includes(p.id));
  const availablePackages = packages.filter(p => !activePackages.includes(p.id));

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-cyan-500/30 bg-cyan-900/20">
        <div className="flex items-center justify-between">
          <h3 className="text-cyan-400 font-medium text-sm">Job Packages</h3>
          <a
            href="https://wellbuiltsuite.com/#packages"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-gray-500 hover:text-cyan-400 transition-colors"
          >
            Browse all packages →
          </a>
        </div>
      </div>

      <div className="p-4">
        {loading ? (
          <div className="text-gray-500 text-sm text-center py-4">Loading packages...</div>
        ) : error ? (
          <div className="text-red-400 text-sm text-center py-4">{error}</div>
        ) : (
          <>
            {/* ── Add Package Dropdown ── */}
            {availablePackages.length > 0 && (
              <div className="mb-4">
                <label className="text-gray-400 text-xs block mb-1">Add a package</label>
                <select
                  value=""
                  onChange={e => {
                    if (e.target.value) installPackage(e.target.value);
                  }}
                  disabled={saving !== null}
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-sm text-white focus:outline-none focus:border-cyan-500"
                >
                  <option value="">Select a package to install...</option>
                  {availablePackages.map(pkg => (
                    <option key={pkg.id} value={pkg.id}>
                      {PACKAGE_ICONS[pkg.icon || ''] || '📦'} {pkg.name} — {pkg.industry} ({pkg.unit || 'unit'})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* ── Installed Packages ── */}
            {installedPackages.length === 0 ? (
              <div className="text-gray-500 text-sm text-center py-4">
                No packages installed. Select one above to get started.
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-gray-400 text-xs">{installedPackages.length} installed</span>
                </div>
                {installedPackages.map(pkg => {
                  const isSaving = saving === pkg.id;
                  const isLastActive = activePackages.length <= 1;

                  return (
                    <div
                      key={pkg.id}
                      className="flex items-start gap-3 p-3 rounded-lg border border-cyan-700/50 bg-cyan-900/10"
                    >
                      <div className="text-2xl flex-shrink-0 mt-0.5">
                        {PACKAGE_ICONS[pkg.icon || ''] || pkg.icon || '📦'}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-white text-sm font-medium">{pkg.name}</span>
                          <span className={`text-[10px] uppercase tracking-wider ${getIndustryColor(pkg.industry)}`}>
                            {pkg.industry}
                          </span>
                          {pkg.unit && (
                            <span className="text-[10px] text-gray-500 uppercase">{pkg.unit}</span>
                          )}
                        </div>

                        {pkg.description && (
                          <p className="text-gray-500 text-xs mb-1.5">{pkg.description}</p>
                        )}

                        {pkg.jobTypes && pkg.jobTypes.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {pkg.jobTypes.map((jt: any, i: number) => {
                              const label = typeof jt === 'string' ? jt : jt.label || jt.id || String(jt);
                              const key = typeof jt === 'string' ? jt : jt.id || `jt-${i}`;
                              return (
                                <span key={key} className="px-1.5 py-0.5 text-[10px] bg-gray-700/60 text-gray-300 rounded">
                                  {label}
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <button
                        onClick={() => removePackage(pkg.id)}
                        disabled={isSaving || isLastActive}
                        title={isLastActive ? 'At least one package must remain active' : 'Remove package'}
                        className={`text-xs px-2 py-1 rounded transition-colors flex-shrink-0 ${
                          isLastActive
                            ? 'text-gray-600 cursor-not-allowed'
                            : 'text-red-400/70 hover:text-red-400 hover:bg-red-900/20'
                        }`}
                      >
                        {isSaving ? '...' : 'Remove'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
