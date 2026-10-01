/**
 * Read-only resolution of the packet revision already pinned to a dispatch.
 * Callers cannot redirect package, revision, company, or driver.
 */
import { fail, revisionDocId, snapshotPlain, type StoreResult } from './jobPacketRevisionStore';
import {
  loadVerifiedRevisionFromData,
  parseDispatchId,
  parsePacketRef,
  requireCompleteBinding,
  resolveAuthoritativeWell,
  stampDispatchBinding,
  verifyDispatchPinsAgainstEnvelope,
  type DispatchBinding,
} from './dispatchPacketPin';

export const RESOLVE_EXECUTION_BINDING_CALLABLE = 'resolveExecutionBinding';

export const RESOLVE_REQUEST_KEYS = Object.freeze(['jobId'] as const);

export const RESOLVE_FORBIDDEN_KEYS = Object.freeze([
  'companyId',
  'targetCompanyId',
  'driverId',
  'driverHash',
  'packageId',
  'packetRevision',
  'revision',
  'contentHash',
  'policyHash',
  'implementedEffects',
  'capabilities',
  'role',
  'roles',
  'uid',
  'isPlatformAdmin',
  'wellName',
  'ndicWellName',
  'jobType',
  'jobTypeId',
  'execution',
  'well',
] as const);

/** Statuses a WB-T driver may execute after accept. Pending is not executable. */
export const EXECUTABLE_DISPATCH_STATUSES = Object.freeze([
  'accepted',
  'in_progress',
  'paused',
] as const);

export type DispatchExecutionContext = {
  jobTypeId: string;
  wellName: string;
  ndicWellName: string;
};

export type ExecutionBindingResult = {
  ok: true;
  jobId: string;
  companyId: string;
  driverId: string;
  binding: DispatchBinding;
  execution: DispatchExecutionContext;
  definition: Record<string, unknown>;
  implementedEffects: string[];
};

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Authoritative execution context from the stored dispatch, or authoritative server well catalog.
 * Stored field `jobType` is the canonical job-type id (response `jobTypeId`).
 * Stored `wellName` and `ndicWellName` are preserved as distinct plain strings.
 * Caller input, packet text, and display-name fallbacks are never used.
 */
export function readDispatchExecutionContext(
  job: Record<string, unknown>,
  authoritativeIdentity?: { wellName?: string; ndicWellName?: string },
): StoreResult<{ execution: DispatchExecutionContext }> {
  let jobTypeId = '';
  if (Object.prototype.hasOwnProperty.call(job, 'jobTypeId') && job.jobTypeId !== undefined && job.jobTypeId !== null) {
    if (typeof job.jobTypeId !== 'string') return fail('malformed_execution', 'jobTypeId');
    jobTypeId = job.jobTypeId.trim();
    if (!jobTypeId) return fail('job_type_required', 'jobTypeId');
  } else if (Object.prototype.hasOwnProperty.call(job, 'jobType') && job.jobType !== undefined && job.jobType !== null) {
    if (typeof job.jobType !== 'string') return fail('malformed_execution', 'jobType');
    jobTypeId = job.jobType.trim();
    if (!jobTypeId) return fail('job_type_required', 'jobType');
  } else {
    return fail('job_type_required', 'jobType');
  }
  if (!Object.prototype.hasOwnProperty.call(job, 'wellName')) {
    return fail('missing_well_identity', 'wellName');
  }
  if (typeof job.wellName !== 'string') return fail('malformed_well_identity', 'wellName');
  const wellName = job.wellName.trim();
  if (!wellName) return fail('partial_well_identity', 'wellName');

  let ndicWellName = '';
  if (Object.prototype.hasOwnProperty.call(job, 'ndicWellName')) {
    if (typeof job.ndicWellName !== 'string') return fail('malformed_well_identity', 'ndicWellName');
    ndicWellName = job.ndicWellName.trim();
    if (!ndicWellName) return fail('partial_well_identity', 'ndicWellName');
  } else if (authoritativeIdentity && typeof authoritativeIdentity.ndicWellName === 'string') {
    ndicWellName = authoritativeIdentity.ndicWellName.trim();
    if (!ndicWellName) return fail('missing_well_identity', 'ndicWellName');
  } else {
    return fail('missing_well_identity', 'ndicWellName');
  }

  return { ok: true, execution: { jobTypeId, wellName, ndicWellName } };
}

export function parseResolveExecutionBindingRequest(raw: unknown): StoreResult<{ jobId: string }> {
  if (!isPlainObject(raw)) return fail('record_must_be_object', 'request');
  for (const key of Object.getOwnPropertyNames(raw)) {
    if ((RESOLVE_FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      return fail('caller_authority_field', key);
    }
    if (!(RESOLVE_REQUEST_KEYS as readonly string[]).includes(key)) {
      return fail('unknown_field', key);
    }
  }
  const parsed = parseDispatchId(raw.jobId);
  if (!parsed.ok) return parsed;
  return { ok: true, jobId: parsed.dispatchId };
}

export async function runResolveExecutionBinding(input: {
  jobId: unknown;
  caller: { driverId: string; companyId: string } | null;
  getDispatch: (id: string) => Promise<Record<string, unknown> | null>;
  getRevision: (id: string) => Promise<{ exists: boolean; data?: Record<string, unknown> }>;
  getCompany?: (id: string) => Promise<Record<string, unknown> | null>;
  getWellCatalog?: () => Promise<unknown>;
  writes?: unknown[];
}): Promise<StoreResult<ExecutionBindingResult>> {
  if (input.writes) input.writes.length = 0;
  const parsed = parseResolveExecutionBindingRequest(
    typeof input.jobId === 'object' && input.jobId !== null
      ? input.jobId
      : { jobId: input.jobId },
  );
  if (!parsed.ok) return parsed;
  const driverId = str(input.caller?.driverId);
  const companyId = str(input.caller?.companyId);
  if (!driverId || !companyId) return fail('unauthenticated_driver');
  const existing = await input.getDispatch(parsed.jobId);
  if (!existing) return fail('not_found');
  const jobCompany = str(existing.companyId);
  if (!jobCompany || jobCompany !== companyId) return fail('wrong_company');
  const assigned = str(existing.driverId);
  if (!assigned || assigned !== driverId) return fail('other_driver');
  const status = str(existing.status).toLowerCase();
  if (!(EXECUTABLE_DISPATCH_STATUSES as readonly string[]).includes(status)) {
    return fail('invalid_status', 'status');
  }
  const bound = requireCompleteBinding(existing);
  if (!bound.ok) return bound;
  const selector = parsePacketRef({
    packageId: bound.binding.packageId,
    revision: bound.binding.packetRevision,
  });
  if (!selector.ok) return selector;
  const revId = revisionDocId(companyId, selector.packetRef.packageId, selector.packetRef.revision);
  const revSnap = await input.getRevision(revId);
  const loaded = await loadVerifiedRevisionFromData(
    revSnap.exists,
    revSnap.data,
    companyId,
    selector.packetRef,
  );
  if (!loaded.ok) return loaded;
  const companyData = input.getCompany ? await input.getCompany(companyId) : null;
  const customJobTypes = Array.isArray(companyData?.customJobTypes) ? companyData!.customJobTypes : undefined;
  const pins = verifyDispatchPinsAgainstEnvelope(existing, loaded.envelope, companyId, customJobTypes);
  if (!pins.ok) return pins;
  const expected = stampDispatchBinding(loaded.envelope);
  if (expected.contentHash !== bound.binding.contentHash) {
    return fail('content_hash_mismatch', 'contentHash');
  }
  if (expected.policyHash !== bound.binding.policyHash) {
    return fail('policy_hash_mismatch', 'policyHash');
  }
  const definitionSnap = snapshotPlain(loaded.envelope.definition, 'definition');
  if (!definitionSnap.ok) return definitionSnap;
  if (
    definitionSnap.value === null
    || typeof definitionSnap.value !== 'object'
    || Array.isArray(definitionSnap.value)
  ) {
    return fail('definition_must_be_object', 'definition');
  }
  const effectsSnap = snapshotPlain([...loaded.envelope.implementedEffects], 'implementedEffects');
  if (!effectsSnap.ok) return effectsSnap;
  if (!Array.isArray(effectsSnap.value)) return fail('effects_must_be_array', 'implementedEffects');
  const implementedEffects = (effectsSnap.value as unknown[]).map((e) => String(e));
  let recoveredWell: { wellName: string; ndicWellName: string } | undefined;
  if (!Object.prototype.hasOwnProperty.call(existing, 'ndicWellName') && input.getWellCatalog) {
    if (typeof existing.wellName === 'string' && existing.wellName.trim()) {
      const rawCatalog = await input.getWellCatalog();
      const authWell = resolveAuthoritativeWell(rawCatalog, { wellName: existing.wellName }, companyId);
      if (authWell.ok && authWell.well.ndicWellName) {
        recoveredWell = {
          wellName: authWell.well.wellName,
          ndicWellName: authWell.well.ndicWellName,
        };
      }
    }
  }
  const executionRead = readDispatchExecutionContext(existing, recoveredWell);
  if (!executionRead.ok) return executionRead;
  const executionSnap = snapshotPlain(executionRead.execution, 'execution');
  if (!executionSnap.ok) return executionSnap;
  if (
    executionSnap.value === null
    || typeof executionSnap.value !== 'object'
    || Array.isArray(executionSnap.value)
  ) {
    return fail('malformed_execution', 'execution');
  }
  const execution = executionSnap.value as DispatchExecutionContext;
  if (
    str(execution.jobTypeId) !== executionRead.execution.jobTypeId
    || str(execution.wellName) !== executionRead.execution.wellName
    || str(execution.ndicWellName) !== executionRead.execution.ndicWellName
  ) {
    return fail('malformed_execution', 'execution');
  }
  const baseDef = { ...(definitionSnap.value as Record<string, unknown>) };
  const jobTypes = Array.isArray(baseDef.jobTypes)
    ? (baseDef.jobTypes as Array<Record<string, unknown>>)
    : Array.isArray(loaded.envelope.jobTypes)
      ? (loaded.envelope.jobTypes as Array<Record<string, unknown>>)
      : [];
  if (Array.isArray(baseDef.capabilities)) {
    const matchingJobType = jobTypes.find(
      (jt) => jt && typeof jt === 'object' && jt.jobTypeId === execution.jobTypeId,
    );
    let allowedCaps: Set<string> | null = null;
    if (matchingJobType && Array.isArray(matchingJobType.capabilities)) {
      allowedCaps = new Set(matchingJobType.capabilities.map((c) => String(c)));
    } else if (pins.resolvedJobType?.capabilities) {
      allowedCaps = new Set(pins.resolvedJobType.capabilities.map((c) => String(c)));
    }
    if (allowedCaps) {
      baseDef.capabilities = (baseDef.capabilities as Array<Record<string, unknown>>).filter(
        (cap) => cap && typeof cap === 'object' && allowedCaps!.has(String(cap.capabilityId)),
      );
    }
  }
  if (pins.resolvedJobType?.isCustom && Array.isArray(baseDef.jobTypes)) {
    const exists = (baseDef.jobTypes as Array<Record<string, unknown>>).some(
      (jt) => jt && typeof jt === 'object' && jt.jobTypeId === execution.jobTypeId,
    );
    if (!exists) {
      (baseDef.jobTypes as Array<Record<string, unknown>>).push({
        jobTypeId: execution.jobTypeId,
        label: typeof existing.serviceType === 'string' && existing.serviceType.trim()
          ? existing.serviceType.trim()
          : execution.jobTypeId,
        lifecycleShape: pins.resolvedJobType.lifecycleShape || 'pickup_dropoff',
        capabilities: pins.resolvedJobType.capabilities || ['lifecycle', 'pickup'],
        ...(pins.resolvedJobType.payBasis ? { payBasis: pins.resolvedJobType.payBasis } : {}),
      });
    }
  }

  return {
    ok: true,
    jobId: parsed.jobId,
    companyId,
    driverId,
    binding: {
      packageId: bound.binding.packageId,
      packetRevision: bound.binding.packetRevision,
      contentHash: bound.binding.contentHash,
      policyHash: bound.binding.policyHash,
    },
    execution: {
      jobTypeId: execution.jobTypeId,
      wellName: execution.wellName,
      ndicWellName: execution.ndicWellName,
    },
    definition: baseDef,
    implementedEffects,
  };
}
