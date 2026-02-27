'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import {
  RoutePerformanceStats,
  buildPerformanceSummary,
  getAccuracyColor,
  getAccuracyColorHex,
} from '@/lib/wells';
import Link from 'next/link';
import { AppHeader } from '@/components/AppHeader';
import { SubHeader } from '@/components/SubHeader';

export default function PerformancePage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [routes, setRoutes] = useState<RoutePerformanceStats[]>([]);
  const [overallAvg, setOverallAvg] = useState(0);
  const [totalWells, setTotalWells] = useState(0);
  const [totalPulls, setTotalPulls] = useState(0);
  const [dataLoading, setDataLoading] = useState(true);

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [user, loading, router]);

  useEffect(() => {
    if (!user) return;

    const loadData = async () => {
      try {
        const summary = await buildPerformanceSummary();
        setRoutes(summary.routes);
        setOverallAvg(summary.overallAvg);
        setTotalWells(summary.totalWells);
        setTotalPulls(summary.totalPulls);
      } catch (err) {
        console.error('Error fetching performance data:', err);
      } finally {
        setDataLoading(false);
      }
    };

    loadData();
  }, [user]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white text-xl">Loading...</div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-gray-900">
      <AppHeader />
      <SubHeader backHref="/mobile" title="Performance" subtitle="Prediction accuracy across all wells" />

      <main className="max-w-7xl mx-auto px-4 py-8">
        {/* Overall Summary */}
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-6 mb-8">
          <h2 className="text-lg font-semibold text-white mb-4">Overall Performance</h2>
          <div className="flex flex-wrap items-center gap-8">
            <div>
              <p className="text-gray-400 text-sm">Average Accuracy</p>
              <p className={`text-3xl font-bold ${getAccuracyColor(overallAvg)}`}>
                {overallAvg > 0 ? `${overallAvg.toFixed(1)}%` : '--'}
              </p>
            </div>
            <div>
              <p className="text-gray-400 text-sm">Routes</p>
              <p className="text-3xl font-bold text-blue-400">{routes.length}</p>
            </div>
            <div>
              <p className="text-gray-400 text-sm">Wells</p>
              <p className="text-3xl font-bold text-white">{totalWells}</p>
            </div>
            <div>
              <p className="text-gray-400 text-sm">Total Pulls</p>
              <p className="text-3xl font-bold text-white">{totalPulls.toLocaleString()}</p>
            </div>
          </div>
          <p className="text-gray-500 text-xs mt-4">
            * Wells with fewer than 5 pulls are excluded from overall average. Test routes excluded.
          </p>
        </div>

        {/* Route Cards */}
        {dataLoading ? (
          <div className="text-gray-400">Loading performance data...</div>
        ) : routes.length === 0 ? (
          <div className="text-gray-400">No performance data available</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {routes.map((route) => (
              <Link
                key={route.routeName}
                href={`/performance/${encodeURIComponent(route.routeName)}`}
                className="block h-full"
              >
                <div className="bg-gray-800 rounded-lg border border-gray-700 p-5 hover:border-blue-500 transition-colors h-full flex flex-col">
                  {/* Route header */}
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-semibold text-white">{route.routeName}</h3>
                    <span className="text-gray-500 text-sm">{route.wellCount} wells</span>
                  </div>

                  {/* Accuracy */}
                  <div className="mb-4">
                    <p
                      className="text-4xl font-bold"
                      style={{ color: route.avgAccuracy > 0 ? getAccuracyColorHex(route.avgAccuracy) : '#9CA3AF' }}
                    >
                      {route.avgAccuracy > 0 ? `${route.avgAccuracy.toFixed(1)}%` : '--'}
                    </p>
                    <p className="text-gray-500 text-sm">Avg Accuracy</p>
                  </div>

                  {/* Stats row */}
                  <div className="flex items-center gap-4 mb-3">
                    <div className="bg-gray-700/50 rounded px-3 py-1.5">
                      <p className="text-blue-400 font-bold text-lg">{route.pullCount.toLocaleString()}</p>
                      <p className="text-gray-500 text-xs">Pulls</p>
                    </div>
                    {route.improving > 0 && (
                      <div className="bg-gray-700/50 rounded px-3 py-1.5">
                        <p className="text-green-400 font-bold text-lg">{route.improving}</p>
                        <p className="text-gray-500 text-xs">Improving</p>
                      </div>
                    )}
                    {route.declining > 0 && (
                      <div className="bg-gray-700/50 rounded px-3 py-1.5">
                        <p className="text-red-400 font-bold text-lg">{route.declining}</p>
                        <p className="text-gray-500 text-xs">Declining</p>
                      </div>
                    )}
                  </div>

                  {/* Well list preview */}
                  <div className="mt-auto pt-3 border-t border-gray-700">
                    <p className="text-gray-500 text-xs mb-1">Wells</p>
                    <p className="text-gray-400 text-sm truncate">
                      {route.wells.map(w => w.wellName).join(', ')}
                    </p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
