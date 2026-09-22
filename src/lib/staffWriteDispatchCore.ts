/**
 * Firebase-free CORE for governed Dashboard dispatch writes.
 *
 * Holds the payload serialization (jsonSafe), the exact callable name, the
 * op-specific payload builders, and the runners that push a payload through an
 * injected invoker. The thin staffWriteDispatch.ts wrapper supplies the real
 * httpsCallable; tests supply a mock invoker and assert the wire contract by
 * actually executing this code.
 */

/** The deployed callable all three dispatch write ops target. */
export const STAFF_WRITE_DISPATCH_CALLABLE = 'staffWriteDispatch';

const SERVER_AUTHORITATIVE = new Set(['assignedAt', 'companyId']);
const DECLINE_FIELDS = new Set(['declinedAt', 'declineReason', 'declinedBy']);

function isTimestampLike(val: unknown): val is { toMillis: () => number } {
  return !!val && typeof val === 'object' && typeof (val as { toMillis?: unknown }).toMillis === 'function';
}

/**
 * Serialize a staff dispatch payload.
 * assignedAt/companyId are omitted so the server stamps/derives them.
 * Any other Timestamp-like value is serialized — never silently dropped.
 * Decline fields are rejected (server owns the decline lifecycle).
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

export type CallableInvoker = (payload: unknown) => Promise<{ data: unknown }>;

export function buildCreatePayload(record: Record<string, unknown>): Record<string, unknown> {
  const safe = jsonSafe(record);
  let dispatchId = typeof safe.id === 'string' && safe.id.trim()
    ? safe.id.trim()
    : (typeof safe.dispatchId === 'string' && safe.dispatchId.trim()
      ? safe.dispatchId.trim()
      : '');
  if (!dispatchId) {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      dispatchId = crypto.randomUUID();
    } else {
      dispatchId = 'disp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    }
  }

  const packageId = typeof safe.packageId === 'string' && safe.packageId.trim()
    ? safe.packageId.trim()
    : 'water-hauling';
  const revision = typeof safe.packetRevision === 'number' && Number.isInteger(safe.packetRevision) && safe.packetRevision > 0
    ? safe.packetRevision
    : 1;

  delete safe.id;
  delete safe.dispatchId;
  delete safe.packageId;
  delete safe.packetRevision;

  return {
    op: 'create',
    dispatchId,
    packetRef: { packageId, revision },
    record: safe,
  };
}
export function buildUpdatePayload(dispatchId: string, record: Record<string, unknown>): Record<string, unknown> {
  return { op: 'update', dispatchId, record: jsonSafe(record) };
}
export function buildCancelPayload(dispatchId: string): Record<string, unknown> {
  return { op: 'cancel', dispatchId };
}

export async function runCreateDispatch(invoke: CallableInvoker, record: Record<string, unknown>): Promise<{ dispatchId: string }> {
  const res = await invoke(buildCreatePayload(record));
  return res.data as { dispatchId: string };
}
export async function runUpdateDispatch(invoke: CallableInvoker, dispatchId: string, record: Record<string, unknown>): Promise<void> {
  await invoke(buildUpdatePayload(dispatchId, record));
}
export async function runCancelDispatch(invoke: CallableInvoker, dispatchId: string): Promise<void> {
  await invoke(buildCancelPayload(dispatchId));
}
