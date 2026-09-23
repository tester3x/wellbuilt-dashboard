import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';
import {
  STAFF_WRITE_DISPATCH_CALLABLE,
  runCreateDispatch,
  runUpdateDispatch,
  runCancelDispatch,
  getGlobalCreationCoordinator,
  DispatchCreationCoordinator,
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
} from './staffWriteDispatchCore';

function invoker(): (payload: unknown) => Promise<{ data: unknown }> {
  const fn = httpsCallable(getFirebaseFunctions(), STAFF_WRITE_DISPATCH_CALLABLE);
  return (payload) => fn(payload) as Promise<{ data: unknown }>;
}

export async function staffCreateDispatch(
  record: Record<string, unknown>,
  options?: { unitKey?: string; coordinator?: DispatchCreationCoordinator }
): Promise<{ dispatchId: string }> {
  return runCreateDispatch(invoker(), record, options?.coordinator, options);
}

export function clearRetainedCreation(unitKey?: string): void {
  getGlobalCreationCoordinator().clear(unitKey);
}

export function cancelRetainedCreation(): void {
  getGlobalCreationCoordinator().clearAll();
}

export function isCreationInFlight(unitKey?: string): boolean {
  return getGlobalCreationCoordinator().isInFlight(unitKey);
}

export function prepareDispatchCreation(
  record: Record<string, unknown>,
  options?: { unitKey?: string }
): { dispatchId: string; unitKey: string } {
  return getGlobalCreationCoordinator().prepareCreation(record, options);
}

export async function staffUpdateDispatch(dispatchId: string, record: Record<string, unknown>): Promise<void> {
  return runUpdateDispatch(invoker(), dispatchId, record);
}

export async function staffCancelDispatch(dispatchId: string): Promise<void> {
  return runCancelDispatch(invoker(), dispatchId);
}
