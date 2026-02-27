'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import {
  WellPerformanceStats,
  buildPerformanceSummary,
  getAccuracyColor,
  getAccuracyColorHex,
  getRealAccuracy,
} from '@/lib/wells';
import Link from 'next/link';
import { AppHeader } from '@/components/AppHeader';
import { SubHeader } from '@/components/SubHeader';

type SortField = 'name' | 'pulls' | 'accuracy' | 'trend';

export default function RoutePerformancePage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const params = useParams();
  const routeName = decodeURIComponent(params.route as string);

  const [wells, setWells] = useState<WellPerformanceStats[]>([]);
  const [routeAvg, setRouteAvg] = useState(0);
  const [routePulls, setRoutePulls] = useState(0);
  const [improving, setImproving] = useState(0);
  const [declining, setDeclining] = useState(0);
  const [dataLoading, setDataLoading] = useState(true);
  const [sortField, setSortField] = useState<SortField>('accuracy');
  const [sortAsc, setSortAsc] = useState(true);

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
        const route = summary.routes.find(r => r.routeName === routeName);

        if (route) {
          setWells(route.wells);
          setRouteAvg(route.avgAccuracy);
          setRoutePulls(route.pullCount);
          setImproving(route.improving);
          setDeclining(route.declining);
        }
      } catch (err) {
        console.error('Error fetching route performance:', err);
      } finally {
        setDataLoading(false);
      }
    };

    loadData();
  }, [user, routeName]);

  // Sort wells
  const sortedWells = [...wells].sort((a, b) => {
    let cmp = 0;
    switch (sortField) {
      case 'name':
        cmp = a.wellName.localeCompare(b.wellName);
        break;
      case 'pulls':
        cmp = a.pullCount - b.pullCount;
        break;
      case 'accuracy':
        cmp = a.avgAccuracy - b.avgAccuracy;
        break;
      case 'trend': {
        const trendOrder = { up: 0, stable: 1, down: 2 };
        cmp = trendOrder[a.trend] - trendOrder[b.trend];
        break;
      }
    }
    return sortAsc ? cmp : -cmp;
  });

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(field === 'accuracy'); // default ascending for accuracy (lower deviation first)
    }
  };

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
      <SubHeader
        backHref="/performance"
        title={`${routeName} Performance`}
        subtitle={`${wells.length} wells · ${routePulls.toLocaleString()} pulls`}
      />

      <main className="max-w-7xl mx-auto px-4 py-8">
        {/* Route Summary */}
        <div className="bg-gray-800 rounded-lg border border-gray-700 p-6 mb-8">
          <h2 className="text-lg font-semibold text-white mb-4">{routeName} — Route Performance</h2>
          <div className="flex flex-wrap items-center gap-8">
            <div>
              <p className="text-gray-400 text-sm">Average Accuracy</p>
              <p
                className="text-4xl font-bold"
                style={{ color: routeAvg > 0 ? getAccuracyColorHex(routeAvg) : '#9CA3AF' }}
              >
                {routeAvg > 0 ? `${routeAvg.toFixed(1)}%` : '--'}
              </p>
            </div>
            <div>
              <p className="text-gray-400 text-sm">Wells</p>
              <p className="text-3xl font-bold text-white">{wells.length}</p>
            </div>
            <div>
              <p className="text-gray-400 text-sm">Total Pulls</p>
              <p className="text-3xl font-bold text-blue-400">{routePulls.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-gray-400 text-sm">Improving</p>
              <p className="text-3xl font-bold text-green-400">{improving}</p>
            </div>
            <div>
              <p className="text-gray-400 text-sm">Declining</p>
              <p className="text-3xl font-bold text-red-400">{declining}</p>
            </div>
          </div>
          {/* Accuracy band legend */}
          <div className="flex items-center gap-4 mt-4 text-xs">
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-green-500 inline-block" /> 95%+</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-yellow-500 inline-block" /> 90-95%</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" /> &lt;90%</span>
            <span className="text-gray-500 ml-2">Tap well for details</span>
          </div>
        </div>

        {/* Sort buttons */}
        <div className="flex items-center gap-2 mb-4">
          <span className="text-gray-500 text-sm">Sort:</span>
          {([
            { field: 'name' as SortField, label: 'Name' },
            { field: 'pulls' as SortField, label: 'Pulls' },
            { field: 'accuracy' as SortField, label: 'Acc' },
            { field: 'trend' as SortField, label: 'Trend' },
          ]).map(({ field, label }) => (
            <button
              key={field}
              onClick={() => handleSort(field)}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                sortField === field
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              {label} {sortField === field && (sortAsc ? '▲' : '▼')}
            </button>
          ))}
        </div>

        {/* Well List */}
        {dataLoading ? (
          <div className="text-gray-400">Loading...</div>
        ) : wells.length === 0 ? (
          <div className="text-gray-400">No performance data for this route</div>
        ) : (
          <div className="space-y-3">
            {sortedWells.map((well) => {
              const realAvg = getRealAccuracy(well.avgAccuracy);
              return (
                <Link
                  key={well.wellName}
                  href={`/performance/well/${encodeURIComponent(well.wellName)}`}
                  className="block"
                >
                  <div className="bg-gray-800 rounded-lg border border-gray-700 p-4 hover:border-blue-500 transition-colors flex items-center gap-4">
                    {/* Well info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-white font-semibold text-base">{well.wellName}</p>
                      <p className="text-gray-500 text-sm">{well.pullCount} pulls</p>
                    </div>

                    {/* Accuracy */}
                    <div className="text-center">
                      <p
                        className="text-xl font-bold"
                        style={{ color: getAccuracyColorHex(well.avgAccuracy) }}
                      >
                        {well.avgAccuracy.toFixed(1)}%
                      </p>
                      <p className="text-gray-500 text-xs">avg</p>
                    </div>

                    {/* Range */}
                    <div className="text-center hidden sm:block">
                      <p className="text-white text-sm font-mono">
                        {well.worstAccuracy.toFixed(0)}-{well.bestAccuracy.toFixed(0)}%
                      </p>
                      <p className="text-gray-500 text-xs">range</p>
                    </div>

                    {/* Distribution dots */}
                    <div className="flex items-center gap-1.5 hidden md:flex">
                      <span className="text-green-400 text-xs font-mono">●{well.greenCount}</span>
                      <span className="text-yellow-400 text-xs font-mono">●{well.yellowCount}</span>
                      <span className="text-red-400 text-xs font-mono">●{well.redCount}</span>
                    </div>

                    {/* Trend */}
                    <div className="w-8 text-right">
                      {well.trend === 'up' && <span className="text-green-400 text-lg">↑</span>}
                      {well.trend === 'down' && <span className="text-red-400 text-lg">↓</span>}
                      {well.trend === 'stable' && <span className="text-gray-400 text-lg">→</span>}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
