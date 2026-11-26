import { wellBelongsToDriverCompany, isRealRouteName } from './wbmWellScope';

export function canManageWellStatus(profile: Record<string, any>, companyId: string, key: string, config: Record<string, any>): boolean {
  if (profile.active === false || profile.isViewer === true || profile.companyId !== companyId || !wellBelongsToDriverCompany(config, companyId)) return false;
  void key; // Individual well visibility is not route ownership.
  return typeof config.route === 'string' && isRealRouteName(config.route)
    && Array.isArray(profile.assignedRoutes)
    && profile.assignedRoutes.every((route: unknown) => typeof route === 'string')
    && profile.assignedRoutes.includes(config.route)
    // Assignment permits route access; explicit company primary grants permit
    // Up/Down changes. Multiple drivers may hold the same route grant.
    && (profile.primaryAllRoutes === true || (Array.isArray(profile.primaryRoutes)
      && profile.primaryRoutes.every((route: unknown) => typeof route === 'string')
      && profile.primaryRoutes.includes(config.route)));
}
export function statusIntent(raw: any): { operationId: string; wellConfigKey: string; expectedDown: boolean; down: boolean } {
  if (!raw || !/^[a-zA-Z0-9_-]{12,100}$/.test(raw.operationId || '')
    || typeof raw.wellConfigKey !== 'string' || !raw.wellConfigKey.trim() || raw.wellConfigKey.length > 120
    || /[.#$\[\]/]/.test(raw.wellConfigKey) || typeof raw.expectedDown !== 'boolean' || typeof raw.down !== 'boolean'
    || raw.expectedDown === raw.down) throw Error('Invalid well status change');
  return { operationId: raw.operationId, wellConfigKey: raw.wellConfigKey, expectedDown: raw.expectedDown, down: raw.down };
}
