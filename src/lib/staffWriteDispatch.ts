import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';

const SERVER_AUTHORITATIVE = new Set(['assignedAt', 'companyId']);
const DECLINE_FIELDS = new Set(['declinedAt', 'declineReason', 'declinedBy']);

function isTimestampLike(val: unknown): val is { toMillis: () => number } {
  return !!val && typeof val === 'object' && typeof (val as { toMillis?: unknown }).toMillis === 'function';
}

/**
 * Serialize a staff dispatch payload.
 * assignedAt is omitted so the server stamps it.
 * Any other Timestamp-like value is serialized — never silently dropped.
 * Decline fields are rejected.
 */
export function jsonSafe(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record)) {
    if (val === undefined) continue;
    if (DECLINE_FIELDS.has(key)) {
      throw new Error(`decline_fields_immutable:${key}`);
    }
    if (isTimestampLike(val)) {
      if (SERVER_AUTHORITATIVE.has(key)) continue;
      const ms = val.toMillis();
      out[key] = { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 };
      continue;
    }
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
