import { canAccessFreshWaterRoute, evaluateFreshWaterRouteScope } from '../freshWaterRouteScope';

describe('freshwater route assignment isolation', () => {
  it('does not treat produced-water assignments as freshwater access', () => {
    const producedOnlyProfile = { assignedRoutes: ['Gabriels'], assignedWells: [] };
    expect(canAccessFreshWaterRoute((producedOnlyProfile as Record<string, unknown>).assignedFreshWaterRoutes, "Gabriel's FW")).toBe(false);
  });

  it('supports freshwater-only and mixed-type testers without widening either scope', () => {
    expect(canAccessFreshWaterRoute(["Gabriel's FW"], "Gabriel's FW")).toBe(true);
    expect(canAccessFreshWaterRoute(["Gabriel's FW"], 'Other FW')).toBe(false);
    const mixed = { assignedRoutes: ['Gabriels'], assignedFreshWaterRoutes: ["Gabriel's FW"] };
    expect(canAccessFreshWaterRoute(mixed.assignedFreshWaterRoutes, "Gabriel's FW")).toBe(true);
    expect(mixed.assignedRoutes).toEqual(['Gabriels']);
  });

  it('rejects missing or malformed freshwater assignment data', () => {
    expect(evaluateFreshWaterRouteScope(undefined)).toEqual({ ok: false, reason: 'fresh_water_routes_required' });
    expect(evaluateFreshWaterRouteScope([''])).toEqual({ ok: false, reason: 'fresh_water_routes_malformed' });
  });
});
