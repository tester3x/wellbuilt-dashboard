/**
 * Company-scoped trusted staff authority (G-008R2).
 *
 * Dashboard staff Auth custom claims do not carry a server-issued,
 * company-bound capability. Driver claims are driver-only. wellbuiltAdmin
 * is unscoped platform-admin and is forbidden as a publication/editor
 * shortcut. This helper therefore reads a server-owned Firestore record
 * that ordinary clients cannot create, change, delete, merge, or substitute.
 *
 * Never consults RTDB users/{uid}.role, users/{uid}.roles,
 * users/{uid}.companyId, companies.roleCapabilities, caller-supplied
 * company/role/capability fields, or UI state.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';

export const TRUSTED_STAFF_AUTHORITY_COLLECTION = 'trusted_staff_authority' as const;
export const TRUSTED_STAFF_AUTHORITY_SCHEMA_VERSION = 1 as const;

export const TRUSTED_CAPABILITY_MANAGE_DRIVERS = 'manageDrivers' as const;
export const TRUSTED_CAPABILITY_MANAGE_ROLES = 'manageRolesAndCapabilities' as const;

/** Capabilities that may appear on a trusted staff-authority record. */
export const TRUSTED_CAPABILITY_ALLOWLIST = Object.freeze([
  'viewHome',
  'viewMobile',
  'viewTickets',
  'viewDispatch',
  'viewBilling',
  'viewPayroll',
  'viewDriverLogs',
  'viewSafety',
  'viewSettings',
  'viewAdmin',
  'viewChat',
  'createDispatch',
  'manageDrivers',
  'manageCompany',
  'editBilling',
  'approvePayroll',
  'manageWells',
  'manageRoutes',
  'viewEQuipment',
  'manageEquipment',
  'manageEquipmentAssignments',
  'viewDVIR',
  'manageDVIR',
  'viewEquipmentDocuments',
  'manageEquipmentDocuments',
  'sendChat',
  'manageSafety',
  'manageRolesAndCapabilities',
] as const);

/** Platform-admin / reserved identifiers — never a trusted grant. */
export const RESERVED_TRUSTED_CAPABILITIES = Object.freeze([
  'viewAllCompanies',
  'viewTruthDebug',
  'viewDiagnostics',
  'platformAdmin',
  'wellbuiltAdmin',
] as const);

export const TRUSTED_USER_ROLES = Object.freeze([
  'driver',
  'viewer',
  'dispatch',
  'payroll',
  'manager',
  'admin',
  'it',
  'safety',
  'lead',
] as const);

const ALLOWLIST_SET = new Set<string>(TRUSTED_CAPABILITY_ALLOWLIST);
const RESERVED_SET = new Set<string>(RESERVED_TRUSTED_CAPABILITIES);
const RECORD_KEYS = Object.freeze([
  'schemaVersion',
  'uid',
  'companyId',
  'active',
  'capabilities',
] as const);
const RECORD_KEY_SET = new Set<string>(RECORD_KEYS);

const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const COMPANY_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_CAPABILITIES = TRUSTED_CAPABILITY_ALLOWLIST.length;

export type TrustedCompanyAuthority = {
  uid: string;
  companyId: string;
};

export type TrustedStaffAuthorityRecord = {
  schemaVersion: 1;
  uid: string;
  companyId: string;
  active: true;
  capabilities: string[];
};

export type TrustedAuthorityFailure = { ok: false; reason: string; field?: string };
export type TrustedAuthoritySuccess<T> = { ok: true } & T;
export type TrustedAuthorityResult<T> = TrustedAuthoritySuccess<T> | TrustedAuthorityFailure;

export type TrustedAuthorityDeps = {
  getRecord(uid: string): Promise<unknown | null>;
};

function deny(reason: string, field?: string): TrustedAuthorityFailure {
  return field ? { ok: false, reason, field } : { ok: false, reason };
}

function ownKeys(value: object): string[] {
  return Object.getOwnPropertyNames(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejectForbiddenObjectKeys(value: object): TrustedAuthorityFailure | null {
  const names = ownKeys(value);
  for (const key of names) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      return deny('trusted_authority_malformed', key);
    }
  }
  if (Object.getOwnPropertySymbols(value).length) {
    return deny('trusted_authority_malformed', 'symbol');
  }
  return null;
}

function readDenseStringArray(raw: unknown, field: string): TrustedAuthorityResult<{ values: string[] }> {
  if (!Array.isArray(raw)) return deny('trusted_authority_malformed', field);
  if (Object.getPrototypeOf(raw) !== Array.prototype) {
    return deny('trusted_authority_malformed', field);
  }
  if (raw.length > MAX_CAPABILITIES) return deny('trusted_authority_malformed', field);
  const symbols = Object.getOwnPropertySymbols(raw);
  if (symbols.length) return deny('trusted_authority_malformed', field);
  const descs = Object.getOwnPropertyDescriptors(raw);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const d = descs[i];
    if (!d) return deny('trusted_authority_malformed', `${field}[${i}]`);
    if (d.get !== undefined || d.set !== undefined) {
      return deny('trusted_authority_malformed', `${field}[${i}]`);
    }
    if (typeof d.value !== 'string') return deny('trusted_authority_malformed', `${field}[${i}]`);
    if (!Object.prototype.hasOwnProperty.call(raw, i)) {
      return deny('trusted_authority_malformed', `${field}[${i}]`);
    }
    const cap = d.value;
    if (!cap || cap !== cap.trim() || cap.length > 64) {
      return deny('trusted_authority_malformed', `${field}[${i}]`);
    }
    if (RESERVED_SET.has(cap)) return deny('reserved_capability', `${field}[${i}]`);
    if (!ALLOWLIST_SET.has(cap)) return deny('unknown_capability', `${field}[${i}]`);
    if (seen.has(cap)) return deny('duplicate_capability', `${field}[${i}]`);
    seen.add(cap);
    out.push(cap);
  }
  return { ok: true, values: out };
}

/**
 * Exact-schema parse. Malformed, partial, extra, reserved, or unknown
 * records fail closed. Document UID must equal authenticated UID.
 */
export function parseTrustedStaffAuthorityRecord(
  raw: unknown,
  expectedUid: string,
): TrustedAuthorityResult<TrustedStaffAuthorityRecord> {
  if (raw === undefined || raw === null) return deny('no_trusted_authority_record');
  if (!isPlainObject(raw)) return deny('trusted_authority_malformed', 'record');
  const forbidden = rejectForbiddenObjectKeys(raw);
  if (forbidden) return forbidden;
  const keys = ownKeys(raw);
  if (keys.length !== RECORD_KEYS.length) return deny('trusted_authority_malformed', 'record');
  for (const key of keys) {
    if (!RECORD_KEY_SET.has(key)) return deny('trusted_authority_malformed', key);
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (!desc || desc.get !== undefined || desc.set !== undefined) {
      return deny('trusted_authority_malformed', key);
    }
    if (typeof desc.value === 'function' || desc.value === undefined) {
      return deny('trusted_authority_malformed', key);
    }
  }
  for (const required of RECORD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, required)) {
      return deny('trusted_authority_malformed', required);
    }
  }

  if (raw.schemaVersion !== TRUSTED_STAFF_AUTHORITY_SCHEMA_VERSION) {
    return deny('trusted_authority_malformed', 'schemaVersion');
  }
  if (typeof raw.uid !== 'string' || !UID_RE.test(raw.uid) || raw.uid.includes('/')) {
    return deny('trusted_authority_malformed', 'uid');
  }
  if (raw.uid !== expectedUid) return deny('trusted_authority_uid_mismatch', 'uid');
  if (typeof raw.active !== 'boolean') return deny('trusted_authority_malformed', 'active');
  if (raw.active !== true) return deny('trusted_authority_inactive', 'active');

  const companyId = typeof raw.companyId === 'string' ? raw.companyId.trim() : '';
  if (!companyId) return deny('missing_company', 'companyId');
  if (typeof raw.companyId !== 'string' || raw.companyId !== companyId) {
    return deny('trusted_authority_malformed', 'companyId');
  }
  if (!COMPANY_ID_RE.test(companyId) || companyId.includes('/')) {
    return deny('trusted_authority_malformed', 'companyId');
  }

  const caps = readDenseStringArray(raw.capabilities, 'capabilities');
  if (!caps.ok) return caps;

  return {
    ok: true,
    schemaVersion: 1,
    uid: raw.uid,
    companyId,
    active: true,
    capabilities: caps.values,
  };
}

export function decideTrustedCompanyCapability(
  authUid: string | undefined,
  record: unknown,
  requiredCapability: string,
): TrustedAuthorityResult<TrustedCompanyAuthority> {
  if (!authUid || typeof authUid !== 'string' || !UID_RE.test(authUid) || authUid.includes('/')) {
    return deny('unauthenticated');
  }
  if (typeof requiredCapability !== 'string' || !requiredCapability) {
    return deny('missing_required_capability', 'requiredCapability');
  }
  if (RESERVED_SET.has(requiredCapability)) {
    return deny('reserved_capability', 'requiredCapability');
  }
  if (!ALLOWLIST_SET.has(requiredCapability)) {
    return deny('unknown_capability', 'requiredCapability');
  }
  const parsed = parseTrustedStaffAuthorityRecord(record, authUid);
  if (!parsed.ok) return parsed;
  if (!parsed.capabilities.includes(requiredCapability)) {
    return deny('missing_required_capability', 'capabilities');
  }
  return { ok: true, uid: parsed.uid, companyId: parsed.companyId };
}

async function defaultGetRecord(uid: string): Promise<unknown | null> {
  const snap = await admin.firestore()
    .collection(TRUSTED_STAFF_AUTHORITY_COLLECTION)
    .doc(uid)
    .get();
  return snap.exists ? (snap.data() as Record<string, unknown>) : null;
}

function throwTrustedFailure(result: TrustedAuthorityFailure): never {
  const msg = result.field ? `${result.reason}:${result.field}` : result.reason;
  if (result.reason === 'unauthenticated') {
    throw new httpsV2.HttpsError('unauthenticated', msg);
  }
  throw new httpsV2.HttpsError('permission-denied', msg);
}

/**
 * Production gate. Returns server-derived uid + companyId after the named
 * trusted capability is proven on the server-owned record.
 */
export async function requireTrustedCompanyCapability(
  authUid: string | undefined,
  requiredCapability: string,
  deps?: TrustedAuthorityDeps,
): Promise<TrustedCompanyAuthority> {
  if (!authUid) throwTrustedFailure({ ok: false, reason: 'unauthenticated' });
  const getRecord = deps?.getRecord ?? defaultGetRecord;
  const record = await getRecord(authUid);
  const decided = decideTrustedCompanyCapability(authUid, record, requiredCapability);
  if (!decided.ok) throwTrustedFailure(decided);
  return { uid: decided.uid, companyId: decided.companyId };
}


