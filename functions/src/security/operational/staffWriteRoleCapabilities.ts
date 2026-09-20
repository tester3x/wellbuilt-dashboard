/**
 * Governed company roleLabels / roleCapabilities write (G-008R2).
 * Authority is requireTrustedCompanyCapability(manageRolesAndCapabilities).
 * Company identity is server-derived. The map being edited is never the
 * authority source.
 */
import { fail, type StoreResult } from './jobPacketRevisionStore';
import {
  RESERVED_TRUSTED_CAPABILITIES,
  TRUSTED_CAPABILITY_ALLOWLIST,
  TRUSTED_USER_ROLES,
  type TrustedCompanyAuthority,
} from '../trustedStaffAuthority';

export const STAFF_WRITE_ROLE_CAPABILITIES_CALLABLE = 'staffWriteRoleCapabilities';

export const ROLE_EDITOR_REQUEST_KEYS = Object.freeze([
  'roleLabels',
  'roleCapabilities',
] as const);

export const ROLE_EDITOR_FORBIDDEN_KEYS = Object.freeze([
  'companyId',
  'targetCompanyId',
  'publisherUid',
  'publishedByUid',
  'uid',
  'role',
  'roles',
  'capabilities',
  'manageDrivers',
  'manageRolesAndCapabilities',
  'platformAdmin',
  'wellbuiltAdmin',
  'isPlatformAdmin',
  'schemaVersion',
] as const);

const ROLE_SET = new Set<string>(TRUSTED_USER_ROLES);
const CAP_SET = new Set<string>(TRUSTED_CAPABILITY_ALLOWLIST);
const RESERVED_SET = new Set<string>(RESERVED_TRUSTED_CAPABILITIES);
const REQUEST_KEY_SET = new Set<string>(ROLE_EDITOR_REQUEST_KEYS);
const FORBIDDEN_KEY_SET = new Set<string>(ROLE_EDITOR_FORBIDDEN_KEYS);

const MAX_LABEL_LENGTH = 60;
const MAX_ROLES = TRUSTED_USER_ROLES.length;
const MAX_CAPS_PER_ROLE = TRUSTED_CAPABILITY_ALLOWLIST.length;

export type CanonicalRoleLabels = Record<string, string>;
export type CanonicalRoleCapabilities = Record<string, string[]>;

export type RoleEditorStoreTx = {
  getCompany(companyId: string): Promise<Record<string, unknown> | null>;
  updateCompany(companyId: string, fields: Record<string, unknown>): void;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejectDangerousKeys(obj: object, field: string): StoreResult<{ ok: true }> {
  if (Object.getOwnPropertySymbols(obj).length) return fail('symbol_key', field);
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      return fail('forbidden_key', `${field}.${key}`);
    }
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc || desc.get !== undefined || desc.set !== undefined) {
      return fail('accessor_forbidden', `${field}.${key}`);
    }
    if (typeof desc.value === 'function' || desc.value === undefined) {
      return fail('unsupported_type', `${field}.${key}`);
    }
  }
  return { ok: true };
}

function canonicalizeLabels(raw: unknown): StoreResult<{ value: CanonicalRoleLabels }> {
  if (!isPlainObject(raw)) return fail('record_must_be_object', 'roleLabels');
  const danger = rejectDangerousKeys(raw, 'roleLabels');
  if (!danger.ok) return danger;
  const keys = Object.getOwnPropertyNames(raw);
  if (keys.length > MAX_ROLES) return fail('too_many_roles', 'roleLabels');
  const out: CanonicalRoleLabels = {};
  const sorted = [...keys].sort();
  for (const role of sorted) {
    if (!ROLE_SET.has(role)) return fail('unknown_role', `roleLabels.${role}`);
    const label = raw[role];
    if (typeof label !== 'string') return fail('malformed_label', `roleLabels.${role}`);
    const trimmed = label.trim();
    if (!trimmed || trimmed !== label) return fail('malformed_label', `roleLabels.${role}`);
    if (trimmed.length > MAX_LABEL_LENGTH) return fail('label_too_long', `roleLabels.${role}`);
    out[role] = trimmed;
  }
  return { ok: true, value: out };
}

function readDenseCaps(raw: unknown, field: string): StoreResult<{ values: string[] }> {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) {
    return fail('malformed_capabilities', field);
  }
  if (raw.length > MAX_CAPS_PER_ROLE) return fail('too_many_capabilities', field);
  if (Object.getOwnPropertySymbols(raw).length) return fail('symbol_key', field);
  const descs = Object.getOwnPropertyDescriptors(raw);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const d = descs[i];
    if (!d) return fail('sparse_array', `${field}[${i}]`);
    if (d.get !== undefined || d.set !== undefined) return fail('accessor_forbidden', `${field}[${i}]`);
    if (typeof d.value !== 'string') return fail('malformed_capabilities', `${field}[${i}]`);
    if (!Object.prototype.hasOwnProperty.call(raw, i)) return fail('sparse_array', `${field}[${i}]`);
    const cap = d.value;
    if (!cap || cap !== cap.trim()) return fail('malformed_capabilities', `${field}[${i}]`);
    if (RESERVED_SET.has(cap)) return fail('reserved_capability', `${field}[${i}]`);
    if (!CAP_SET.has(cap)) return fail('unknown_capability', `${field}[${i}]`);
    if (seen.has(cap)) return fail('duplicate_capability', `${field}[${i}]`);
    seen.add(cap);
    out.push(cap);
  }
  out.sort();
  return { ok: true, values: out };
}

function canonicalizeCapabilities(raw: unknown): StoreResult<{ value: CanonicalRoleCapabilities }> {
  if (!isPlainObject(raw)) return fail('record_must_be_object', 'roleCapabilities');
  const danger = rejectDangerousKeys(raw, 'roleCapabilities');
  if (!danger.ok) return danger;
  const keys = Object.getOwnPropertyNames(raw);
  if (keys.length > MAX_ROLES) return fail('too_many_roles', 'roleCapabilities');
  const out: CanonicalRoleCapabilities = {};
  const sorted = [...keys].sort();
  for (const role of sorted) {
    if (!ROLE_SET.has(role)) return fail('unknown_role', `roleCapabilities.${role}`);
    const caps = readDenseCaps(raw[role], `roleCapabilities.${role}`);
    if (!caps.ok) return caps;
    out[role] = caps.values;
  }
  return { ok: true, value: out };
}

export function parseRoleEditorRequest(raw: unknown): StoreResult<{
  roleLabels: CanonicalRoleLabels;
  roleCapabilities: CanonicalRoleCapabilities;
}> {
  if (!isPlainObject(raw)) return fail('record_must_be_object', 'request');
  const danger = rejectDangerousKeys(raw, 'request');
  if (!danger.ok) return danger;
  const keys = Object.getOwnPropertyNames(raw);
  for (const key of keys) {
    if (FORBIDDEN_KEY_SET.has(key)) return fail('caller_authority_field', key);
    if (!REQUEST_KEY_SET.has(key)) return fail('unknown_field', key);
  }
  for (const required of ROLE_EDITOR_REQUEST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, required)) {
      return fail('missing_field', required);
    }
  }
  const labels = canonicalizeLabels(raw.roleLabels);
  if (!labels.ok) return labels;
  const caps = canonicalizeCapabilities(raw.roleCapabilities);
  if (!caps.ok) return caps;
  return { ok: true, roleLabels: labels.value, roleCapabilities: caps.value };
}

export async function runStaffWriteRoleCapabilities(input: {
  authority: TrustedCompanyAuthority | null;
  request: unknown;
  store: RoleEditorStoreTx;
}): Promise<StoreResult<{
  companyId: string;
  roleLabels: CanonicalRoleLabels;
  roleCapabilities: CanonicalRoleCapabilities;
}>> {
  if (!input.authority?.uid) return fail('unauthenticated');
  const companyId = typeof input.authority.companyId === 'string'
    ? input.authority.companyId.trim()
    : '';
  if (!companyId) return fail('missing_company', 'companyId');
  const parsed = parseRoleEditorRequest(input.request);
  if (!parsed.ok) return parsed;
  const existing = await input.store.getCompany(companyId);
  if (!existing) return fail('company_not_found', 'companyId');
  input.store.updateCompany(companyId, {
    roleLabels: parsed.roleLabels,
    roleCapabilities: parsed.roleCapabilities,
  });
  return {
    ok: true,
    companyId,
    roleLabels: parsed.roleLabels,
    roleCapabilities: parsed.roleCapabilities,
  };
}
