import type { JsonRecord } from '../imports/pullImportModel';
/** Conservative overlap warning, never an automatic duplicate or a volume adjustment. */
export function possibleAggregateOverlap(row: {wellName: string; dateTimeUTC: string; tankLevelFeet: number|null; bottomLevelFeet: number|null; bblsTaken: number|null}, history: JsonRecord, driverId: string|null): string[] {
 const time=Date.parse(row.dateTimeUTC), top=row.tankLevelFeet, bottom=row.bottomLevelFeet, barrels=row.bblsTaken;
 if(!Number.isFinite(time)||top===null||bottom===null||!barrels||barrels<=0)return [];
 const matches=new Set<string>();
 for(const [key,p] of Object.entries(history)) {
  if(!p||p.wellName!==row.wellName||p.deleted===true||p.noLevel===true||p.source==='whatsapp_watchdog'||/^(edit_|delete_|history_)/.test(key))continue;
  if(driverId&&p.driverId&&p.driverId!==driverId)continue;
  const amount=Number(p.bblsTaken), at=Date.parse(p.dateTimeUTC||'');
  // Broad window accounts for measurement vs posting times; ambiguity must be reviewed.
  if(!Number.isFinite(at)||Math.abs(at-time)>6*3600000||amount<=barrels)continue;
  const ratio=amount/barrels;
  if(ratio<2||ratio>4||Math.abs(ratio-Math.round(ratio))>0.001)continue;
  const aggregateTop=Number(p.tankLevelFeet);
  const aggregateBottom=Number(p.tankAfterInches)/12;
  if(!Number.isFinite(aggregateTop)||!Number.isFinite(aggregateBottom))continue;
  if(top<=aggregateTop+1/12&&bottom>=aggregateBottom-1/12&&top>bottom)matches.add(p.packetId||key);
 }
 return [...matches].sort();
}
