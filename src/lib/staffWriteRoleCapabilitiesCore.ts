export const STAFF_WRITE_ROLE_CAPABILITIES_CALLABLE = 'staffWriteRoleCapabilities';

export const ROLE_EDITOR_RESERVED_CAPABILITIES = Object.freeze([
  'viewAllCompanies',
  'viewTruthDebug',
  'viewDiagnostics',
] as const);

const RESERVED = new Set<string>(ROLE_EDITOR_RESERVED_CAPABILITIES);

export type RoleEditorRequest = {
  roleLabels: Record<string, string>;
  roleCapabilities: Record<string, string[]>;
};

export function buildRoleEditorRequest(input: {
  roleLabels: Record<string, string | undefined>;
  roleCapabilities: Record<string, string[] | undefined>;
}): RoleEditorRequest {
  const roleLabels: Record<string, string> = {};
  for (const role of Object.keys(input.roleLabels)) {
    const label = input.roleLabels[role];
    if (typeof label === 'string') roleLabels[role] = label;
  }
  const roleCapabilities: Record<string, string[]> = {};
  for (const role of Object.keys(input.roleCapabilities)) {
    const caps = input.roleCapabilities[role];
    if (!Array.isArray(caps)) continue;
    roleCapabilities[role] = caps.filter((cap) => !RESERVED.has(cap));
  }
  return { roleLabels, roleCapabilities };
}

export function classifyRoleEditorError(err: unknown): string {
  const raw = err && typeof err === 'object' ? err as { message?: unknown } : null;
  const message = typeof raw?.message === 'string' && raw.message.trim()
    ? raw.message.trim()
    : 'Save failed. The change was not applied.';
  return message;
}
