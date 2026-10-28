import type { WellResponse } from './wellPoolCore';
export type WaterFamily = 'produced-water' | 'freshwater';
export const waterFamily = (well: WellResponse): WaterFamily => well.routeType === 'freshwater' ? 'freshwater' : 'produced-water';
export const waterRouteName = (well: WellResponse) => well.route?.trim() || 'Unrouted';
export const familyRouteKey = (family: WaterFamily, route: string) => JSON.stringify([family,route]);
/** Filter physical records before deriving names: equal route names never share members. */
export function waterRouteFamilies(wells: WellResponse[], search = '') {
 const query=search.trim().toLowerCase();
 const family=(type:WaterFamily)=>{
  const members=wells.filter(w=>waterFamily(w)===type && (!query || [w.wellName,w.displayName].some(n=>n?.toLowerCase().includes(query))));
  const names=[...new Set(members.map(waterRouteName))];
  if(type==='produced-water' && !query && !names.includes('Unrouted'))names.push('Unrouted');
  return names.map(route=>({key:familyRouteKey(type,route),route,wells:members.filter(w=>waterRouteName(w)===route)}));
 };
 return {'produced-water':family('produced-water'),freshwater:family('freshwater')};
}
