'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { WellResponse, subscribeToWellStatusesUnified } from '@/lib/wells';
import Link from 'next/link';
import { AppHeader } from '@/components/AppHeader';
import { fetchTickets, type Ticket } from '@/lib/tickets';

type ViewMode = 'cards' | 'table';
type SortField = 'wellName' | 'tanks' | 'nextPull' | 'level' | 'flowRate' | 'timeTillPull' | 'status';
type SortDir = 'asc' | 'desc';

interface RouteSort {
  field: SortField;
  dir: SortDir;
}

export default function MobilePage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [wells, setWells] = useState<WellResponse[]>([]);
  const [routes, setRoutes] = useState<string[]>([]);
  const [expandedRoutes, setExpandedRoutes] = useState<Set<string>>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('wellbuilt-expanded-routes');
        if (saved) return new Set(JSON.parse(saved));
      } catch {}
    }
    return new Set();
  });
  const [dataLoading, setDataLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('table');

  // Independent sort state per route
  const [routeSorts, setRouteSorts] = useState<Record<string, RouteSort>>({});

  // Per-route pull BBLs override (visual planning only — doesn't save to config)
  const [routePullBbls, setRoutePullBbls] = useState<Record<string, number>>({});

  // Unrouted pagination (limit how many show at once)
  const UNROUTED_PAGE_SIZE = 20;
  const [unroutedShowAll, setUnroutedShowAll] = useState(false);

  // Edge case loads — tickets for wells not in well_config
  const [edgeCaseTickets, setEdgeCaseTickets] = useState<Ticket[]>([]);
  const [edgeCaseExpanded, setEdgeCaseExpanded] = useState(false);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [user, loading, router]);

  // Track if we've done initial setup (don't reset state on every Firebase update)
  const [initialSetupDone, setInitialSetupDone] = useState(false);

  // Subscribe to well data from packets/outgoing
  useEffect(() => {
    const unsubscribe = subscribeToWellStatusesUnified((wellData, routeList) => {
      // Always update wells and routes - this is the data that changes
      setWells(wellData);
      // Always include "Unrouted" even if no wells have it yet
      const routesWithUnrouted = routeList.includes('Unrouted')
        ? routeList
        : [...routeList, 'Unrouted'];
      setRoutes(routesWithUnrouted);

      // Only do initial setup ONCE, not on every Firebase update
      if (!initialSetupDone) {
        // expandedRoutes already restored from localStorage in useState init

        // Initialize sort state for each route
        const initialSorts: Record<string, RouteSort> = {};
        routeList.forEach(route => {
          initialSorts[route] = { field: 'wellName', dir: 'asc' };
        });
        setRouteSorts(initialSorts);

        // Initialize pull BBLs from first well in each route (they're usually the same)
        const initialPullBbls: Record<string, number> = {};
        routeList.forEach(route => {
          const firstWell = wellData.find(w => w.route === route && w.pullBbls);
          initialPullBbls[route] = firstWell?.pullBbls || 140;
        });
        setRoutePullBbls(initialPullBbls);

        setInitialSetupDone(true);
      } else {
        // On subsequent updates, only add sort state for NEW routes
        setRouteSorts(prev => {
          const updated = { ...prev };
          routeList.forEach(route => {
            if (!updated[route]) {
              updated[route] = { field: 'wellName', dir: 'asc' };
            }
          });
          return updated;
        });
      }

      setDataLoading(false);
    });

    return unsubscribe;
  }, [initialSetupDone]);

  // Load edge case tickets (submitted for wells not in well_config)
  useEffect(() => {
    if (wells.length === 0) return;
    // Normalize: lowercase, strip # and special chars, collapse spaces
    const normalize = (s: string) => s.toLowerCase().replace(/[#\-_.,()]/g, ' ').replace(/\s+/g, ' ').trim();
    const wellNamesNorm = wells.map(w => normalize(w.wellName));

    fetchTickets(500).then(tickets => {
      const unmatched = tickets.filter(t => {
        if (!t.location) return false;
        const locNorm = normalize(t.location);
        // Check if any configured well name matches (normalized)
        for (const wn of wellNamesNorm) {
          if (wn === locNorm || wn.includes(locNorm) || locNorm.includes(wn)) return false;
        }
        return true;
      });
      setEdgeCaseTickets(unmatched);
    }).catch(err => {
      console.warn('Edge case tickets load failed:', err);
    });
  }, [wells]);

  // Toggle route expansion and save to localStorage
  const toggleRoute = (route: string) => {
    setExpandedRoutes((prev) => {
      const next = new Set(prev);
      if (next.has(route)) {
        next.delete(route);
      } else {
        next.add(route);
      }
      // Save to localStorage
      localStorage.setItem('wellbuilt-expanded-routes', JSON.stringify(Array.from(next)));
      return next;
    });
  };

  // Expand all / Collapse all
  const expandAll = () => {
    setExpandedRoutes(new Set(routes));
    localStorage.setItem('wellbuilt-expanded-routes', JSON.stringify(routes));
  };
  const collapseAll = () => {
    setExpandedRoutes(new Set());
    localStorage.setItem('wellbuilt-expanded-routes', JSON.stringify([]));
  };

  // Handle sort for a specific route
  const handleRouteSort = (route: string, field: SortField) => {
    setRouteSorts(prev => {
      const current = prev[route] || { field: 'wellName', dir: 'asc' };
      if (current.field === field) {
        return { ...prev, [route]: { field, dir: current.dir === 'asc' ? 'desc' : 'asc' } };
      } else {
        return { ...prev, [route]: { field, dir: 'asc' } };
      }
    });
  };

  // Sort function for wells within a route
  const sortWells = (wellsToSort: WellResponse[], sortState: RouteSort): WellResponse[] => {
    const { field, dir } = sortState;
    return [...wellsToSort].sort((a, b) => {
      let comparison = 0;

      switch (field) {
        case 'wellName':
          comparison = a.wellName.localeCompare(b.wellName);
          break;
        case 'tanks':
          comparison = (a.tanks || 1) - (b.tanks || 1);
          break;
        case 'nextPull':
          const nextA = a.nextPullTime ? new Date(a.nextPullTime).getTime() : 99999999999999;
          const nextB = b.nextPullTime ? new Date(b.nextPullTime).getTime() : 99999999999999;
          comparison = nextA - nextB;
          break;
        case 'level':
          const levelA = parseLevelToInches(a.currentLevel);
          const levelB = parseLevelToInches(b.currentLevel);
          comparison = levelA - levelB;
          break;
        case 'flowRate':
          const flowA = parseFlowRateToSeconds(a.flowRate);
          const flowB = parseFlowRateToSeconds(b.flowRate);
          comparison = flowA - flowB;
          break;
        case 'timeTillPull':
          const tillA = parseEtaToMinutes(a.timeTillPull || a.etaToMax);
          const tillB = parseEtaToMinutes(b.timeTillPull || b.etaToMax);
          comparison = tillA - tillB;
          break;
        case 'status':
          const statusA = getStatusPriority(a);
          const statusB = getStatusPriority(b);
          comparison = statusA - statusB;
          break;
      }

      return dir === 'asc' ? comparison : -comparison;
    });
  };

  // Group wells by route with sorting + pullBbls override
  const getWellsForRoute = (route: string, paginate = true): WellResponse[] => {
    const routeWells = wells.filter((w) => w.route === route);
    const overrideBbls = routePullBbls[route];

    // Apply pullBbls override if set (recalculates Tank @ Level and Time Till Pull)
    const adjustedWells = overrideBbls
      ? routeWells.map(w => recalcWellForPullBbls(w, overrideBbls))
      : routeWells;

    const sortState = routeSorts[route] || { field: 'wellName', dir: 'asc' };
    const sorted = sortWells(adjustedWells, sortState);

    // Paginate Unrouted group to prevent massive lists
    if (paginate && route === 'Unrouted' && !unroutedShowAll && sorted.length > UNROUTED_PAGE_SIZE) {
      return sorted.slice(0, UNROUTED_PAGE_SIZE);
    }

    return sorted;
  };

  // Total unrouted wells (for "show more" button)
  const totalUnroutedWells = wells.filter((w) => w.route === 'Unrouted').length;

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-white text-xl">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-900">
      <AppHeader />

      {/* Main Content */}
      <main className="px-4 py-8">
        {/* Title and Controls */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
          <h2 className="text-xl font-semibold text-white">
            Well Status
            <span className="text-gray-400 text-base font-normal ml-2">
              ({wells.length} wells)
            </span>
          </h2>

          <div className="flex flex-wrap items-center gap-4">
            {/* Performance link */}
            <Link
              href="/performance"
              className="px-3 py-1 text-sm text-gray-400 hover:text-white transition-colors"
            >
              Performance
            </Link>

            {/* Expand/Collapse All */}
            <div className="flex gap-2">
              <button
                onClick={expandAll}
                className="px-3 py-1 text-sm text-gray-400 hover:text-white transition-colors"
              >
                Expand All
              </button>
              <span className="text-gray-600">|</span>
              <button
                onClick={collapseAll}
                className="px-3 py-1 text-sm text-gray-400 hover:text-white transition-colors"
              >
                Collapse All
              </button>
            </div>

            {/* View Toggle */}
            <div className="flex bg-gray-700 rounded-lg p-1">
              <button
                onClick={() => setViewMode('table')}
                className={`px-3 py-1 text-sm rounded transition-colors ${
                  viewMode === 'table'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                Table
              </button>
              <button
                onClick={() => setViewMode('cards')}
                className={`px-3 py-1 text-sm rounded transition-colors ${
                  viewMode === 'cards'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                Cards
              </button>
            </div>
          </div>
        </div>

        {dataLoading ? (
          <div className="text-gray-400">Loading well data...</div>
        ) : routes.length === 0 ? (
          <div className="text-gray-400">No well data available</div>
        ) : viewMode === 'cards' ? (
          /* Cards View - Grouped by Route */
          <div className="space-y-4">
            {routes.map((route) => (
              <div key={route}>
                <RouteSection
                  route={route}
                  wells={getWellsForRoute(route)}
                  isExpanded={expandedRoutes.has(route)}
                  onToggle={() => toggleRoute(route)}
                  pullBbls={routePullBbls[route] || 140}
                  defaultPullBbls={wells.find(w => w.route === route)?.pullBbls || 140}
                  onPullBblsChange={(val) => setRoutePullBbls(prev => ({ ...prev, [route]: val }))}
                />
                {route === 'Unrouted' && !unroutedShowAll && totalUnroutedWells > UNROUTED_PAGE_SIZE && expandedRoutes.has(route) && (
                  <button
                    onClick={() => setUnroutedShowAll(true)}
                    className="w-full mt-1 py-2 text-sm text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    Showing {UNROUTED_PAGE_SIZE} of {totalUnroutedWells} wells — Show all
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          /* Table View - Grouped by Route */
          <div className="space-y-4">
            {routes.map((route) => (
              <div key={route}>
                <RouteTable
                  route={route}
                  wells={getWellsForRoute(route)}
                  isExpanded={expandedRoutes.has(route)}
                  onToggle={() => toggleRoute(route)}
                  sortState={routeSorts[route] || { field: 'wellName', dir: 'asc' }}
                  onSort={(field) => handleRouteSort(route, field)}
                  pullBbls={routePullBbls[route] || 140}
                  defaultPullBbls={wells.find(w => w.route === route)?.pullBbls || 140}
                  onPullBblsChange={(val) => setRoutePullBbls(prev => ({ ...prev, [route]: val }))}
                />
                {route === 'Unrouted' && !unroutedShowAll && totalUnroutedWells > UNROUTED_PAGE_SIZE && expandedRoutes.has(route) && (
                  <button
                    onClick={() => setUnroutedShowAll(true)}
                    className="w-full mt-1 py-2 text-sm text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    Showing {UNROUTED_PAGE_SIZE} of {totalUnroutedWells} wells — Show all
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Edge Case Loads — tickets for wells not in well_config */}
        {edgeCaseTickets.length > 0 && (
          <div className="mt-8 bg-yellow-900/20 rounded-lg border border-yellow-700/50 overflow-hidden">
            <button
              onClick={() => setEdgeCaseExpanded(prev => !prev)}
              className="w-full px-4 py-3 bg-yellow-900/30 border-b border-yellow-700/50 hover:bg-yellow-900/40 transition-colors"
            >
              <div className="flex items-center gap-3">
                <span className="text-yellow-500 text-lg">
                  {edgeCaseExpanded ? '▼' : '▶'}
                </span>
                <h3 className="text-lg font-semibold text-yellow-400">
                  Edge Case Loads
                </h3>
                <span className="text-yellow-600 text-sm font-normal">
                  {edgeCaseTickets.length} ticket{edgeCaseTickets.length !== 1 ? 's' : ''} for unconfigured wells
                </span>
              </div>
              <p className="text-yellow-700 text-xs mt-1 text-left pl-8">
                Water tickets submitted for wells not configured in WB Mobile. Data is safe in Firestore.
              </p>
            </button>
            {edgeCaseExpanded && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-yellow-900/20 text-yellow-500 text-xs">
                      <th className="px-3 py-2 text-left">Ticket #</th>
                      <th className="px-3 py-2 text-left">Invoice #</th>
                      <th className="px-3 py-2 text-left">Company</th>
                      <th className="px-3 py-2 text-left">Location</th>
                      <th className="px-3 py-2 text-left">Drop-off</th>
                      <th className="px-3 py-2 text-left">Type</th>
                      <th className="px-3 py-2 text-right">BBL</th>
                      <th className="px-3 py-2 text-left">Driver</th>
                      <th className="px-3 py-2 text-left">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {edgeCaseTickets.map((t) => (
                      <tr key={t.id} className="border-t border-yellow-900/30 hover:bg-yellow-900/10">
                        <td className="px-3 py-2 text-yellow-300 font-mono">{t.ticketNumber}</td>
                        <td className="px-3 py-2 text-gray-400 font-mono">{t.invoiceNumber || '—'}</td>
                        <td className="px-3 py-2 text-gray-300">{t.company || '—'}</td>
                        <td className="px-3 py-2 text-gray-300">{t.location || '—'}</td>
                        <td className="px-3 py-2 text-gray-400">{t.hauledTo || '—'}</td>
                        <td className="px-3 py-2 text-gray-400">{t.type || '—'}</td>
                        <td className="px-3 py-2 text-right text-gray-300">{t.qty || '—'}</td>
                        <td className="px-3 py-2 text-gray-400">{t.driver || '—'}</td>
                        <td className="px-3 py-2 text-gray-500">{t.date || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

// Helper functions for sorting
function parseLevelToInches(level: string): number {
  if (!level || level === '--' || level === 'DOWN') return -1;
  const match = level.match(/(\d+)'(\d+)"/);
  if (match) {
    return parseInt(match[1]) * 12 + parseInt(match[2]);
  }
  return -1;
}

function parseEtaToMinutes(eta: string): number {
  if (!eta || eta === '--') return 99999;
  const match = eta.match(/(\d+):(\d+)/);
  if (match) {
    return parseInt(match[1]) * 60 + parseInt(match[2]);
  }
  return 99999;
}

function parseFlowRateToSeconds(flowRate: string): number {
  if (!flowRate || flowRate === '--') return 99999;
  const match = flowRate.match(/(\d+)m\s*(\d+)s/);
  if (match) {
    return parseInt(match[1]) * 60 + parseInt(match[2]);
  }
  return 99999;
}

function getStatusPriority(well: WellResponse): number {
  if (well.isDown || well.currentLevel === 'DOWN') return 0;
  if (well.currentLevel === '--') return 2;
  return 1;
}

// Recalculate Tank @ Level and Time Till Pull for a different pullBbls amount
// Visual-only planning tool — doesn't change saved config
function recalcWellForPullBbls(well: WellResponse, overridePullBbls: number): WellResponse {
  if (well.isDown || well.currentLevel === 'DOWN' || well.currentLevel === '--') return well;

  const tanks = well.tanks || 1;
  const bottomLevelFeet = well.bottomLevel || 3;
  const bottomInches = bottomLevelFeet * 12;

  // VBA formula: tankHeightInches = ((pullBbls / tanks / 20) * 12) + bottomInches
  const bblsPerTank = overridePullBbls / tanks;
  const tankAtInches = ((bblsPerTank / 20) * 12) + bottomInches;
  const tankAtFeet = Math.floor(tankAtInches / 12);
  const tankAtRemainder = Math.round(tankAtInches - (tankAtFeet * 12));
  const tankAtLevel = `${tanks} @ ${tankAtFeet}'${tankAtRemainder}"`;

  // Recalculate timeTillPull based on new target height
  const currentInches = parseLevelToInches(well.currentLevel);
  let timeTillPull = well.timeTillPull;

  if (currentInches >= 0 && well.flowRate && well.flowRate !== '--') {
    const inchesNeeded = tankAtInches - currentInches;
    if (inchesNeeded <= 0) {
      timeTillPull = 'Ready';
    } else {
      const flowMatch = well.flowRate.match(/(\d+):(\d+):(\d+)/);
      if (flowMatch) {
        const flowHours = parseInt(flowMatch[1]);
        const flowMins = parseInt(flowMatch[2]);
        const flowSecs = parseInt(flowMatch[3]);
        const flowRateTotalMinutes = flowHours * 60 + flowMins + flowSecs / 60;
        const minutesPerInch = flowRateTotalMinutes / 12;
        const totalMinutes = inchesNeeded * minutesPerInch;
        const days = Math.floor(totalMinutes / 1440);
        const hours = Math.floor((totalMinutes % 1440) / 60);
        const mins = Math.floor(totalMinutes % 60);
        if (days > 0) {
          timeTillPull = `${days}d ${hours}h ${mins}m`;
        } else {
          timeTillPull = `${hours}h ${mins}m`;
        }
      }
    }
  }

  return {
    ...well,
    tankAtLevel,
    pullBbls: overridePullBbls,
    timeTillPull,
    etaToMax: timeTillPull || well.etaToMax,
  };
}

// Pull BBLs slider for route headers — dispatch planning tool
function PullBblsSlider({
  value,
  defaultValue,
  onChange,
}: {
  value: number;
  defaultValue: number;
  onChange: (value: number) => void;
}) {
  const isModified = value !== defaultValue;

  return (
    <div
      className="flex items-center gap-2 ml-auto"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="text-gray-500 text-xs hidden sm:inline">50</span>
      <input
        type="range"
        min={50}
        max={300}
        step={10}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value))}
        className="w-20 sm:w-28 h-1.5 accent-blue-500 cursor-pointer"
      />
      <span className="text-gray-500 text-xs hidden sm:inline">300</span>
      <span className={`text-sm font-mono min-w-[60px] text-right ${isModified ? 'text-yellow-400' : 'text-gray-400'}`}>
        {value} BBL
      </span>
      {isModified && (
        <button
          onClick={(e) => { e.stopPropagation(); onChange(defaultValue); }}
          className="text-gray-500 hover:text-white text-xs px-1"
          title="Reset to default"
        >
          ✕
        </button>
      )}
    </div>
  );
}

function SortHeader({
  label,
  field,
  sortState,
  onSort,
}: {
  label: string;
  field: SortField;
  sortState: RouteSort;
  onSort: (field: SortField) => void;
}) {
  const isActive = sortState.field === field;

  return (
    <th
      className="px-4 py-2 text-left text-sm font-medium text-gray-300 cursor-pointer hover:text-white select-none"
      onClick={() => onSort(field)}
    >
      {label}
      <span className={`ml-1 ${isActive ? 'text-blue-400' : 'text-gray-600'}`}>
        {isActive ? (sortState.dir === 'asc' ? '▲' : '▼') : '▲'}
      </span>
    </th>
  );
}

function RouteTable({
  route,
  wells,
  isExpanded,
  onToggle,
  sortState,
  onSort,
  pullBbls,
  defaultPullBbls,
  onPullBblsChange,
}: {
  route: string;
  wells: WellResponse[];
  isExpanded: boolean;
  onToggle: () => void;
  sortState: RouteSort;
  onSort: (field: SortField) => void;
  pullBbls: number;
  defaultPullBbls: number;
  onPullBblsChange: (value: number) => void;
}) {
  const downCount = wells.filter((w) => w.isDown || w.currentLevel === 'DOWN').length;

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
      {/* Route Header - Clickable to collapse */}
      <button
        onClick={onToggle}
        className="w-full px-4 py-3 bg-gray-750 border-b border-gray-700 hover:bg-gray-700 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-gray-400 text-lg">
            {isExpanded ? '▼' : '▶'}
          </span>
          <h3 className="text-lg font-semibold text-white">{route}</h3>
          <span className="text-gray-400 text-sm">({wells.length} wells)</span>
          {downCount > 0 && (
            <span className="px-2 py-0.5 bg-red-600 text-white text-xs font-bold rounded">
              {downCount} DOWN
            </span>
          )}
          {isExpanded && (
            <PullBblsSlider
              value={pullBbls}
              defaultValue={defaultPullBbls}
              onChange={onPullBblsChange}
            />
          )}
        </div>
      </button>

      {/* Table - Collapsible */}
      {isExpanded && (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-700">
              <tr>
                <SortHeader label="Well" field="wellName" sortState={sortState} onSort={onSort} />
                <th className="px-4 py-2 text-left text-sm font-medium text-gray-400">Location</th>
                <SortHeader label="Tank @ Level" field="tanks" sortState={sortState} onSort={onSort} />
                <SortHeader label="Next Pull" field="nextPull" sortState={sortState} onSort={onSort} />
                <SortHeader label="Level" field="level" sortState={sortState} onSort={onSort} />
                <SortHeader label="Flow Rate" field="flowRate" sortState={sortState} onSort={onSort} />
                <SortHeader label="Time Till Pull" field="timeTillPull" sortState={sortState} onSort={onSort} />
                <SortHeader label="Down" field="status" sortState={sortState} onSort={onSort} />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700">
              {wells.map((well) => (
                <WellRow key={well.responseId || well.wellName} well={well} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function WellRow({ well }: { well: WellResponse }) {
  const isDown = well.isDown || well.currentLevel === 'DOWN';

  // Format tank @ level — target height when ready to pull (from VBA formula)
  const formatTankLevel = () => {
    if (well.tankAtLevel) return well.tankAtLevel;
    if (isDown) return '--';
    const tanks = well.tanks || 1;
    return `${tanks} @ --`;
  };

  // Format next pull datetime
  const formatNextPull = () => {
    if (!well.nextPullTime) return '--';
    try {
      const date = new Date(well.nextPullTime);
      if (isNaN(date.getTime())) return well.nextPullTime;
      return date.toLocaleString('en-US', {
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
    } catch {
      return well.nextPullTime || '--';
    }
  };

  return (
    <tr className={`hover:bg-gray-750 ${isDown ? 'bg-red-900/20' : ''}`}>
      <td className="px-4 py-3">
        <Link href={`/well/${encodeURIComponent(well.wellName)}`} className="text-blue-400 hover:text-blue-300 font-medium">
          {well.wellName}
        </Link>
      </td>
      <td className="px-4 py-3 text-gray-500 font-mono">--</td>
      <td className="px-4 py-3 text-white font-mono">{formatTankLevel()}</td>
      <td className="px-4 py-3 text-white font-mono text-sm">{formatNextPull()}</td>
      <td className="px-4 py-3 text-white font-mono">{well.currentLevel || '--'}</td>
      <td className="px-4 py-3 text-white font-mono">{well.flowRate || '--'}</td>
      <td className="px-4 py-3 text-white font-mono">{well.timeTillPull || well.etaToMax || '--'}</td>
      <td className="px-4 py-3">
        {isDown ? (
          <span className="px-2 py-1 bg-red-600 text-white text-xs font-bold rounded">X</span>
        ) : (
          <span className="text-gray-500">--</span>
        )}
      </td>
    </tr>
  );
}

function RouteSection({
  route,
  wells,
  isExpanded,
  onToggle,
  pullBbls,
  defaultPullBbls,
  onPullBblsChange,
}: {
  route: string;
  wells: WellResponse[];
  isExpanded: boolean;
  onToggle: () => void;
  pullBbls: number;
  defaultPullBbls: number;
  onPullBblsChange: (value: number) => void;
}) {
  const downCount = wells.filter((w) => w.isDown || w.currentLevel === 'DOWN').length;

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
      {/* Route Header - Clickable */}
      <button
        onClick={onToggle}
        className="w-full px-4 py-3 flex justify-between items-center bg-gray-750 hover:bg-gray-700 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-gray-400 text-lg">
            {isExpanded ? '▼' : '▶'}
          </span>
          <h3 className="text-lg font-semibold text-white">{route}</h3>
          <span className="text-gray-400 text-sm">
            ({wells.length} wells)
          </span>
          {downCount > 0 && (
            <span className="px-2 py-0.5 bg-red-600 text-white text-xs font-bold rounded">
              {downCount} DOWN
            </span>
          )}
          {isExpanded && (
            <PullBblsSlider
              value={pullBbls}
              defaultValue={defaultPullBbls}
              onChange={onPullBblsChange}
            />
          )}
        </div>
      </button>

      {/* Wells Grid - Collapsible */}
      {isExpanded && (
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {wells.map((well) => (
            <WellCard key={well.responseId || well.wellName} well={well} />
          ))}
        </div>
      )}
    </div>
  );
}

function WellCard({ well }: { well: WellResponse }) {
  const isDown = well.isDown || well.currentLevel === 'DOWN';
  const tanks = well.tanks || 1;

  // Format next pull datetime
  const formatNextPull = () => {
    if (!well.nextPullTime) return '--';
    try {
      const date = new Date(well.nextPullTime);
      if (isNaN(date.getTime())) return well.nextPullTime;
      return date.toLocaleString('en-US', {
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
    } catch {
      return well.nextPullTime || '--';
    }
  };

  return (
    <Link href={`/well/${encodeURIComponent(well.wellName)}`}>
      <div
        className={`p-4 rounded-lg border transition-all hover:scale-102 hover:shadow-lg cursor-pointer h-full ${
          isDown
            ? 'bg-red-900/30 border-red-700'
            : 'bg-gray-700 border-gray-600 hover:border-gray-500'
        }`}
      >
        <div className="flex justify-between items-start mb-3">
          <h3 className="text-lg font-semibold text-white">{well.wellName}</h3>
          {isDown && (
            <span className="px-2 py-1 bg-red-600 text-white text-xs font-bold rounded">
              DOWN
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <p className="text-gray-400">Tank @ Level</p>
            <p className={`text-lg font-mono ${isDown ? 'text-red-300/50' : 'text-white'}`}>
              {isDown ? '--' : (well.tankAtLevel || `${tanks} @ --`)}
            </p>
          </div>
          <div>
            <p className="text-gray-400">Time Till Pull</p>
            <p className={`text-lg font-mono ${isDown ? 'text-red-300' : 'text-white'}`}>
              {isDown ? 'Down' : (well.timeTillPull || well.etaToMax || '--')}
            </p>
          </div>
        </div>

        <div className="mt-3 pt-3 border-t border-gray-600 space-y-1">
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Next Pull</span>
            <span className={`font-mono text-xs ${isDown ? 'text-red-300/50' : 'text-white'}`}>
              {isDown ? '--' : formatNextPull()}
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Flow Rate</span>
            <span className={`font-mono ${isDown ? 'text-red-300/50' : 'text-white'}`}>
              {isDown ? '--' : (well.flowRate || '--')}
            </span>
          </div>
        </div>
      </div>
    </Link>
  );
}
