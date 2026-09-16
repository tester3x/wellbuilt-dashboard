/**
 * Pure testable CORE for the governed tenant dispatch job types write path.
 *
 * Supplies payload building and callable execution abstraction without
 * direct Firebase dependencies. Tested in unit tests with a mock invoker.
 */

import type { DispatchJobTypeConfig } from './dispatchJobTypesCore';

export const TENANT_UPDATE_DISPATCH_JOB_TYPES_CALLABLE = 'tenantUpdateDispatchJobTypes';

export interface TenantUpdateDispatchJobTypesPayload {
  companyId: string;
  dispatchJobTypes: DispatchJobTypeConfig;
}

export interface TenantUpdateDispatchJobTypesResult {
  ok: true;
  companyId: string;
  itemCount: number;
  updatedAtIso: string;
}

export type CallableInvoker<T> = (payload: unknown) => Promise<{ data: T }>;

export function buildTenantUpdateDispatchJobTypesPayload(
  companyId: string,
  dispatchJobTypes: DispatchJobTypeConfig,
): TenantUpdateDispatchJobTypesPayload {
  return {
    companyId: companyId.trim(),
    dispatchJobTypes,
  };
}

export async function runTenantUpdateDispatchJobTypes(
  invoke: CallableInvoker<TenantUpdateDispatchJobTypesResult>,
  companyId: string,
  dispatchJobTypes: DispatchJobTypeConfig,
): Promise<TenantUpdateDispatchJobTypesResult> {
  const payload = buildTenantUpdateDispatchJobTypesPayload(companyId, dispatchJobTypes);
  const res = await invoke(payload);
  return res.data;
}
