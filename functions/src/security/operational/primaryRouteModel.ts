import type { Row } from './tankInfoModel';
export function primaryRouteUpdate(profile: Row, companyId: string, data: Row, actor: string, now: number): Row {
  if (profile.companyId !== companyId || profile.active === false) throw Error('driver_unavailable');
  if (!Array.isArray(data.primaryRoutes) || data.primaryRoutes.length > 100
    || data.primaryRoutes.some((r: unknown) => typeof r !== 'string' || !r.trim() || r.length > 100)
    || typeof data.primaryAllRoutes !== 'boolean' || !Number.isSafeInteger(data.expectedRevision) || data.expectedRevision < 0)
    throw Error('invalid_primary_routes');
  const routes = [...new Set(data.primaryRoutes as string[])].sort();
  if (routes.some(r => !Array.isArray(profile.assignedRoutes) || !profile.assignedRoutes.includes(r)))
    throw Error('primary_route_not_assigned');
  const revision = Number(profile.primaryRouteRevision || 0);
  if (revision !== data.expectedRevision) {
    if (revision === data.expectedRevision + 1 && profile.primaryAllRoutes === data.primaryAllRoutes
      && JSON.stringify([...(profile.primaryRoutes || [])].sort()) === JSON.stringify(routes)) return profile;
    throw Error('primary_routes_changed');
  }
  return { ...profile, primaryRoutes: routes, primaryAllRoutes: data.primaryAllRoutes,
    primaryRouteRevision: revision + 1, primaryRouteUpdatedAt: now, primaryRouteUpdatedBy: actor,
    primaryRouteAudit: { ...profile.primaryRouteAudit, [String(revision + 1)]: { at: now, actor,
      before: { primaryRoutes: profile.primaryRoutes || [], primaryAllRoutes: profile.primaryAllRoutes === true },
      after: { primaryRoutes: routes, primaryAllRoutes: data.primaryAllRoutes } } } };
}
