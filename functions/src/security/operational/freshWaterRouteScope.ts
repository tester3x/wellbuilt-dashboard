export type FreshWaterRouteScope =
  | { ok: true; routes: Set<string> }
  | { ok: false; reason: 'fresh_water_routes_required' | 'fresh_water_routes_malformed' };

export function evaluateFreshWaterRouteScope(raw: unknown): FreshWaterRouteScope {
  if (!Array.isArray(raw)) return { ok: false, reason: 'fresh_water_routes_required' };
  if (!raw.every(route => typeof route === 'string' && route.trim())) {
    return { ok: false, reason: 'fresh_water_routes_malformed' };
  }
  return { ok: true, routes: new Set(raw.map(route => route.trim())) };
}

export function canAccessFreshWaterRoute(raw: unknown, routeName: string): boolean {
  const scope = evaluateFreshWaterRouteScope(raw);
  return scope.ok && scope.routes.has(routeName);
}
