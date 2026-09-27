import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';
import type { UserRole } from './auth';

export const STAFF_WRITE_USER_ROLES_CALLABLE = 'staffWriteUserRoles';

export async function staffWriteUserRoles(input: {
  targetUid: string;
  roles: UserRole[];
}): Promise<{ ok: true; targetUid: string; companyId: string; roles: string[]; role: string }> {
  const fn = httpsCallable(getFirebaseFunctions(), STAFF_WRITE_USER_ROLES_CALLABLE);
  const res = await fn({
    targetUid: input.targetUid,
    roles: input.roles,
  });
  return res.data as { ok: true; targetUid: string; companyId: string; roles: string[]; role: string };
}

export function classifyUserRolesError(err: unknown): string {
  const raw = err && typeof err === 'object' ? err as { message?: unknown } : null;
  const message = typeof raw?.message === 'string' && raw.message.trim()
    ? raw.message.trim()
    : 'Role update failed. The change was not applied.';
  return message;
}
