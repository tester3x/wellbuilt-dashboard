import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';

function jsonSafe(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record)) {
    if (val === undefined) continue;
    if (val && typeof val === 'object' && typeof (val as { toMillis?: unknown }).toMillis === 'function') continue;
    out[key] = val;
  }
  return out;
}

export async function staffCreateDispatch(record: Record<string, unknown>): Promise<{ dispatchId: string }> {
  const fn = httpsCallable(getFirebaseFunctions(), 'staffWriteDispatch');
  const res = await fn({ op: 'create', record: jsonSafe(record) });
  return res.data as { dispatchId: string };
}

export async function staffUpdateDispatch(dispatchId: string, record: Record<string, unknown>): Promise<void> {
  const fn = httpsCallable(getFirebaseFunctions(), 'staffWriteDispatch');
  await fn({ op: 'update', dispatchId, record: jsonSafe(record) });
}

export async function staffCancelDispatch(dispatchId: string): Promise<void> {
  const fn = httpsCallable(getFirebaseFunctions(), 'staffWriteDispatch');
  await fn({ op: 'cancel', dispatchId });
}
