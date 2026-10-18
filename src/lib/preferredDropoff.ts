/** Historical preference is a convenience, never dispatch authority. Only completed
 * jobs in the viewed company and currently selectable SWDs can contribute. */
export function preferredDropoff<T extends {well_name:string;kind?:string}>(input:{companyId:string;wellNames:string[];operator:string;catalog:T[];jobs:ReadonlyArray<{id?:string;companyId?:string;wellName?:string;operator?:string;status:string;disposal?:string;hauledTo?:string;disposalName?:string;assignedAt?:unknown}>}):T|null {
 const key=(v:unknown)=>typeof v==='string'?v.trim().toLowerCase().replace(/\s+/g,' '):'';
 const names=new Set(input.wellNames.map(key));
 const catalog=new Map(input.catalog.filter(c=>c.kind==='SWD').map(c=>[key(c.well_name),c]));
 const seen=new Set<string>();
 const jobs=input.jobs.filter(j=>{
  if(j.companyId!==input.companyId||j.status!=='completed'||!catalog.has(key(j.disposal||j.hauledTo||j.disposalName)))return false;
  if(j.id){if(seen.has(j.id))return false;seen.add(j.id);}return true;
 });
 const matching=[jobs.filter(j=>names.size&&names.has(key(j.wellName))),jobs.filter(j=>input.operator&&key(j.operator)===key(input.operator)),jobs];
 for(const group of matching){
  if(!group.length)continue;
  const scores=new Map<string,{count:number;recent:number}>();
  for(const job of group){const name=key(job.disposal||job.hauledTo||job.disposalName),s=scores.get(name)||{count:0,recent:0};s.count++;const at=Date.parse(String(job.assignedAt||''));s.recent=Math.max(s.recent,Number.isFinite(at)?at:0);scores.set(name,s);}
  const best=[...scores].sort(([a,x],[b,y])=>y.count-x.count||y.recent-x.recent||a.localeCompare(b))[0];
  return catalog.get(best[0])||null;
 }
 return null;
}
