/**
 * Read-only resolution of the packet revision already pinned to a dispatch.
 * Callers cannot redirect package, revision, company, or driver.
 */
import { fail, revisionDocId, snapshotPlain, type StoreResult } from './jobPacketRevisionStore';
import {
  loadVerifiedRevisionFromData,
  parseDispatchId,
  parsePacketRef,
  readDispatchBinding,
  requireCompleteBinding,
  stampDispatchBinding,
  verifyDispatchPinsAgainstEnvelope,
  type DispatchBinding,
} from './dispatchPacketPin';
import { packageIndexDocId } from './jobPacketPublish';

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
 * Authoritative execution context from the stored dispatch only.
 * Stored field `jobType` is the canonical job-type id (response `jobTypeId`).
 * Stored `wellName` and `ndicWellName` are preserved as distinct plain strings.
 * Caller input, packet text, and catalog guesses are never used.
 */
export function readDispatchExecutionContext(
  job: Record<string, unknown>,
): StoreResult<{ execution: DispatchExecutionContext }> {
  if (!Object.prototype.hasOwnProperty.call(job, 'jobType')) {
    return fail('job_type_required', 'jobType');
  }
  if (typeof job.jobType !== 'string') return fail('malformed_execution', 'jobType');
  const jobTypeId = job.jobType.trim();
  if (!jobTypeId) return fail('job_type_required', 'jobType');
  if (!Object.prototype.hasOwnProperty.call(job, 'wellName')) {
    return fail('missing_well_identity', 'wellName');
  }
  if (typeof job.wellName !== 'string') return fail('malformed_well_identity', 'wellName');
  const wellName = job.wellName.trim();
  if (!wellName) return fail('partial_well_identity', 'wellName');

  let ndicWellName = wellName;
  if (Object.prototype.hasOwnProperty.call(job, 'ndicWellName')) {
    if (typeof job.ndicWellName !== 'string') return fail('malformed_well_identity', 'ndicWellName');
    const trimmed = job.ndicWellName.trim();
    if (!trimmed) return fail('partial_well_identity', 'ndicWellName');
    ndicWellName = trimmed;
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
  getHead?: (id: string) => Promise<{ exists: boolean; data?: Record<string, unknown> }>;
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

  const readBinding = readDispatchBinding(existing);
  if (readBinding.partial) return fail('partial_authority_group', 'binding');

  let envelope: Record<string, unknown> & { definition: unknown; implementedEffects: readonly unknown[] };
  let binding: DispatchBinding;

  if (readBinding.complete) {
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
    const pins = verifyDispatchPinsAgainstEnvelope(existing, loaded.envelope, companyId);
    if (!pins.ok) return pins;
    const expected = stampDispatchBinding(loaded.envelope);
    if (expected.contentHash !== bound.binding.contentHash) {
      return fail('content_hash_mismatch', 'contentHash');
    }
    if (expected.policyHash !== bound.binding.policyHash) {
      return fail('policy_hash_mismatch', 'policyHash');
    }
    envelope = loaded.envelope;
    binding = {
      packageId: bound.binding.packageId,
      packetRevision: bound.binding.packetRevision,
      contentHash: bound.binding.contentHash,
      policyHash: bound.binding.policyHash,
    };
  } else {
    const pkg = typeof existing.packageId === 'string' && existing.packageId.trim()
      ? existing.packageId.trim()
      : 'water-hauling';
    let revision = 1;
    if (input.getHead) {
      const headId = packageIndexDocId(companyId, pkg);
      const headSnap = await input.getHead(headId);
      if (headSnap?.exists && headSnap.data && typeof headSnap.data.latestRevision === 'number' && Number.isInteger(headSnap.data.latestRevision) && headSnap.data.latestRevision > 0) {
        revision = headSnap.data.latestRevision;
      }
    }
    const revId = revisionDocId(companyId, pkg, revision);
    const revSnap = await input.getRevision(revId);
    const loaded = await loadVerifiedRevisionFromData(
      revSnap.exists,
      revSnap.data,
      companyId,
      { packageId: pkg, revision },
    );
    if (!loaded.ok) return loaded;
    envelope = loaded.envelope;
    binding = stampDispatchBinding(loaded.envelope);
  }

  const definitionSnap = snapshotPlain(envelope.definition, 'definition');
  if (!definitionSnap.ok) return definitionSnap;
  if (
    definitionSnap.value === null
    || typeof definitionSnap.value !== 'object'
    || Array.isArray(definitionSnap.value)
  ) {
    return fail('definition_must_be_object', 'definition');
  }
  const effectsSnap = snapshotPlain([...envelope.implementedEffects], 'implementedEffects');
  if (!effectsSnap.ok) return effectsSnap;
  if (!Array.isArray(effectsSnap.value)) return fail('effects_must_be_array', 'implementedEffects');
  const implementedEffects = (effectsSnap.value as unknown[]).map((e) => String(e));
  const executionRead = readDispatchExecutionContext(existing);
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
  return {
    ok: true,
    jobId: parsed.jobId,
    companyId,
    driverId,
    binding,
    execution: {
      jobTypeId: execution.jobTypeId,
      wellName: execution.wellName,
      ndicWellName: execution.ndicWellName,
    },
    definition: definitionSnap.value as Record<string, unknown>,
    implementedEffects,
  };
}
