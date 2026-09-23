import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';
import {
  STAFF_WRITE_DISPATCH_CALLABLE,
  runCreateDispatch,
  runUpdateDispatch,
  runCancelDispatch,
  getGlobalCreationCoordinator,
  DispatchCreationCoordinator,
  ExecuteUnitOptions,
  BeginActionOptions,
} from './staffWriteDispatchCore';

export {
  jsonSafe,
  STAFF_WRITE_DISPATCH_CALLABLE,
  getGlobalCreationCoordinator,
  resetGlobalCreationCoordinator,
  DispatchCreationCoordinator,
  computeCreationUnitKey,
  materialBirthFieldsMatch,
  mintDispatchId,
  buildCreatePayload,
  buildUpdatePayload,
  buildCancelPayload,
  runCreateDispatch,
  runUpdateDispatch,
  runCancelDispatch,
} from './staffWriteDispatchCore';

export type {
  CallableInvoker,
  UnitStatus,
  ActionUnitState,
  ActionBatchState,
  CoordinatorOptions,
  BeginActionOptions,
  ExecuteUnitOptions,
  RetainedCreationRequest,
} from './staffWriteDispatchCore';

function invoker(): (payload: unknown) => Promise<{ data: unknown }> {
  const fn = httpsCallable(getFirebaseFunctions(), STAFF_WRITE_DISPATCH_CALLABLE);
  return (payload) => fn(payload) as Promise<{ data: unknown }>;
}

export async function staffCreateDispatch(
  record: Record<string, unknown>,
  options?: ExecuteUnitOptions & { coordinator?: DispatchCreationCoordinator }
): Promise<{ dispatchId: string }> {
  return runCreateDispatch(invoker(), record, options?.coordinator, options);
}

export function clearRetainedCreation(unitKeyOrActionId?: string, coordinator?: DispatchCreationCoordinator): void {
  (coordinator || getGlobalCreationCoordinator()).clear(unitKeyOrActionId);
}

/**
 * Scoped creation cancellation.
 * If actionScopeOrId is provided, cancels ONLY that action and its units.
 * Never wipes unrelated actions.
 */
export function cancelRetainedCreation(actionScopeOrId?: string, coordinator?: DispatchCreationCoordinator): void {
  const coord = coordinator || getGlobalCreationCoordinator();
  if (actionScopeOrId) {
    coord.cancelCreation(actionScopeOrId);
  } else {
    coord.clearAll();
  }
}

export function isCreationInFlight(unitKeyOrActionId?: string, coordinator?: DispatchCreationCoordinator): boolean {
  return (coordinator || getGlobalCreationCoordinator()).isInFlight(unitKeyOrActionId);
}

export function prepareDispatchCreation(
  record: Record<string, unknown>,
  options?: { unitKey?: string; actionId?: string; actionScope?: string; coordinator?: DispatchCreationCoordinator }
): { dispatchId: string; unitKey: string } {
  return (options?.coordinator || getGlobalCreationCoordinator()).prepareCreation(record, options);
}

export function beginDispatchAction(options?: BeginActionOptions, coordinator?: DispatchCreationCoordinator): string {
  return (coordinator || getGlobalCreationCoordinator()).beginAction(options);
}

export function finalizeDispatchAction(actionId: string, coordinator?: DispatchCreationCoordinator): void {
  (coordinator || getGlobalCreationCoordinator()).finalizeAction(actionId);
}

export function cancelDispatchAction(actionId: string, coordinator?: DispatchCreationCoordinator): void {
  (coordinator || getGlobalCreationCoordinator()).cancelAction(actionId);
}

export async function retryDispatchAction(actionId: string, coordinator?: DispatchCreationCoordinator): Promise<Array<{ dispatchId: string }>> {
  return (coordinator || getGlobalCreationCoordinator()).retryAction(actionId, invoker());
}

export function resetAuthenticatedSession(tenantId?: string, userId?: string, coordinator?: DispatchCreationCoordinator): void {
  (coordinator || getGlobalCreationCoordinator()).resetAuthenticatedSession(tenantId, userId);
}

export async function staffUpdateDispatch(dispatchId: string, record: Record<string, unknown>): Promise<void> {
  return runUpdateDispatch(invoker(), dispatchId, record);
}

export async function staffCancelDispatch(dispatchId: string): Promise<void> {
  return runCancelDispatch(invoker(), dispatchId);
}