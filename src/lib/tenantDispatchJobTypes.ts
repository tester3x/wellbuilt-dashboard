/**
 * Governed tenant dispatch job types write client (thin Firebase wrapper).
 * The testable wire contract lives in tenantDispatchJobTypesCore.ts.
 */

import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';
import {
  TENANT_UPDATE_DISPATCH_JOB_TYPES_CALLABLE,
  runTenantUpdateDispatchJobTypes,
  type TenantUpdateDispatchJobTypesResult,
} from './tenantDispatchJobTypesCore';
import type { DispatchJobTypeConfig } from './dispatchJobTypesCore';

export {
  TENANT_UPDATE_DISPATCH_JOB_TYPES_CALLABLE,
  buildTenantUpdateDispatchJobTypesPayload,
} from './tenantDispatchJobTypesCore';
export type {
  TenantUpdateDispatchJobTypesPayload,
  TenantUpdateDispatchJobTypesResult,
} from './tenantDispatchJobTypesCore';

export async function tenantUpdateDispatchJobTypes(
  companyId: string,
  dispatchJobTypes: DispatchJobTypeConfig,
): Promise<TenantUpdateDispatchJobTypesResult> {
  const fn = httpsCallable(getFirebaseFunctions(), TENANT_UPDATE_DISPATCH_JOB_TYPES_CALLABLE);
  return runTenantUpdateDispatchJobTypes(
    (payload) => fn(payload) as Promise<{ data: TenantUpdateDispatchJobTypesResult }>,
    companyId,
    dispatchJobTypes,
  );
}
