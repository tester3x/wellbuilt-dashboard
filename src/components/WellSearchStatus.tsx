'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { buildSearchWellStatus, type SearchWellStatus } from '@/lib/wellSearchPresentation';
import type { WellResponse } from '@/lib/wells';

const WellSearchStatusContext = createContext<ReadonlyMap<string, SearchWellStatus>>(new Map());
export const useSearchWellStatus = () => useContext(WellSearchStatusContext);
const key = (name: string) => name.trim().toLowerCase();

/** Uses only the current page's governed company pool; never fetches a global catalog. */
export function WellSearchStatusProvider({ wells, nowMs, children }: {
  wells: readonly WellResponse[]; nowMs: number; children: ReactNode;
}) {
  const levels = useMemo(() => buildSearchWellStatus(wells, nowMs), [wells, nowMs]);
  return <WellSearchStatusContext.Provider value={levels}>{children}</WellSearchStatusContext.Provider>;
}

export function WellSearchLevel({ name, fallback }: { name: string; fallback?: string }) {
  const levels = useContext(WellSearchStatusContext);
  const display = levels.get(key(name))?.level || fallback;
  if (!display || display === '--') return null;
  return <span className="ml-auto shrink-0 whitespace-nowrap text-right text-xs font-semibold tabular-nums text-cyan-300" title="WB Mobile estimated level">{display}</span>;
}
