import type { CombinedLocation } from '@/lib/builderWellSearch';

/** Matches WB-T: type badge beside name, operator and county underneath. */
export function LocationSearchResult({ item }: { item: CombinedLocation }) {
  return <span className="flex items-center gap-3 w-full text-left py-2">
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${item.kind === 'SWD' ? 'bg-cyan-900 text-cyan-300' : item.kind === 'LOC' ? 'bg-amber-900 text-amber-300' : 'bg-sky-900 text-sky-300'}`}>{item.kind || 'WELL'}</span>
    <span className="min-w-0"><span className="block text-sm text-white">{item.label}</span>
      <span className="wb-option-sub block text-xs text-gray-400">{[item.sub, item.county ? `${item.county} Co.` : ''].filter(Boolean).join(' — ')}</span>
    </span>
  </span>;
}

export function CatalogSearchResult({ row }: { row: { well_name: string; operator?: string; county?: string; kind?: 'WELL' | 'SWD' | 'LOC' } }) {
  return <LocationSearchResult item={{ label: row.well_name, value: row.well_name, sub: row.operator || '', county: row.county, kind: row.kind || 'WELL' }} />;
}
