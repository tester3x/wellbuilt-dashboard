import { hasIndependentDispatchPackage } from './independentDispatchPackage';

/** This document is server-owned and never writable by ordinary company users. */
export const OUTSIDE_DRIVER_ACCESS_COLLECTION = 'external_driver_company_access';

export function hasTemporaryOutsideDriverAccess(config: unknown): boolean {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const value = config as Record<string, unknown>;
  return value.schemaVersion === 1
    && value.enabled === true
    && value.mode === 'temporary_contractors';
}

export function externalDriverAccessMode(company: unknown, protectedConfig: unknown): 'independent_dispatch' | 'temporary_contractors' | null {
  if (hasIndependentDispatchPackage(company)) return 'independent_dispatch';
  return hasTemporaryOutsideDriverAccess(protectedConfig) ? 'temporary_contractors' : null;
}
