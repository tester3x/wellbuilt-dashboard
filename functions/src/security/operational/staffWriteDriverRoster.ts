/**
 * Governed mutations of drivers/approved and drivers/pending.
 * Company comes from trusted authority. No generic path patch.
 */
import { fail, type StoreResult } from './jobPacketRevisionStore';

export const STAFF_WRITE_DRIVER_ROSTER_CALLABLE = 'staffWriteDriverRoster';

export const ROSTER_OPS = Object.freeze([
  'setDefaultPackage',
  'stageCompany',
  'setDisplayCompany',
  'approvePending',
  'toggleActive',
  'unlinkDashboard',
  'setAssignedCustomers',
  'deleteApproved',
  'setAppAdmin',
  'setTier',
] as const);

export type RosterOp = (typeof ROSTER_OPS)[number];

export const ROSTER_REQUEST_KEYS = Object.freeze([
  'op',
  'approvedKey',
  'pendingKey',
  'nestedKey',
  'defaultPackageId',
  'companyName',
  'active',
  'isAdmin',
  'tier',
  'assignedCustomers',
  'displayName',
  'legalName',
  'assignedRoutes',
  'roles',
] as const);

export const ROSTER_FORBIDDEN_KEYS = Object.freeze([
  'companyId',
  'targetCompanyId',
  'uid',
  'role',
  'capabilities',
  'manageDrivers',
  'isPlatformAdmin',
  'wellbuiltAdmin',
  'platformAdmin',
] as const);

const KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;
const OP_SET = new Set<string>(ROSTER_OPS);

export type RosterStore = {
  getApproved(path: string): Promise<Record<string, unknown> | null>;
  getPending(key: string): Promise<Record<string, unknown> | null>;
  updateApproved(path: string, fields: Record<string, unknown>): Promise<void>;
  setApproved(path: string, fields: Record<string, unknown>): Promise<void>;
  removeApproved(path: string): Promise<void>;
  updatePending(key: string, fields: Record<string, unknown>): Promise<void>;
};

export type RosterRequest = {
  op: RosterOp;
  approvedKey: string | null;
  pendingKey: string | null;
  nestedKey: string | null;
  defaultPackageId: string | null;
  companyName: string | null;
  active: boolean | null;
  isAdmin: boolean | null;
  tier: string | null;
  assignedCustomers: { name: string; companyId: string }[] | null;
  displayName: string | null;
  legalName: string | null;
  assignedRoutes: string[] | null;
  roles: string[] | null;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function parseKey(raw: unknown, field: string): StoreResult<{ value: string | null }> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return fail('malformed_key', field);
  const v = raw.trim();
  if (!v || !KEY_RE.test(v) || v.includes('/')) return fail('malformed_key', field);
  return { ok: true, value: v };
}

export function parseStaffWriteDriverRoster(raw: unknown): StoreResult<RosterRequest> {
  if (!isPlainObject(raw)) return fail('record_must_be_object', 'request');
  for (const key of Object.getOwnPropertyNames(raw)) {
    if ((ROSTER_FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      return fail('caller_authority_field', key);
    }
    if (!(ROSTER_REQUEST_KEYS as readonly string[]).includes(key)) {
      return fail('unknown_field', key);
    }
  }
  if (typeof raw.op !== 'string' || !OP_SET.has(raw.op)) return fail('unknown_op', 'op');
  const approvedKey = parseKey(raw.approvedKey, 'approvedKey');
  if (!approvedKey.ok) return approvedKey;
  const pendingKey = parseKey(raw.pendingKey, 'pendingKey');
  if (!pendingKey.ok) return pendingKey;
  const nestedKey = parseKey(raw.nestedKey, 'nestedKey');
  if (!nestedKey.ok) return nestedKey;
  let defaultPackageId: string | null = null;
  if (raw.defaultPackageId !== undefined && raw.defaultPackageId !== null && raw.defaultPackageId !== '') {
    if (typeof raw.defaultPackageId !== 'string' || raw.defaultPackageId.trim().length > 64) {
      return fail('malformed_package', 'defaultPackageId');
    }
    defaultPackageId = raw.defaultPackageId.trim();
  }
  const companyName = typeof raw.companyName === 'string' ? raw.companyName.trim().slice(0, 120) || null : null;
  const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim().slice(0, 120) || null : null;
  const legalName = typeof raw.legalName === 'string' ? raw.legalName.trim().slice(0, 120) || null : null;
  const tier = typeof raw.tier === 'string' ? raw.tier.trim().slice(0, 32) || null : null;
  let assignedCustomers: { name: string; companyId: string }[] | null = null;
  if (raw.assignedCustomers !== undefined) {
    if (!Array.isArray(raw.assignedCustomers) || raw.assignedCustomers.length > 32) {
      return fail('malformed_customers', 'assignedCustomers');
    }
    assignedCustomers = [];
    for (const row of raw.assignedCustomers) {
      if (!isPlainObject(row)) return fail('malformed_customers', 'assignedCustomers');
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      const companyId = typeof row.companyId === 'string' ? row.companyId.trim().toLowerCase() : '';
      if (!name || !companyId || !KEY_RE.test(companyId)) return fail('malformed_customers', 'assignedCustomers');
      assignedCustomers.push({ name: name.slice(0, 120), companyId });
    }
  }
  let assignedRoutes: string[] | null = null;
  if (raw.assignedRoutes !== undefined) {
    if (!Array.isArray(raw.assignedRoutes) || raw.assignedRoutes.length > 32) return fail('malformed_routes', 'assignedRoutes');
    assignedRoutes = raw.assignedRoutes.map((r) => String(r).trim()).filter(Boolean);
  }
  let roles: string[] | null = null;
  if (raw.roles !== undefined) {
    if (!Array.isArray(raw.roles) || raw.roles.length > 8) return fail('malformed_roles', 'roles');
    roles = raw.roles.map((r) => String(r).trim()).filter(Boolean);
  }
  return {
    ok: true,
    op: raw.op as RosterOp,
    approvedKey: approvedKey.value,
    pendingKey: pendingKey.value,
    nestedKey: nestedKey.value,
    defaultPackageId,
    companyName,
    active: typeof raw.active === 'boolean' ? raw.active : null,
    isAdmin: typeof raw.isAdmin === 'boolean' ? raw.isAdmin : null,
    tier,
    assignedCustomers,
    displayName,
    legalName,
    assignedRoutes,
    roles,
  };
}

function approvedPath(req: RosterRequest): string | null {
  if (!req.approvedKey) return null;
  return req.nestedKey ? `${req.approvedKey}/${req.nestedKey}` : req.approvedKey;
}

function tenantOk(existing: Record<string, unknown> | null, actingCompanyId: string): boolean {
  if (!existing) return true;
  const cid = typeof existing.companyId === 'string' ? existing.companyId.trim() : '';
  if (!cid) return true;
  return cid === actingCompanyId;
}

export async function runStaffWriteDriverRoster(input: {
  actingCompanyId: string;
  actorUid: string;
  request: RosterRequest;
  store: RosterStore;
}): Promise<StoreResult<{ op: RosterOp; path: string }>> {
  const companyId = input.actingCompanyId.trim();
  if (!companyId) return fail('missing_company', 'companyId');
  const req = input.request;
  const path = approvedPath(req);

  if (req.op === 'approvePending') {
    if (!req.pendingKey || !req.approvedKey) return fail('missing_field', 'pendingKey');
    const pending = await input.store.getPending(req.pendingKey);
    if (!pending) return fail('not_found', 'pendingKey');
    if (!tenantOk(pending, companyId)) return fail('cross_company', 'pendingKey');
    const existing = await input.store.getApproved(req.approvedKey);
    if (existing && !tenantOk(existing, companyId)) return fail('cross_company', 'approvedKey');
    const payload: Record<string, unknown> = {
      displayName: req.displayName || pending.displayName || '',
      legalName: req.legalName || pending.legalName || pending.displayName || '',
      name: req.displayName || pending.displayName || '',
      active: true,
      isAdmin: Array.isArray(req.roles) ? req.roles.includes('admin') : false,
      isViewer: Array.isArray(req.roles) ? req.roles.includes('viewer') : false,
      approvedAt: Date.now(),
      roles: req.roles && req.roles.length ? req.roles : ['driver'],
      companyId,
    };
    if (req.companyName) payload.companyName = req.companyName;
    if (req.assignedCustomers) payload.assignedCustomers = req.assignedCustomers;
    if (req.assignedRoutes) payload.assignedRoutes = req.assignedRoutes;
    if (typeof pending.companyName === 'string' && pending.companyName) {
      payload.registrationCompany = pending.companyName;
    }
    await input.store.setApproved(req.approvedKey, payload);
    await input.store.updatePending(req.pendingKey, { status: 'approved' });
    return { ok: true, op: req.op, path: req.approvedKey };
  }

  if (!path) return fail('missing_field', 'approvedKey');
  const existing = await input.store.getApproved(path);
  if (existing && !tenantOk(existing, companyId)) return fail('cross_company', 'approvedKey');
  if (!existing) return fail('not_found', 'approvedKey');

  if (req.op === 'deleteApproved') {
    await input.store.removeApproved(path);
    return { ok: true, op: req.op, path };
  }

  const patch: Record<string, unknown> = {};
  if (req.op === 'setDefaultPackage') patch.defaultPackageId = req.defaultPackageId;
  else if (req.op === 'stageCompany' || req.op === 'setDisplayCompany') {
    patch.companyId = companyId;
    patch.companyName = req.companyName;
  } else if (req.op === 'toggleActive') {
    if (req.active === null) return fail('missing_field', 'active');
    patch.active = req.active;
  } else if (req.op === 'unlinkDashboard') {
    patch.dashboardUid = null;
    patch.dashboardRole = null;
  } else if (req.op === 'setAssignedCustomers') {
    if (!req.assignedCustomers) return fail('missing_field', 'assignedCustomers');
    patch.assignedCustomers = req.assignedCustomers;
  } else if (req.op === 'setAppAdmin') {
    if (req.isAdmin === null) return fail('missing_field', 'isAdmin');
    patch.isAdmin = req.isAdmin;
    if (req.isAdmin) patch.isViewer = false;
  } else if (req.op === 'setTier') {
    patch.tier = req.tier;
  } else {
    return fail('unknown_op', 'op');
  }
  await input.store.updateApproved(path, patch);
  return { ok: true, op: req.op, path };
}
