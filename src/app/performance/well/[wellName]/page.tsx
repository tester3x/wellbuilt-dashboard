'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import {
  PerformanceRow,
  ProcessedPerfRow,
  WellPerformanceStats,
  fetchWellPerformance,
  fetchWellConfigs,
  processPerformanceRows,
  calcWellStats,
  getAccuracyColor,
  getAccuracyColorHex,
  getRealAccuracy,
  formatLevel,
} from '@/lib/wells';
import { AppHeader } from '@/components/AppHeader';
import { SubHeader } from '@/components/SubHeader';

type SortField = 'date' | 'accuracy';

export default function WellPerformanceDetailPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const params = useParams();
  const wellName = decodeURIComponent(params.wellName as string);

  const [stats, setStats] = useState<WellPerformanceStats | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [sortField, setSortField] = useState<SortField>('date');
  const [sortAsc, setSortAsc] = useState(false); // newest first

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [user, loading, router]);

  useEffect(() => {
    if (!user) return;

    const loadData = async () => {
      try {
        const [rawRows, configs] = await Promise.all([
          fetchWellPerformance(wellName),
          fetchWellConfigs(),
        ]);

        // Find route from config
        const configEntry = Object.entries(configs).find(([key]) => key === wellName);
        const route = configEntry?.[1]?.route || 'Unassigned';

        const processed = processPerformanceRows(rawRows);
        const wellStats = calcWellStats(wellName, route, processed);
        setStats(wellStats);
      } catch (err) {
        console.error('Error fetching well performance:', err);
      } finally {
        setDataLoading(false);
      }
    };

    loadData();
  }, [user, wellName]);

  // Sort rows
  const sortedRows = useMemo(() => {
    if (!stats) return [];
    const rows = [...stats.rows];
    rows.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'date') {
        cmp = a.dateObj.getTime() - b.dateObj.getTime();
      } else {
        cmp = a.accuracy - b.accuracy;
      }
      return sortAsc ? cmp : -cmp;
    });
    return rows;
  }, [stats, sortField, sortAsc]);

  // Find best and worst rows
  const bestIdx = useMemo(() => {
    if (!sortedRows.length) return -1;
    let bestReal = -1;
    let idx = -1;
    sortedRows.forEach((r, i) => {
      if (r.isAnomaly) return;
      const real = getRealAccuracy(r.accuracy);
      if (real > bestReal) {
        bestReal = real;
        idx = i;
      }
    });
    return idx;
  }, [sortedRows]);

  const worstIdx = useMemo(() => {
    if (!sortedRows.length) return -1;
    let worstReal = 200;
    let idx = -1;
    sortedRows.forEach((r, i) => {
      if (r.isAnomaly) return;
      const real = getRealAccuracy(r.accuracy);
      if (real < worstReal) {
        worstReal = real;
        idx = i;
      }
    });
    return idx;
  }, [sortedRows]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(field === 'date' ? false : true);
    }
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr + 'T12:00:00');
    return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white text-xl">Loading...</div>
      </div>
    );
  }

  if (!user) return null;

  const backHref = stats?.route
    ? `/performance/${encodeURIComponent(stats.route)}`
    : '/performance';

  return (
    <div className="min-h-screen bg-gray-900">
      <AppHeader />
      <SubHeader
        backHref={backHref}
        title={wellName}
        subtitle={stats ? `${stats.route} · ${stats.pullCount} pulls` : 'Loading...'}
      />

      <main className="max-w-5xl mx-auto px-4 py-8">
        {dataLoading ? (
          <div className="text-gray-400">Loading performance data...</div>
        ) : !stats ? (
          <div className="text-gray-400">No performance data for this well</div>
        ) : (
          <>
            {/* Stats card */}
            <div className="bg-gray-800 rounded-lg border border-gray-700 p-6 mb-6">
              <div className="flex flex-wrap items-center gap-8 mb-4">
                <div>
                  <p className="text-gray-400 text-sm">Avg Accuracy</p>
                  <p
                    className="text-4xl font-bold"
                    style={{ color: getAccuracyColorHex(stats.avgAccuracy) }}
                  >
                    {stats.avgAccuracy.toFixed(1)}%
                  </p>
                </div>
                <div>
                  <p className="text-gray-400 text-sm">Trend</p>
                  <p className="text-2xl font-bold">
                    {stats.trend === 'up' && <span className="text-green-400">↑ Improving</span>}
                    {stats.trend === 'down' && <span className="text-red-400">↓ Declining</span>}
                    {stats.trend === 'stable' && <span className="text-gray-400">→ Stable</span>}
                  </p>
                </div>
              </div>
              {/* Distribution */}
              <div className="flex items-center gap-4">
                <div className="bg-gray-700/50 rounded px-3 py-1.5 text-center">
                  <p className="text-blue-400 font-bold text-lg">{stats.pullCount}</p>
                  <p className="text-gray-500 text-xs">Total</p>
                </div>
                <div className="bg-gray-700/50 rounded px-3 py-1.5 text-center">
                  <p className="text-green-400 font-bold text-lg">{stats.bestAccuracy.toFixed(1)}%</p>
                  <p className="text-gray-500 text-xs">Best</p>
                </div>
                <div className="bg-gray-700/50 rounded px-3 py-1.5 text-center">
                  <p className="text-red-400 font-bold text-lg">{stats.worstAccuracy.toFixed(1)}%</p>
                  <p className="text-gray-500 text-xs">Worst</p>
                </div>
                <div className="flex items-center gap-1.5 ml-auto">
                  <span className="text-green-400 text-sm font-mono">● {stats.greenCount}</span>
                  <span className="text-yellow-400 text-sm font-mono">● {stats.yellowCount}</span>
                  <span className="text-red-400 text-sm font-mono">● {stats.redCount}</span>
                </div>
              </div>
            </div>

            {/* Pull history header */}
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-semibold">
                Recent Pulls
                <span className="text-gray-500 font-normal ml-2 text-sm">
                  Showing last {sortedRows.length}
                </span>
              </h3>
              {sortedRows.length > 0 && (
                <p className="text-gray-500 text-sm">
                  {formatDate(sortedRows[sortedRows.length - 1].date)} → {formatDate(sortedRows[0].date)}
                </p>
              )}
            </div>

            {/* Sort buttons */}
            <div className="flex items-center gap-2 mb-4">
              <button
                onClick={() => handleSort('date')}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  sortField === 'date'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                Date {sortField === 'date' && (sortAsc ? '▲' : '▼')}
              </button>
              <button
                onClick={() => handleSort('accuracy')}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  sortField === 'accuracy'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                Accuracy {sortField === 'accuracy' && (sortAsc ? '▲' : '▼')}
              </button>
            </div>

            {/* Pull history table */}
            <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
              <table className="w-full">
                <thead className="bg-gray-700">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium text-gray-300">Date</th>
                    <th className="px-4 py-3 text-center text-sm font-medium text-gray-300">Pred</th>
                    <th className="px-4 py-3 text-center text-sm font-medium text-gray-300">Actual</th>
                    <th className="px-4 py-3 text-right text-sm font-medium text-gray-300">Accuracy</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {sortedRows.map((row, i) => {
                    const isBest = i === bestIdx;
                    const isWorst = i === worstIdx;
                    const isAnomaly = row.isAnomaly;

                    let borderClass = '';
                    let emoji = '';
                    if (isBest) {
                      borderClass = 'border-l-4 border-l-green-500';
                      emoji = ' 🏆';
                    } else if (isWorst) {
                      borderClass = 'border-l-4 border-l-red-500';
                      emoji = ' ⚠️';
                    } else if (isAnomaly) {
                      borderClass = 'border-l-4 border-l-gray-500';
                      emoji = ' 😕';
                    }

                    return (
                      <tr
                        key={`${row.date}-${i}`}
                        className={`${borderClass} ${isAnomaly ? 'opacity-60' : ''} hover:bg-gray-750`}
                      >
                        <td className="px-4 py-2.5 text-white text-sm">
                          {formatDate(row.date)}{emoji}
                        </td>
                        <td className="px-4 py-2.5 text-center text-gray-300 text-sm font-mono">
                          {formatLevel(row.predictedInches)}
                        </td>
                        <td className="px-4 py-2.5 text-center text-gray-300 text-sm font-mono">
                          {formatLevel(row.actualInches)}
                        </td>
                        <td className={`px-4 py-2.5 text-right text-sm font-mono font-semibold ${getAccuracyColor(row.accuracy)}`}>
                          {row.accuracy.toFixed(1)}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Legend */}
            <div className="flex items-center gap-4 mt-3 text-xs text-gray-500">
              <span>🏆 Best</span>
              <span>⚠️ Worst</span>
              <span>😕 Anomaly (excluded from avg)</span>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
