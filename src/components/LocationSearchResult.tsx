import type { CombinedLocation } from '@/lib/builderWellSearch';

/** Matches WB-T: type badge beside name, operator and county underneath. */
export function LocationSearchResult({ item }: { item: CombinedLocation }) {
  return <span className="flex items-center gap-3 w-full text-left py-2">
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${item.kind === 'SWD' ? 'bg-[#3a2f15] text-[#DAA520]' : item.kind === 'LOC' ? 'bg-[#15321f] text-[#4ade80]' : 'bg-[#13314f] text-[#7dd3fc]'}`}>{item.kind === 'LOC' ? 'PLACE' : item.kind || 'WELL'}</span>
    <span className="min-w-0"><span className="block text-sm text-white">{item.label}</span>
      <span className="wb-option-sub block text-xs text-gray-400">{[item.sub, item.county ? `${item.county} Co.` : ''].filter(Boolean).join(' — ')}</span>
      {item.showWaterDetails && <span className="block text-xs text-amber-300">
        {item.waterWeight == null ? 'Weight unknown' : `${item.waterWeight} lb/gal`}
        {' · '}Level {item.estimatedLevel || '--'}
        {' · '}Tank height {item.tankHeight == null ? 'unknown' : `${item.tankHeight} ft`}
      </span>}
    </span>
  </span>;
}

export function CatalogSearchResult({ row }: { row: { well_name: string; operator?: string; county?: string; kind?: 'WELL' | 'SWD' | 'LOC'; usageCount?: number } }) {
  return <LocationSearchResult item={{ label: row.well_name, value: row.well_name, sub: row.kind === 'LOC' ? `Used ${row.usageCount || 0}× — ${row.operator || 'Custom'}` : row.operator || '', county: row.county, kind: row.kind || 'WELL' }} />;
}
