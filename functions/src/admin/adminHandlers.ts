/**
 * vc51.9A6-B protected admin handlers — pure of firebase-functions and
 * firebase-admin. Every handler:
 *
 *   1. routes through requireAdmin (authorizeAdminCall over an EXACT
 *      platform_admins/{uid} read — claim AND enabled record);
 *   2. validates its payload strictly (exact keys, bounded values,
 *      @wellbuilt/contracts schemas — never redefined);
 *   3. mutates inside ONE transaction that also writes the bounded
 *      platform_admin_audit record (no mutation without audit);
 *   4. derives actor/timestamps from the verified token and server
 *      clock — request-body actor fields are never read;
 *   5. returns a typed minimal response.
 *
 * There is deliberately NO setCompanyContractVersion callable and NO
 * destructive plan/company hard-delete callable: contract versions move
 * only through validated contract mutations, plan removal is
 * deprecation-only (assigned companies are never silently altered), and
 * configured companies are ARCHIVED (Part 7 decision — hard delete is
 * not genuinely required: the Part A census showed client hard-delete
 * orphans subcollections, and unconfigured legacy docs retain their
 * existing client flow).
 */

import { authorizeAdminCall, PLATFORM_ADMINS_COLLECTION, type VerifiedCallerAuth } from './authority';
import {
  AdminCallError,
  type AdminDeps,
  type AdminTransaction,
} from './adminDeps';
import { ADMIN_AUDIT_COLLECTION, AUDIT_REASON_MAX, buildAuditRecord } from './adminAudit';
import {
  MAX_OVERRIDES, OVERRIDE_REASON_MAX, PLAN_CAPABILITIES, PLAN_ID_RE,
  WELLBUILT_CONTRACT_KEY,
  isWorkPeriodConfigurationComplete,
  parseCompanyContract,
  parseStoredWorkPeriodConfiguration,
  type WellbuiltContract,
} from './companyContract';
import { computeEffectiveCapabilities, type CapabilityResult } from './effectiveCapabilities';
import { CONTRACT_VERSION, type PlanCapability, type PlanDefinition } from '@wellbuilt/contracts';

export const PLANS_COLLECTION = 'plans';
export const COMPANIES_COLLECTION = 'companies';

/**
 * RESERVED company root keys — the Part A flattened proposal, kept
 * permanently unusable so a second active schema shape can never
 * appear. Pinned against firestore-rules-tests/protected-company-keys.mjs
 * and firestore.rules by test-rulesSourcePins.mjs.
 */
export const RESERVED_COMPANY_KEYS: readonly string[] = Object.freeze([
  'contractVersion', 'planId', 'entitlement', 'entitlementOverrides',
  'workPeriodMode', 'workPeriodConfiguration', 'effectiveCapabilities',
  'configurationVersion', 'contractEnforced',
]);
export const PROTECTED_COMPANY_KEYS: readonly string[] = Object.freeze([
  WELLBUILT_CONTRACT_KEY, ...RESERVED_COMPANY_KEYS,
]);

// ── shared guard ──────────────────────────────────────────────────────────

export interface AdminActor {
  actorUid: string;
  actorEmail: string | null;
  policyVersion: number;
}

/** THE gate. Exact enabled platform_admins/{uid} read + verified claim. */
export async function requireAdmin(deps: AdminDeps, auth: VerifiedCallerAuth | null | undefined): Promise<AdminActor> {
  const uid = auth?.uid ?? null;
  const snap = uid ? await deps.getDoc(`${PLATFORM_ADMINS_COLLECTION}/${uid}`) : null;
  const authz = authorizeAdminCall(auth, snap?.exists ? (snap.data as never) : null);
  if (!authz.ok) {
    throw new AdminCallError(
      authz.reason === 'unauthenticated' ? 'unauthenticated' : 'permission-denied',
      authz.reason,
    );
  }
  return { actorUid: authz.actorUid, actorEmail: authz.actorEmail, policyVersion: authz.policyVersion };
}

// ── validation helpers ────────────────────────────────────────────────────

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function requireExactKeys(data: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!isPlainObject(data)) throw new AdminCallError('invalid-argument', 'payload_not_object');
  const allowed = [...required, ...optional];
  const unknown = Object.keys(data).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new AdminCallError('invalid-argument', `unknown_fields:${unknown.join(',')}`);
  for (const k of required) {
    if (data[k] === undefined) throw new AdminCallError('invalid-argument', `missing_field:${k}`);
  }
  return data;
}

function requirePlanId(v: unknown): string {
  if (typeof v !== 'string' || !PLAN_ID_RE.test(v)) {
    throw new AdminCallError('invalid-argument', 'invalid_plan_id');
  }
  return v;
}

function requireCompanyId(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 80 || v.includes('/')) {
    throw new AdminCallError('invalid-argument', 'invalid_company_id');
  }
  return v;
}

function requireBoundedReason(v: unknown, max: number): string {
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) {
    throw new AdminCallError('invalid-argument', 'reason_missing_or_unbounded');
  }
  return v;
}

function parsePlanDoc(planId: string, data: Record<string, unknown> | undefined): PlanDefinition {
  const d = data ?? {};
  return {
    contractVersion: d.contractVersion as never,
    planId: (d.planId as string) ?? planId,
    displayName: (d.displayName as string) ?? '',
    capabilities: (d.capabilities as PlanCapability[]) ?? [],
    status: (d.status as 'active' | 'deprecated') ?? 'active',
  };
}

function requireCapabilities(v: unknown): PlanCapability[] {
  if (!Array.isArray(v) || v.length > PLAN_CAPABILITIES.length) {
    throw new AdminCallError('invalid-argument', 'invalid_capabilities');
  }
  const out: PlanCapability[] = [];
  for (const c of v) {
    if (!PLAN_CAPABILITIES.includes(c as PlanCapability)) {
      throw new AdminCallError('invalid-argument', `unknown_capability:${String(c)}`);
    }
    if (out.includes(c as PlanCapability)) throw new AdminCallError('invalid-argument', 'duplicate_capability');
    out.push(c as PlanCapability);
  }
  return out;
}

function requireDisplayName(v: unknown): string {
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > 100) {
    throw new AdminCallError('invalid-argument', 'invalid_display_name');
  }
  return v;
}

function nowIso(deps: AdminDeps): string {
  return new Date(deps.nowMs()).toISOString();
}

function audit(
  tx: AdminTransaction, deps: AdminDeps,
  input: Parameters<typeof buildAuditRecord>[0],
): void {
  tx.create(`${ADMIN_AUDIT_COLLECTION}/${deps.newAuditId()}`, buildAuditRecord(input, deps.serverTimestamp()));
}

/** Read + strictly parse a company's contract inside a transaction. */
async function readContract(tx: AdminTransaction, companyId: string): Promise<{ raw: Record<string, unknown>; contract: WellbuiltContract | null }> {
  const snap = await tx.get(`${COMPANIES_COLLECTION}/${companyId}`);
  if (!snap.exists) throw new AdminCallError('not-found', 'company_not_found');
  const parsed = parseCompanyContract((snap.data ?? {})[WELLBUILT_CONTRACT_KEY]);
  if (parsed.state === 'invalid') {
    throw new AdminCallError('failed-precondition', `invalid_existing_contract:${parsed.reason}`);
  }
  return { raw: snap.data ?? {}, contract: parsed.state === 'legacy' ? null : parsed.contract };
}

function writeContract(tx: AdminTransaction, companyId: string, contract: WellbuiltContract): void {
  // Single-root-key field-merge: unrelated company fields are untouched
  // and the nested object is replaced atomically.
  tx.update(`${COMPANIES_COLLECTION}/${companyId}`, { [WELLBUILT_CONTRACT_KEY]: contract });
}

// ── Part 5: plan mutation handlers ────────────────────────────────────────

export async function createPlanHandler(deps: AdminDeps, auth: VerifiedCallerAuth | null, data: unknown): Promise<{ planId: string; status: 'active' }> {
  const actor = await requireAdmin(deps, auth);
  const d = requireExactKeys(data, ['planId', 'displayName', 'capabilities']);
  const planId = requirePlanId(d.planId);
  const displayName = requireDisplayName(d.displayName);
  const capabilities = requireCapabilities(d.capabilities);
  await deps.runTransaction(async (tx) => {
    const existing = await tx.get(`${PLANS_COLLECTION}/${planId}`);
    if (existing.exists) throw new AdminCallError('already-exists', 'plan_already_exists');
    const plan: PlanDefinition = {
      contractVersion: CONTRACT_VERSION, planId, displayName, capabilities, status: 'active',
    };
    tx.create(`${PLANS_COLLECTION}/${planId}`, plan as unknown as Record<string, unknown>);
    audit(tx, deps, {
      operation: 'plan.create', targetType: 'plan', targetId: planId,
      actorUid: actor.actorUid, actorEmail: actor.actorEmail,
      changedFields: ['displayName', 'capabilities', 'status'],
    });
  });
  return { planId, status: 'active' };
}

export async function updatePlanHandler(deps: AdminDeps, auth: VerifiedCallerAuth | null, data: unknown): Promise<{ planId: string; changedFields: string[] }> {
  const actor = await requireAdmin(deps, auth);
  const d = requireExactKeys(data, ['planId'], ['displayName', 'capabilities']);
  const planId = requirePlanId(d.planId); // identifier — immutable by construction
  const fields: Record<string, unknown> = {};
  if (d.displayName !== undefined) fields.displayName = requireDisplayName(d.displayName);
  if (d.capabilities !== undefined) fields.capabilities = requireCapabilities(d.capabilities);
  if (!Object.keys(fields).length) throw new AdminCallError('invalid-argument', 'no_updatable_fields');
  await deps.runTransaction(async (tx) => {
    const existing = await tx.get(`${PLANS_COLLECTION}/${planId}`);
    if (!existing.exists) throw new AdminCallError('not-found', 'plan_not_found');
    tx.update(`${PLANS_COLLECTION}/${planId}`, fields);
    audit(tx, deps, {
      operation: 'plan.update', targetType: 'plan', targetId: planId,
      actorUid: actor.actorUid, actorEmail: actor.actorEmail,
      changedFields: Object.keys(fields),
    });
  });
  return { planId, changedFields: Object.keys(fields) };
}

export async function deprecatePlanHandler(deps: AdminDeps, auth: VerifiedCallerAuth | null, data: unknown): Promise<{ planId: string; status: 'deprecated' }> {
  const actor = await requireAdmin(deps, auth);
  const d = requireExactKeys(data, ['planId']);
  const planId = requirePlanId(d.planId);
  await deps.runTransaction(async (tx) => {
    const existing = await tx.get(`${PLANS_COLLECTION}/${planId}`);
    if (!existing.exists) throw new AdminCallError('not-found', 'plan_not_found');
    if ((existing.data ?? {}).status === 'deprecated') {
      throw new AdminCallError('failed-precondition', 'plan_already_deprecated');
    }
    // Deprecation NEVER touches companies already assigned to the plan.
    tx.update(`${PLANS_COLLECTION}/${planId}`, { status: 'deprecated' });
    audit(tx, deps, {
      operation: 'plan.deprecate', targetType: 'plan', targetId: planId,
      actorUid: actor.actorUid, actorEmail: actor.actorEmail,
      changedFields: ['status'],
    });
  });
  return { planId, status: 'deprecated' };
}

// ── Part 6: company contract handlers ─────────────────────────────────────

export async function assignCompanyPlanHandler(deps: AdminDeps, auth: VerifiedCallerAuth | null, data: unknown): Promise<{ companyId: string; planId: string; configurationVersion: number }> {
  const actor = await requireAdmin(deps, auth);
  const d = requireExactKeys(data, ['companyId', 'planId'], ['allowDeprecatedPlanForMigration']);
  const companyId = requireCompanyId(d.companyId);
  const planId = requirePlanId(d.planId);
  const allowDeprecated = d.allowDeprecatedPlanForMigration === true;
  if (d.allowDeprecatedPlanForMigration !== undefined && typeof d.allowDeprecatedPlanForMigration !== 'boolean') {
    throw new AdminCallError('invalid-argument', 'invalid_migration_override');
  }
  return deps.runTransaction(async (tx) => {
    const planSnap = await tx.get(`${PLANS_COLLECTION}/${planId}`);
    if (!planSnap.exists) throw new AdminCallError('not-found', 'plan_not_found');
    if ((planSnap.data ?? {}).status === 'deprecated' && !allowDeprecated) {
      throw new AdminCallError('failed-precondition', 'plan_deprecated');
    }
    const { contract } = await readContract(tx, companyId);
    const next: WellbuiltContract = contract
      ? { ...contract, planId, configurationVersion: contract.configurationVersion + 1 }
      : {
          contractVersion: CONTRACT_VERSION, configurationVersion: 1, planId,
          entitlementOverrides: [], contractEnforced: false,
        };
    writeContract(tx, companyId, next);
    audit(tx, deps, {
      operation: allowDeprecated ? 'company.assignPlan.migrationOverride' : 'company.assignPlan',
      targetType: 'company', targetId: companyId,
      actorUid: actor.actorUid, actorEmail: actor.actorEmail,
      changedFields: ['wellbuiltContract.planId'],
    });
    return { companyId, planId, configurationVersion: next.configurationVersion };
  });
}

export async function addEntitlementOverrideHandler(deps: AdminDeps, auth: VerifiedCallerAuth | null, data: unknown): Promise<{ companyId: string; capability: PlanCapability; configurationVersion: number }> {
  const actor = await requireAdmin(deps, auth);
  const d = requireExactKeys(data, ['companyId', 'capability', 'granted', 'reason'], ['expiresAt']);
  const companyId = requireCompanyId(d.companyId);
  if (!PLAN_CAPABILITIES.includes(d.capability as PlanCapability)) {
    throw new AdminCallError('invalid-argument', 'unknown_capability');
  }
  if (typeof d.granted !== 'boolean') throw new AdminCallError('invalid-argument', 'granted_not_boolean');
  const granted = d.granted;
  const reason = requireBoundedReason(d.reason, OVERRIDE_REASON_MAX);
  let expiresAt: string | null | undefined;
  if (d.expiresAt !== undefined) {
    if (d.expiresAt !== null && (typeof d.expiresAt !== 'string' || Number.isNaN(Date.parse(d.expiresAt)))) {
      throw new AdminCallError('invalid-argument', 'invalid_expires_at');
    }
    expiresAt = d.expiresAt === null ? null : new Date(Date.parse(d.expiresAt as string)).toISOString();
  }
  return deps.runTransaction(async (tx) => {
    const { contract } = await readContract(tx, companyId);
    if (!contract) throw new AdminCallError('failed-precondition', 'assign_plan_first');
    if (contract.entitlementOverrides.length >= MAX_OVERRIDES) {
      throw new AdminCallError('failed-precondition', 'override_limit_reached');
    }
    const next: WellbuiltContract = {
      ...contract,
      configurationVersion: contract.configurationVersion + 1,
      entitlementOverrides: [...contract.entitlementOverrides, {
        capability: d.capability as PlanCapability,
        granted,
        reason,
        grantedBy: actor.actorUid,   // verified token — never the body
        grantedAt: nowIso(deps),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      }],
    };
    writeContract(tx, companyId, next);
    audit(tx, deps, {
      operation: 'company.addOverride', targetType: 'company', targetId: companyId,
      actorUid: actor.actorUid, actorEmail: actor.actorEmail, reason,
      changedFields: [`wellbuiltContract.entitlementOverrides.${String(d.capability)}`],
    });
    return { companyId, capability: d.capability as PlanCapability, configurationVersion: next.configurationVersion };
  });
}

export async function removeEntitlementOverrideHandler(deps: AdminDeps, auth: VerifiedCallerAuth | null, data: unknown): Promise<{ companyId: string; capability: PlanCapability; removed: number; configurationVersion: number }> {
  const actor = await requireAdmin(deps, auth);
  const d = requireExactKeys(data, ['companyId', 'capability', 'reason']);
  const companyId = requireCompanyId(d.companyId);
  if (!PLAN_CAPABILITIES.includes(d.capability as PlanCapability)) {
    throw new AdminCallError('invalid-argument', 'unknown_capability');
  }
  const reason = requireBoundedReason(d.reason, OVERRIDE_REASON_MAX);
  return deps.runTransaction(async (tx) => {
    const { contract } = await readContract(tx, companyId);
    if (!contract) throw new AdminCallError('failed-precondition', 'assign_plan_first');
    const remaining = contract.entitlementOverrides.filter((o) => o.capability !== d.capability);
    const removed = contract.entitlementOverrides.length - remaining.length;
    if (!removed) throw new AdminCallError('not-found', 'no_override_for_capability');
    const next: WellbuiltContract = {
      ...contract,
      configurationVersion: contract.configurationVersion + 1,
      entitlementOverrides: remaining,
    };
    writeContract(tx, companyId, next);
    audit(tx, deps, {
      operation: 'company.removeOverride', targetType: 'company', targetId: companyId,
      actorUid: actor.actorUid, actorEmail: actor.actorEmail, reason,
      changedFields: [`wellbuiltContract.entitlementOverrides.${String(d.capability)}`],
    });
    return { companyId, capability: d.capability as PlanCapability, removed, configurationVersion: next.configurationVersion };
  });
}

export async function setCompanyWorkPeriodConfigurationHandler(deps: AdminDeps, auth: VerifiedCallerAuth | null, data: unknown): Promise<{ companyId: string; configurationVersion: number }> {
  const actor = await requireAdmin(deps, auth);
  const d = requireExactKeys(data, ['companyId', 'configuration']);
  const companyId = requireCompanyId(d.companyId);
  const parsed = parseStoredWorkPeriodConfiguration(d.configuration);
  if (!parsed.ok) throw new AdminCallError('invalid-argument', parsed.reason);
  return deps.runTransaction(async (tx) => {
    const { contract } = await readContract(tx, companyId);
    if (!contract) throw new AdminCallError('failed-precondition', 'assign_plan_first');
    const next: WellbuiltContract = {
      ...contract,
      configurationVersion: contract.configurationVersion + 1,
      workPeriodConfiguration: parsed.config,
    };
    // An ACTIVE contract may never be reconfigured into an unusable
    // state: completeness + entitlement + computability re-proven now.
    if (contract.contractEnforced) {
      await assertEnforceable(tx, deps, companyId, next);
    }
    writeContract(tx, companyId, next);
    audit(tx, deps, {
      operation: 'company.setWorkPeriodConfiguration', targetType: 'company', targetId: companyId,
      actorUid: actor.actorUid, actorEmail: actor.actorEmail,
      changedFields: ['wellbuiltContract.workPeriodConfiguration'],
    });
    return { companyId, configurationVersion: next.configurationVersion };
  });
}

async function assertEnforceable(tx: AdminTransaction, deps: AdminDeps, companyId: string, contract: WellbuiltContract): Promise<void> {
  const complete = isWorkPeriodConfigurationComplete(contract.workPeriodConfiguration);
  if (!complete.complete) {
    throw new AdminCallError('failed-precondition', `incomplete_configuration:${complete.reason}`);
  }
  const planSnap = await tx.get(`${PLANS_COLLECTION}/${contract.planId}`);
  if (!planSnap.exists) throw new AdminCallError('failed-precondition', 'assigned_plan_missing');
  const result = computeEffectiveCapabilities({
    companyId, plan: parsePlanDoc(contract.planId, planSnap.data), contract, nowMs: deps.nowMs(),
  });
  if (!result.ok) {
    throw new AdminCallError('failed-precondition', `not_enforceable:${result.code}`);
  }
}

export async function setCompanyContractEnforcementHandler(deps: AdminDeps, auth: VerifiedCallerAuth | null, data: unknown): Promise<{ companyId: string; contractEnforced: boolean; configurationVersion: number }> {
  const actor = await requireAdmin(deps, auth);
  const d = requireExactKeys(data, ['companyId', 'enforced']);
  const companyId = requireCompanyId(d.companyId);
  if (typeof d.enforced !== 'boolean') throw new AdminCallError('invalid-argument', 'enforced_not_boolean');
  const enforced = d.enforced;
  return deps.runTransaction(async (tx) => {
    const { contract } = await readContract(tx, companyId);
    if (!contract) throw new AdminCallError('failed-precondition', 'assign_plan_first');
    const next: WellbuiltContract = {
      ...contract,
      configurationVersion: contract.configurationVersion + 1,
      contractEnforced: enforced,
    };
    if (enforced) await assertEnforceable(tx, deps, companyId, next);
    writeContract(tx, companyId, next);
    audit(tx, deps, {
      operation: enforced ? 'company.enforceContract' : 'company.unenforceContract',
      targetType: 'company', targetId: companyId,
      actorUid: actor.actorUid, actorEmail: actor.actorEmail,
      changedFields: ['wellbuiltContract.contractEnforced'],
    });
    return { companyId, contractEnforced: enforced, configurationVersion: next.configurationVersion };
  });
}

// ── Part 7: safe replacement / archive ────────────────────────────────────

export const SAFE_UPDATE_MAX_FIELDS = 30;

/**
 * Field-merge replacement for the Dashboard's unsafe maskless setDoc:
 * only unprotected top-level keys, never a whole-document replacement,
 * wellbuiltContract untouchable here by construction.
 */
export async function updateCompanySafeHandler(deps: AdminDeps, auth: VerifiedCallerAuth | null, data: unknown): Promise<{ companyId: string; changedFields: string[] }> {
  const actor = await requireAdmin(deps, auth);
  const d = requireExactKeys(data, ['companyId', 'fields']);
  const companyId = requireCompanyId(d.companyId);
  if (!isPlainObject(d.fields)) throw new AdminCallError('invalid-argument', 'fields_not_object');
  const keys = Object.keys(d.fields);
  if (!keys.length || keys.length > SAFE_UPDATE_MAX_FIELDS) {
    throw new AdminCallError('invalid-argument', 'fields_empty_or_unbounded');
  }
  for (const k of keys) {
    // A dotted path can only smuggle into a protected object through its
    // root segment — judge the root, then reject dotted names outright.
    if (PROTECTED_COMPANY_KEYS.includes(k.split('.')[0])) {
      throw new AdminCallError('permission-denied', `protected_field:${k}`);
    }
    if (k.includes('.') || k.startsWith('__')) {
      throw new AdminCallError('invalid-argument', `invalid_field_name:${k}`);
    }
    if ((d.fields as Record<string, unknown>)[k] === undefined) {
      throw new AdminCallError('invalid-argument', `undefined_value:${k}`);
    }
  }
  await deps.runTransaction(async (tx) => {
    const snap = await tx.get(`${COMPANIES_COLLECTION}/${companyId}`);
    if (!snap.exists) throw new AdminCallError('not-found', 'company_not_found');
    tx.update(`${COMPANIES_COLLECTION}/${companyId}`, d.fields as Record<string, unknown>);
    audit(tx, deps, {
      operation: 'company.safeUpdate', targetType: 'company', targetId: companyId,
      actorUid: actor.actorUid, actorEmail: actor.actorEmail,
      changedFields: keys,
    });
  });
  return { companyId, changedFields: keys };
}

/**
 * Archive (Part 7 decision: preferred over hard delete). Requires the
 * caller to retype the exact company id. No wildcard/batch form exists.
 */
export async function archiveCompanyHandler(deps: AdminDeps, auth: VerifiedCallerAuth | null, data: unknown): Promise<{ companyId: string; status: 'archived' }> {
  const actor = await requireAdmin(deps, auth);
  const d = requireExactKeys(data, ['companyId', 'confirmCompanyId', 'reason']);
  const companyId = requireCompanyId(d.companyId);
  if (d.confirmCompanyId !== companyId) {
    throw new AdminCallError('failed-precondition', 'confirmation_mismatch');
  }
  const reason = requireBoundedReason(d.reason, AUDIT_REASON_MAX);
  await deps.runTransaction(async (tx) => {
    const snap = await tx.get(`${COMPANIES_COLLECTION}/${companyId}`);
    if (!snap.exists) throw new AdminCallError('not-found', 'company_not_found');
    if ((snap.data ?? {}).status === 'archived') {
      throw new AdminCallError('failed-precondition', 'already_archived');
    }
    tx.update(`${COMPANIES_COLLECTION}/${companyId}`, {
      status: 'archived',
      archivedAt: deps.serverTimestamp(),
    });
    audit(tx, deps, {
      operation: 'company.archive', targetType: 'company', targetId: companyId,
      actorUid: actor.actorUid, actorEmail: actor.actorEmail, reason,
      changedFields: ['status', 'archivedAt'],
    });
  });
  return { companyId, status: 'archived' };
}

// ── Part 8: bounded read handlers ─────────────────────────────────────────

export const LIST_LIMIT_MAX = 50;
export const LIST_LIMIT_DEFAULT = 25;
const AUDIT_ID_RE = /^[0-9]{15}_[a-z0-9]{8}$/;

function requireLimit(v: unknown): number {
  if (v === undefined) return LIST_LIMIT_DEFAULT;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > LIST_LIMIT_MAX) {
    throw new AdminCallError('invalid-argument', 'invalid_limit');
  }
  return v;
}

export async function listPlansHandler(deps: AdminDeps, auth: VerifiedCallerAuth | null, data: unknown): Promise<{ plans: PlanDefinition[]; nextCursor: string | null }> {
  await requireAdmin(deps, auth);
  const d = requireExactKeys(data ?? {}, [], ['limit', 'cursor']);
  const limit = requireLimit(d.limit);
  if (d.cursor !== undefined) requirePlanId(d.cursor);
  const docs = await deps.listDocsById(PLANS_COLLECTION, {
    direction: 'asc', limit, startAfterId: d.cursor as string | undefined,
  });
  const plans = docs.map((doc) => parsePlanDoc(doc.id, doc.data));
  return { plans, nextCursor: docs.length === limit ? docs[docs.length - 1].id : null };
}

export async function getPlanHandler(deps: AdminDeps, auth: VerifiedCallerAuth | null, data: unknown): Promise<{ plan: PlanDefinition }> {
  await requireAdmin(deps, auth);
  const d = requireExactKeys(data, ['planId']);
  const planId = requirePlanId(d.planId);
  const snap = await deps.getDoc(`${PLANS_COLLECTION}/${planId}`);
  if (!snap.exists) throw new AdminCallError('not-found', 'plan_not_found');
  return { plan: parsePlanDoc(planId, snap.data) };
}

export async function getCompanyContractConfigurationHandler(deps: AdminDeps, auth: VerifiedCallerAuth | null, data: unknown): Promise<{
  companyId: string;
  state: 'legacy' | 'inert' | 'active' | 'invalid';
  contract?: WellbuiltContract;
  invalidReason?: string;
}> {
  await requireAdmin(deps, auth);
  const d = requireExactKeys(data, ['companyId']);
  const companyId = requireCompanyId(d.companyId);
  const snap = await deps.getDoc(`${COMPANIES_COLLECTION}/${companyId}`);
  if (!snap.exists) throw new AdminCallError('not-found', 'company_not_found');
  const parsed = parseCompanyContract((snap.data ?? {})[WELLBUILT_CONTRACT_KEY]);
  // Incompatible/malformed contracts surface DISTINCTLY, never as legacy.
  if (parsed.state === 'invalid') return { companyId, state: 'invalid', invalidReason: parsed.reason };
  if (parsed.state === 'legacy') return { companyId, state: 'legacy' };
  return { companyId, state: parsed.state, contract: parsed.contract };
}

export async function previewCompanyEffectiveCapabilitiesHandler(deps: AdminDeps, auth: VerifiedCallerAuth | null, data: unknown): Promise<{
  companyId: string;
  state: 'legacy' | 'inert' | 'active' | 'invalid';
  result?: CapabilityResult;
  invalidReason?: string;
}> {
  await requireAdmin(deps, auth);
  const d = requireExactKeys(data, ['companyId']);
  const companyId = requireCompanyId(d.companyId);
  const snap = await deps.getDoc(`${COMPANIES_COLLECTION}/${companyId}`);
  if (!snap.exists) throw new AdminCallError('not-found', 'company_not_found');
  const parsed = parseCompanyContract((snap.data ?? {})[WELLBUILT_CONTRACT_KEY]);
  if (parsed.state === 'invalid') return { companyId, state: 'invalid', invalidReason: parsed.reason };
  if (parsed.state === 'legacy') return { companyId, state: 'legacy' };
  const planSnap = await deps.getDoc(`${PLANS_COLLECTION}/${parsed.contract.planId}`);
  if (!planSnap.exists) {
    return {
      companyId, state: parsed.state,
      result: { ok: false, code: 'plan_mismatch', detail: `assigned plan ${parsed.contract.planId} does not exist` },
    };
  }
  const result = computeEffectiveCapabilities({
    companyId,
    plan: parsePlanDoc(parsed.contract.planId, planSnap.data),
    contract: parsed.contract,
    nowMs: deps.nowMs(),
  });
  return { companyId, state: parsed.state, result };
}

export async function listAdminAuditHandler(deps: AdminDeps, auth: VerifiedCallerAuth | null, data: unknown): Promise<{
  entries: Array<Record<string, unknown> & { auditId: string }>;
  nextCursor: string | null;
}> {
  await requireAdmin(deps, auth);
  const d = requireExactKeys(data ?? {}, [], ['limit', 'cursor']);
  const limit = requireLimit(d.limit);
  if (d.cursor !== undefined && (typeof d.cursor !== 'string' || !AUDIT_ID_RE.test(d.cursor))) {
    throw new AdminCallError('invalid-argument', 'invalid_cursor');
  }
  // Audit ids are zero-padded-ms + random, so id order IS time order.
  const docs = await deps.listDocsById(ADMIN_AUDIT_COLLECTION, {
    direction: 'desc', limit, startAfterId: d.cursor as string | undefined,
  });
  return {
    entries: docs.map((doc) => ({ auditId: doc.id, ...doc.data })),
    nextCursor: docs.length === limit ? docs[docs.length - 1].id : null,
  };
}
