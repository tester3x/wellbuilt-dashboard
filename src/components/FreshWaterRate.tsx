import type { WellResponse } from '@/lib/wellPoolCore';
import { freshWaterRateDisplay } from '@/lib/freshWaterRateDisplay';
/** One rate presentation for route rows, cards, details and information panels. */
export function FreshWaterRate({well,unit='foot'}:{well:WellResponse;unit?:'foot'|'inch'|'day'}) {
 const rate=freshWaterRateDisplay(well);
 const value=unit==='day'?rate.perDay:unit==='inch'?rate.perInch:rate.perFoot;
 return <span data-freshwater-rate title={rate.provenance}>
  <span>{value}{value!=='--' && unit!=='day' ? unit==='inch' ? ' / in' : ' / ft' : ''}</span>
  {rate.daily!=null && <span className="block text-xs text-gray-400">{unit==='day'?'Estimated':rate.perDay+' · estimated'}</span>}
  {rate.paused && <span className="block text-xs text-gray-400">Consumption paused · rate retained</span>}
 </span>;
}
