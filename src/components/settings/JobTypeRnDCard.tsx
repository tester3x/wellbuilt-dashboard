'use client';

// Job Type R&D Card — WB admin only.
// Shows usage analytics for all job types across all companies.
// Flags custom types for promotion and unused built-ins for pruning.
// Self-tuning system: the platform learns what the industry uses.

import { useState, useEffect } from 'react';
import { collection, getDocs, doc, updateDoc, arrayUnion, deleteDoc } from 'firebase/firestore';
import { getFirestoreDb } from '@/lib/firebase';
import {
  loadAllUsage,
  getPromotionCandidates,
  getPruneCandidates,
  seedTestData,
  PROMOTE_THRESHOLD_COMPANIES,
  PROMOTE_THRESHOLD_DISPATCHES,
  PRUNE_THRESHOLD_DAYS,
  type JobTypeUsageEntry,
} from '@/lib/jobTypeUsage';

export function JobTypeRnDCard() {
  const [entries, setEntries] = useState<JobTypeUsageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await loadAllUsage();
      setEntries(data);
    } catch (err) {
      console.error('Failed to load R&D data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const promoteCandidates = getPromotionCandidates(entries);
  const pruneCandidates = getPruneCandidates(entries);
  const customEntries = entries.filter(e => e.isCustom);
  const builtinEntries = entries.filter(e => !e.isCustom);

  const handleSeed = async () => {
    setSeeding(true);
    try {
      await seedTestData();
      await load();
    } finally {
      setSeeding(false);
    }
  };

  const handlePromote = async (entry: JobTypeUsageEntry) => {
    setPromoting(entry.id);
    try {
      // Add to water-hauling package's jobTypes (simplified — real version would let admin pick package)
      const firestore = getFirestoreDb();
      const pkgRef = doc(firestore, 'job_packages', 'water-hauling');
      const pkgSnap = await getDocs(collection(firestore, 'job_packages'));
      let targetPkg: any = null;
      pkgSnap.forEach(d => { if (d.id === 'water-hauling') targetPkg = d.data(); });

      if (targetPkg) {
        const newJobType = {
          id: entry.id,
          label: entry.label,
          icon: 'star',
          color: '#f59e0b',
        };
        const existingTypes = targetPkg.jobTypes || [];
        if (!existingTypes.some((jt: any) => jt.id === entry.id)) {
          await updateDoc(pkgRef, {
            jobTypes: [...existingTypes, newJobType],
          });
        }
      }

      // Mark usage entry as promoted
      const usageRef = doc(firestore, 'job_type_usage', entry.id);
      await updateDoc(usageRef, { isCustom: false, source: 'water-hauling', promotedAt: new Date().toISOString() });

      await load();
    } catch (err) {
      console.error('Failed to promote:', err);
    } finally {
      setPromoting(null);
    }
  };

  const handleDismiss = async (entry: JobTypeUsageEntry) => {
    setDismissing(entry.id);
    try {
      const firestore = getFirestoreDb();
      await deleteDoc(doc(firestore, 'job_type_usage', entry.id));
      await load();
    } catch (err) {
      console.error('Failed to dismiss:', err);
    } finally {
      setDismissing(null);
    }
  };

  const handlePrune = async (entry: JobTypeUsageEntry) => {
    setDismissing(entry.id);
    try {
      // Remove from package's jobTypes
      const firestore = getFirestoreDb();
      if (entry.source && entry.source !== 'custom') {
        const pkgRef = doc(firestore, 'job_packages', entry.source);
        const pkgSnap = await getDocs(collection(firestore, 'job_packages'));
        let targetPkg: any = null;
        pkgSnap.forEach(d => { if (d.id === entry.source) targetPkg = d.data(); });
        if (targetPkg?.jobTypes) {
          const filtered = targetPkg.jobTypes.filter((jt: any) => jt.id !== entry.id && jt.label !== entry.label);
          await updateDoc(pkgRef, { jobTypes: filtered });
        }
      }
      // Remove usage tracking entry
      await deleteDoc(doc(firestore, 'job_type_usage', entry.id));
      await load();
    } catch (err) {
      console.error('Failed to prune:', err);
    } finally {
      setDismissing(null);
    }
  };

  const timeAgo = (ts: any): string => {
    if (!ts) return 'never';
    const ms = ts.toDate ? ts.toDate().getTime() : ts.seconds ? ts.seconds * 1000 : 0;
    if (ms === 0) return 'never';
    const diff = Date.now() - ms;
    const days = Math.floor(diff / (24 * 60 * 60 * 1000));
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    return `${days}d ago`;
  };

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
        <div>
          <h3 className="text-white font-semibold text-sm flex items-center gap-2">
            Job Type R&D Pipeline
            <span className="px-1.5 py-0.5 bg-purple-600/30 text-purple-300 text-[10px] font-bold rounded">WB ADMIN</span>
          </h3>
          <p className="text-gray-500 text-xs mt-0.5">
            Auto-promote popular custom types. Auto-prune unused built-ins.
            Thresholds: {PROMOTE_THRESHOLD_COMPANIES} companies / {PROMOTE_THRESHOLD_DISPATCHES} dispatches to promote, {PRUNE_THRESHOLD_DAYS}d inactivity to prune.
          </p>
        </div>
        <button
          onClick={handleSeed}
          disabled={seeding}
          className="px-3 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs font-medium rounded transition-colors"
          title="Seed test data for R&D pipeline testing"
        >
          {seeding ? 'Seeding...' : 'Seed Test Data'}
        </button>
      </div>

      {loading ? (
        <div className="text-gray-500 text-center py-8 text-sm">Loading usage data...</div>
      ) : entries.length === 0 ? (
        <div className="text-gray-500 text-center py-8 text-sm">
          No usage data yet. Dispatch some jobs or seed test data.
        </div>
      ) : (
        <div className="p-4 space-y-4">
          {/* Promotion candidates — custom types ready to go official */}
          {promoteCandidates.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <div className="h-px bg-green-600/30 flex-1" />
                <span className="text-green-400 text-[10px] font-bold uppercase tracking-wider">Ready to Promote ({promoteCandidates.length})</span>
                <div className="h-px bg-green-600/30 flex-1" />
              </div>
              <div className="space-y-2">
                {promoteCandidates.map(e => (
                  <div key={e.id} className="flex items-center gap-3 px-3 py-2 bg-green-950/30 border border-green-600/30 rounded-lg">
                    <span className="text-white font-medium text-sm flex-1">{e.label}</span>
                    <span className="text-green-400 text-xs">{e.companyIds.length} companies</span>
                    <span className="text-green-400 text-xs">{e.totalDispatches} dispatches</span>
                    <button
                      onClick={() => handlePromote(e)}
                      disabled={promoting === e.id}
                      className="px-3 py-1 bg-green-600 hover:bg-green-500 text-white text-xs font-medium rounded transition-colors"
                    >
                      {promoting === e.id ? '...' : 'Promote'}
                    </button>
                    <button
                      onClick={() => handleDismiss(e)}
                      disabled={dismissing === e.id}
                      className="px-2 py-1 text-gray-500 hover:text-red-400 text-xs transition-colors"
                    >
                      Dismiss
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Prune candidates — built-ins nobody uses */}
          {pruneCandidates.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <div className="h-px bg-red-600/30 flex-1" />
                <span className="text-red-400 text-[10px] font-bold uppercase tracking-wider">Unused — Prune? ({pruneCandidates.length})</span>
                <div className="h-px bg-red-600/30 flex-1" />
              </div>
              <div className="space-y-2">
                {pruneCandidates.map(e => (
                  <div key={e.id} className="flex items-center gap-3 px-3 py-2 bg-red-950/20 border border-red-600/20 rounded-lg">
                    <span className="text-gray-300 font-medium text-sm flex-1">{e.label}</span>
                    <span className="text-gray-500 text-xs">Last used: {timeAgo(e.lastUsed)}</span>
                    <span className="text-gray-500 text-xs">{e.totalDispatches} dispatches</span>
                    <button
                      onClick={() => handlePrune(e)}
                      disabled={dismissing === e.id}
                      className="px-3 py-1 bg-red-600/50 hover:bg-red-500 text-red-200 text-xs font-medium rounded transition-colors"
                    >
                      {dismissing === e.id ? '...' : 'Prune'}
                    </button>
                    <button
                      onClick={() => handleDismiss(e)}
                      disabled={dismissing === e.id}
                      className="px-2 py-1 text-gray-500 hover:text-gray-300 text-xs transition-colors"
                    >
                      Keep
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* All tracked types — full list */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className="h-px bg-gray-700 flex-1" />
              <span className="text-gray-500 text-[10px] font-bold uppercase tracking-wider">All Tracked Types ({entries.length})</span>
              <div className="h-px bg-gray-700 flex-1" />
            </div>
            <div className="grid grid-cols-1 gap-1">
              {entries.map(e => (
                <div key={e.id} className="flex items-center gap-3 px-3 py-1.5 hover:bg-gray-700/30 rounded text-sm">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${e.isCustom ? 'bg-amber-500' : 'bg-blue-500'}`} />
                  <span className="text-gray-200 flex-1">{e.label}</span>
                  <span className="text-gray-500 text-xs">{e.isCustom ? 'custom' : e.source}</span>
                  <span className="text-gray-400 text-xs w-16 text-right">{e.totalDispatches} uses</span>
                  <span className="text-gray-500 text-xs w-20 text-right">{e.companyIds.length} co{e.companyIds.length !== 1 ? 's' : ''}</span>
                  <span className="text-gray-600 text-xs w-16 text-right">{timeAgo(e.lastUsed)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
