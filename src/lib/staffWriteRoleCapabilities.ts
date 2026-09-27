/**
 * Governed RolesCard writer. Never writes companies.roleCapabilities from
 * the client — Firestore denies that field. Company identity is derived
 * on the server from trusted staff authority.
 */
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';
import type { Capability, UserRole } from './auth';
import {
  STAFF_WRITE_ROLE_CAPABILITIES_CALLABLE,
  buildRoleEditorRequest,
  classifyRoleEditorError,
} from './staffWriteRoleCapabilitiesCore';

export {
  STAFF_WRITE_ROLE_CAPABILITIES_CALLABLE,
  ROLE_EDITOR_RESERVED_CAPABILITIES,
  buildRoleEditorRequest,
  classifyRoleEditorError,
} from './staffWriteRoleCapabilitiesCore';

export type RoleEditorPayload = {
  roleLabels: Partial<Record<UserRole, string>>;
  roleCapabilities: Partial<Record<UserRole, Capability[]>>;
};

export type RoleEditorResult = {
  ok: true;
  companyId: string;
  roleLabels: Record<string, string>;
  roleCapabilities: Record<string, string[]>;
};

export async function staffWriteRoleCapabilities(
  input: RoleEditorPayload,
  invoke?: (payload: ReturnType<typeof buildRoleEditorRequest>) => Promise<{ data: unknown }>,
): Promise<RoleEditorResult> {
  const payload = buildRoleEditorRequest({
    roleLabels: input.roleLabels as Record<string, string | undefined>,
    roleCapabilities: input.roleCapabilities as Record<string, string[] | undefined>,
  });
  const call = invoke ?? ((body) => {
    const fn = httpsCallable(getFirebaseFunctions(), STAFF_WRITE_ROLE_CAPABILITIES_CALLABLE);
    return fn(body) as Promise<{ data: unknown }>;
  });
  const res = await call(payload);
  return res.data as RoleEditorResult;
}
