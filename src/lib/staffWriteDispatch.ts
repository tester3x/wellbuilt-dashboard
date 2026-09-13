/**
 * Governed Dashboard dispatch writes (thin Firebase wrapper).
 * The testable wire contract lives in staffWriteDispatchCore.ts.
 */
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';
import {
  STAFF_WRITE_DISPATCH_CALLABLE,
  runCreateDispatch,
  runUpdateDispatch,
  runCancelDispatch,
} from './staffWriteDispatchCore';

export { jsonSafe, STAFF_WRITE_DISPATCH_CALLABLE } from './staffWriteDispatchCore';

function invoker(): (payload: unknown) => Promise<{ data: unknown }> {
  const fn = httpsCallable(getFirebaseFunctions(), STAFF_WRITE_DISPATCH_CALLABLE);
  return (payload) => fn(payload) as Promise<{ data: unknown }>;
}

export async function staffCreateDispatch(record: Record<string, unknown>): Promise<{ dispatchId: string }> {
  return runCreateDispatch(invoker(), record);
}

export async function staffUpdateDispatch(dispatchId: string, record: Record<string, unknown>): Promise<void> {
  return runUpdateDispatch(invoker(), dispatchId, record);
}

export async function staffCancelDispatch(dispatchId: string): Promise<void> {
  return runCancelDispatch(invoker(), dispatchId);
}
