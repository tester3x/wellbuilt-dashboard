import { classifyWell, compareQueueRows } from './dispatchPriority.ts';
import type { WellResponse } from './wellPoolCore.ts';

export type SearchWellStatus = { level: string; order: number };
const key = (name: string) => name.trim().toLowerCase();

/** Exact aliases only. Ambiguous names never inherit another well's reading. */
export function buildSearchWellStatus(wells: readonly WellResponse[], nowMs: number): ReadonlyMap<string, SearchWellStatus> {
  const index = new Map<string, SearchWellStatus>();
  const ambiguous = new Set<string>();
  const ordered = wells.map(well => ({ well, priority: classifyWell(well, nowMs) })).sort((a, b) => {
    // Summary keeps down wells last, highest frozen level first within that group.
    if (a.priority.state === 'down' && b.priority.state === 'down') {
      const height = (b.priority.estFeet ?? -Infinity) - (a.priority.estFeet ?? -Infinity);
      if (height) return height;
    }
    return compareQueueRows(a, b);
  });
  ordered.forEach(({ well, priority }, order) => {
    const level = priority.state === 'down'
      ? `DOWN${priority.estFeet == null ? '' : ` · ${priority.estDisplay}`}` : priority.estDisplay;
    for (const name of new Set([well.wellName, well.ndicName].filter((n): n is string => !!n).map(key))) {
      if (index.has(name)) ambiguous.add(name);
      else index.set(name, { level, order });
    }
  });
  for (const name of ambiguous) index.delete(name);
  return index;
}

/** Sort the actual row objects, before capping, so keyboard/click identity stays intact. */
export function rankWellSearchRows<T>(rows: readonly T[], query: string, nameOf: (row: T) => string,
  status: ReadonlyMap<string, SearchWellStatus>, limit = 15, isWell: (row: T) => boolean = () => true): T[] {
  const q = key(query);
  const relevance = (name: string) => name === q ? 0 : name.startsWith(q) ? 1 : 2;
  return [...rows].sort((a, b) => {
    const an = key(nameOf(a)), bn = key(nameOf(b));
    const ar = isWell(a) ? status.get(an)?.order : undefined;
    const br = isWell(b) ? status.get(bn)?.order : undefined;
    return Number(bn === q) - Number(an === q)
      || (ar ?? Infinity) - (br ?? Infinity)
      || relevance(an) - relevance(bn)
      || an.localeCompare(bn, undefined, { numeric: true });
  }).slice(0, limit);
}
