import { evaluateWbmWellScope, wellBelongsToDriverCompany, wellMatchesWbmScope } from './wbmWellScope';

export function canManageWellStatus(profile: Record<string, any>, companyId: string, key: string, config: Record<string, any>): boolean {
  if (profile.active === false || profile.companyId !== companyId || !wellBelongsToDriverCompany(config, companyId)) return false;
  const scope = evaluateWbmWellScope(profile.assignedRoutes, profile.assignedWells);
  return scope.ok && wellMatchesWbmScope(key, config, scope);
}
export function statusIntent(raw: any): { operationId: string; wellConfigKey: string; expectedDown: boolean; down: boolean } {
  if (!raw || !/^[a-zA-Z0-9_-]{12,100}$/.test(raw.operationId || '')
    || typeof raw.wellConfigKey !== 'string' || !raw.wellConfigKey.trim() || raw.wellConfigKey.length > 120
    || /[.#$\[\]/]/.test(raw.wellConfigKey) || typeof raw.expectedDown !== 'boolean' || typeof raw.down !== 'boolean'
    || raw.expectedDown === raw.down) throw Error('Invalid well status change');
  return { operationId: raw.operationId, wellConfigKey: raw.wellConfigKey, expectedDown: raw.expectedDown, down: raw.down };
}
