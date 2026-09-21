import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';

export const STAFF_WRITE_DRIVER_ROSTER_CALLABLE = 'staffWriteDriverRoster';

export async function staffWriteDriverRoster(input: Record<string, unknown>): Promise<{
  ok: true;
  op: string;
  path: string;
  companyId: string;
}> {
  const fn = httpsCallable(getFirebaseFunctions(), STAFF_WRITE_DRIVER_ROSTER_CALLABLE);
  const res = await fn(input);
  return res.data as { ok: true; op: string; path: string; companyId: string };
}

export function classifyRosterError(err: unknown): string {
  const raw = err && typeof err === 'object' ? err as { message?: unknown } : null;
  const message = typeof raw?.message === 'string' && raw.message.trim()
    ? raw.message.trim()
    : 'Driver update failed. The change was not applied.';
  return message;
}
