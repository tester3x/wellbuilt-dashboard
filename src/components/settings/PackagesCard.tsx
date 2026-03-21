'use client';

import { useState, useEffect } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { getFirestoreDb } from '@/lib/firebase';
import { type CompanyConfig, updateCompanyFields } from '@/lib/companySettings';

// ── Job Package type (mirrors Firestore job_packages/{packageId}) ──────────

interface JobPackage {
  id: string;
  name: string;
  icon?: string;            // emoji or short string
  industry: string;         // e.g. "Oil & Gas", "Construction", "Agriculture"
  unit?: string;            // e.g. "BBL", "ton", "hour"
  jobTypes?: any[];          // objects {id, label, icon, color} or strings
  capabilities?: any;        // Record<string, boolean> or string[]
  description?: string;
}

interface Props {
  company: CompanyConfig;
  onSave: () => void;
}

// ── Package icon map (Firestore stores identifiers, we display emojis) ──────

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
};

// ── Capability badge colors ─────────────────────────────────────────────────

const CAPABILITY_COLORS: Record<string, string> = {
  'Level Tracking': 'bg-blue-900/50 text-blue-300 border-blue-700/50',
  'Weight Tickets': 'bg-green-900/50 text-green-300 border-green-700/50',
  'FSC': 'bg-yellow-900/50 text-yellow-300 border-yellow-700/50',
  'GPS Routing': 'bg-purple-900/50 text-purple-300 border-purple-700/50',
  'Dispatch': 'bg-orange-900/50 text-orange-300 border-orange-700/50',
};

function getCapabilityColor(cap: string): string {
  return CAPABILITY_COLORS[cap] || 'bg-gray-700/50 text-gray-300 border-gray-600/50';
}

// ── Industry badge colors ───────────────────────────────────────────────────

const INDUSTRY_COLORS: Record<string, string> = {
  'Oil & Gas': 'text-amber-400',
  'Construction': 'text-orange-400',
  'Agriculture': 'text-green-400',
  'Mining': 'text-stone-400',
  'General': 'text-gray-400',
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

  // Load all available job packages from Firestore
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

  const togglePackage = async (packageId: string) => {
    const isActive = activePackages.includes(packageId);

    // Prevent turning off the last active package
    if (isActive && activePackages.length <= 1) return;

    setSaving(packageId);
    try {
      const updated = isActive
        ? activePackages.filter(id => id !== packageId)
        : [...activePackages, packageId];
      await updateCompanyFields(company.id, { activePackages: updated });
      onSave();
    } catch (err) {
      console.error('Failed to toggle package:', err);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-cyan-500/30 bg-cyan-900/20">
        <div className="flex items-center justify-between">
          <h3 className="text-cyan-400 font-medium text-sm">Job Packages</h3>
          {activePackages.length > 0 && (
            <span className="text-xs text-gray-400">
              {activePackages.length} active
            </span>
          )}
        </div>
      </div>

      <div className="p-4">
        {loading ? (
          <div className="text-gray-500 text-sm text-center py-4">Loading packages...</div>
        ) : error ? (
          <div className="text-red-400 text-sm text-center py-4">{error}</div>
        ) : packages.length === 0 ? (
          <div className="text-gray-500 text-sm text-center py-4">
            No job packages configured yet. Add packages to the <code className="text-gray-400">job_packages</code> collection in Firestore.
          </div>
        ) : (
          <div className="space-y-2">
            {packages.map(pkg => {
              const isActive = activePackages.includes(pkg.id);
              const isSaving = saving === pkg.id;
              const isLastActive = isActive && activePackages.length <= 1;

              return (
                <div
                  key={pkg.id}
                  className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${
                    isActive
                      ? 'border-cyan-700/50 bg-cyan-900/10'
                      : 'border-gray-700 bg-gray-800/50'
                  }`}
                >
                  {/* Icon */}
                  <div className="text-2xl flex-shrink-0 mt-0.5">
                    {PACKAGE_ICONS[pkg.icon || ''] || pkg.icon || '📦'}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-white text-sm font-medium">{pkg.name}</span>
                      <span className={`text-[10px] uppercase tracking-wider ${getIndustryColor(pkg.industry)}`}>
                        {pkg.industry}
                      </span>
                      {pkg.unit && (
                        <span className="text-[10px] text-gray-500 uppercase">
                          {pkg.unit}
                        </span>
                      )}
                    </div>

                    {pkg.description && (
                      <p className="text-gray-500 text-xs mb-1.5">{pkg.description}</p>
                    )}

                    {/* Job types */}
                    {pkg.jobTypes && pkg.jobTypes.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-1.5">
                        {pkg.jobTypes.map((jt: any, i: number) => {
                          const label = typeof jt === 'string' ? jt : jt.label || jt.id || String(jt);
                          const key = typeof jt === 'string' ? jt : jt.id || `jt-${i}`;
                          return (
                            <span
                              key={key}
                              className="px-1.5 py-0.5 text-[10px] bg-gray-700/60 text-gray-300 rounded"
                            >
                              {label}
                            </span>
                          );
                        })}
                      </div>
                    )}

                    {/* Capabilities */}
                    {pkg.capabilities && (() => {
                      const caps = Array.isArray(pkg.capabilities)
                        ? pkg.capabilities as string[]
                        : Object.entries(pkg.capabilities).filter(([, v]) => v).map(([k]) => k);
                      return caps.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {caps.map((cap: string) => (
                            <span
                              key={cap}
                              className={`px-1.5 py-0.5 text-[10px] rounded border ${getCapabilityColor(cap)}`}
                            >
                              {cap}
                            </span>
                          ))}
                        </div>
                      ) : null;
                    })()}
                  </div>

                  {/* Toggle */}
                  <div className="flex flex-col items-end flex-shrink-0 mt-0.5">
                    <button
                      onClick={() => togglePackage(pkg.id)}
                      disabled={isSaving || isLastActive}
                      title={isLastActive ? 'At least one package must remain active' : ''}
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        isActive ? 'bg-cyan-500' : 'bg-gray-600'
                      } ${isSaving || isLastActive ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                          isActive ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                    {isLastActive && (
                      <span className="text-[9px] text-amber-400/70 mt-1 whitespace-nowrap">Min 1 required</span>
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
