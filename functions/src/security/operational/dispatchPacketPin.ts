/**
 * Exact packet-revision pinning for governed dispatch birth.
 * Selectors are not authority. Binding fields are an inseparable group.
 */
import {
  PACKAGE_ID_RE,
  canonicalJson,
  fail,
  revisionDocId,
  snapshotPlain,
  validateStoredRevisionForBinding,
  type ImmutableRevisionEnvelope,
  type JobTypeEntry,
  type StoreResult,
} from './jobPacketRevisionStore';

export const PACKET_REF_KEYS = Object.freeze(['packageId', 'revision'] as const);

export const DISPATCH_BINDING_KEYS = Object.freeze([
  'packageId',
  'packetRevision',
  'contentHash',
  'policyHash',
] as const);

export const CALLER_REJECT_AUTHORITY_KEYS = Object.freeze([
  'companyId',
  'contentHash',
  'policyHash',
  'packetRevision',
  'implementedEffects',
  'schemaVersion',
  'hashSchemaVersion',
  'hashAlgorithm',
  'publishedByUid',
  'status',
] as const);

export type PacketRef = { packageId: string; revision: number };

export type DispatchBinding = {
  packageId: string;
  packetRevision: number;
  contentHash: string;
  policyHash: string;
};

export async function loadVerifiedRevisionFromData(
  exists: boolean,
  data: Record<string, unknown> | undefined,
  companyId: string,
  packetRef: PacketRef,
): Promise<StoreResult<{ envelope: ImmutableRevisionEnvelope; revisionDocId: string }>> {
  const docId = revisionDocId(companyId, packetRef.packageId, packetRef.revision);
  if (!exists) return fail('revision_not_found', 'packetRef');
  const validated = validateStoredRevisionForBinding(data || {}, {
    companyId,
    packageId: packetRef.packageId,
    revision: packetRef.revision,
  });
  if (!validated.ok) return validated;
  return { ok: true, envelope: validated.envelope, revisionDocId: docId };
}

export function parsePacketRef(raw: unknown): StoreResult<{ packetRef: PacketRef }> {
  if (raw === undefined || raw === null) return fail('packet_ref_required', 'packetRef');
  const snapped = snapshotPlain(raw, 'packetRef');
  if (!snapped.ok) return snapped;
  if (snapped.value === null || typeof snapped.value !== 'object' || Array.isArray(snapped.value)) {
    return fail('packet_ref_must_be_object', 'packetRef');
  }
  const obj = snapped.value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(PACKET_REF_KEYS as readonly string[]).includes(key)) return fail('unknown_field', `packetRef.${key}`);
  }
  if (typeof obj.packageId !== 'string' || !PACKAGE_ID_RE.test(obj.packageId)) {
    return fail('malformed_id', 'packetRef.packageId');
  }
  if (obj.revision === 'latest') return fail('latest_rejected', 'packetRef.revision');
  if (typeof obj.revision !== 'number' || !Number.isInteger(obj.revision) || obj.revision < 1 || obj.revision > Number.MAX_SAFE_INTEGER) {
    return fail('invalid_revision', 'packetRef.revision');
  }
  return { ok: true, packetRef: { packageId: obj.packageId, revision: obj.revision } };
}

export function rejectCallerAuthorityFields(record: Record<string, unknown>): StoreResult<{ ok: true }> {
  const snapped = snapshotPlain(record, 'record');
  if (!snapped.ok) return snapped;
  if (snapped.value === null || typeof snapped.value !== 'object' || Array.isArray(snapped.value)) {
    return fail('record_must_be_object', 'record');
  }
  const obj = snapped.value as Record<string, unknown>;
  for (const key of CALLER_REJECT_AUTHORITY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) {
      return fail('caller_authority_field', key);
    }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'packageId') && obj.packageId !== undefined) {
    return fail('caller_package_id_not_authority', 'packageId');
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'packetRef')) {
    return fail('packet_ref_not_in_record', 'packetRef');
  }
  return { ok: true };
}

export function stampDispatchBinding(envelope: ImmutableRevisionEnvelope): DispatchBinding {
  return {
    packageId: envelope.packageId,
    packetRevision: envelope.revision,
    contentHash: envelope.contentHash,
    policyHash: envelope.policyHash,
  };
}

export function readDispatchBinding(job: Record<string, unknown> | null): {
  complete: boolean;
  partial: boolean;
  binding: Partial<DispatchBinding>;
} {
  if (!job) return { complete: false, partial: false, binding: {} };
  const binding: Partial<DispatchBinding> = {};
  if (typeof job.packageId === 'string' && job.packageId.trim()) binding.packageId = job.packageId.trim();
  if (typeof job.packetRevision === 'number' && Number.isInteger(job.packetRevision)) {
    binding.packetRevision = job.packetRevision;
  }
  if (typeof job.contentHash === 'string' && job.contentHash.trim()) binding.contentHash = job.contentHash.trim();
  if (typeof job.policyHash === 'string' && job.policyHash.trim()) binding.policyHash = job.policyHash.trim();
  const present = DISPATCH_BINDING_KEYS.filter((k) => binding[k] !== undefined).length;
  return { complete: present === DISPATCH_BINDING_KEYS.length, partial: present > 0 && present < DISPATCH_BINDING_KEYS.length, binding };
}

export function dispatchBindingsEqual(a: DispatchBinding, b: DispatchBinding): boolean {
  const ca = canonicalJson(a);
  const cb = canonicalJson(b);
  return ca.ok && cb.ok && ca.json === cb.json;
}

export function resolveCanonicalJobType(
  requested: unknown,
  jobTypes: readonly JobTypeEntry[],
): StoreResult<{ jobTypeId: string }> {
  if (typeof requested !== 'string' || !requested.trim()) return fail('job_type_required', 'jobType');
  const id = requested.trim();
  const matches = jobTypes.filter((jt) => jt.jobTypeId === id);
  if (matches.length === 1) return { ok: true, jobTypeId: matches[0].jobTypeId };
  if (matches.length > 1) return fail('ambiguous_job_type', 'jobType');
  const labelHits = jobTypes.filter((jt) => jt.label === id);
  if (labelHits.length) return fail('job_type_label_only', 'jobType');
  return fail('unknown_job_type', 'jobType');
}

export type AuthorizedWellCatalog = {
  names: readonly string[];
  ambiguous: readonly string[];
};

/**
 * Canonical well allowlist from RTDB well_config.
 * Keys are short names; ndicName / wellName fields are aliases.
 * well_config is a globally shared Liquid Gold pool and typically has no
 * companyId; if a record carries a nonempty companyId it is tenant-bound.
 */
export function collectAuthorizedWellNames(
  catalog: unknown,
  actingCompanyId?: string,
): StoreResult<AuthorizedWellCatalog> {
  if (catalog === undefined || catalog === null) {
    return { ok: true, names: [], ambiguous: [] };
  }
  if (typeof catalog !== 'object' || Array.isArray(catalog)) {
    return fail('malformed_well_catalog', 'well_config');
  }
  const proto = Object.getPrototypeOf(catalog);
  if (proto !== Object.prototype && proto !== null) {
    return fail('malformed_well_catalog', 'well_config');
  }
  const byNorm = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const key of Object.getOwnPropertyNames(catalog)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return fail('malformed_well_catalog', key);
    }
    const rec = (catalog as Record<string, unknown>)[key];
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
      return fail('malformed_well_catalog', key);
    }
    const obj = rec as Record<string, unknown>;
    const recordCompany = typeof obj.companyId === 'string' ? obj.companyId.trim() : '';
    if (recordCompany) {
      const actor = typeof actingCompanyId === 'string' ? actingCompanyId.trim() : '';
      if (!actor || recordCompany !== actor) continue;
    }
    const label = typeof obj.wellName === 'string' ? obj.wellName.trim() : '';
    const ndic = typeof obj.ndicName === 'string' ? obj.ndicName.trim() : '';
    const aliases = [key.trim(), label, ndic].filter(Boolean);
    if (!aliases.length) return fail('malformed_well_catalog', key);
    for (const alias of aliases) {
      const norm = alias.toLowerCase();
      const owner = byNorm.get(norm);
      if (owner && owner !== key) ambiguous.add(norm);
      else byNorm.set(norm, key);
    }
  }
  const names: string[] = [];
  for (const [norm] of byNorm) {
    if (!ambiguous.has(norm)) names.push(norm);
  }
  return { ok: true, names, ambiguous: [...ambiguous].sort() };
}

export function evaluateWellAuthorized(
  wellName: string,
  ndicWellName: string,
  authorizedNames: readonly string[],
  ambiguousNames: readonly string[] = [],
): StoreResult<{ wellName: string }> {
  const well = wellName.trim();
  const ndic = ndicWellName.trim();
  if (!well && !ndic) return fail('well_required', 'wellName');
  const wanted = [well, ndic].filter(Boolean).map((n) => n.toLowerCase());
  const ambiguous = new Set(ambiguousNames.map((n) => n.trim().toLowerCase()).filter(Boolean));
  if (wanted.some((n) => ambiguous.has(n))) return fail('well_alias_ambiguous', 'wellName');
  if (!authorizedNames.length) return fail('well_scope_unavailable', 'wellName');
  const scope = authorizedNames.map((n) => n.trim().toLowerCase()).filter(Boolean);
  const ok = wanted.some((n) => scope.includes(n));
  if (!ok) return fail('well_unauthorized', 'wellName');
  return { ok: true, wellName: well || ndic };
}

export type WellIdentity = {
  wellName: string;
  ndicWellName: string;
};

export type BirthIdentity = {
  companyId: string;
  driverId: string;
  jobTypeId: string;
  binding: DispatchBinding;
  well: WellIdentity;
};

export function readCanonicalWell(job: Record<string, unknown> | null): StoreResult<{ well: WellIdentity }> {
  if (!job) return fail('missing_well_identity', 'wellName');
  if (typeof job.wellName !== 'string') return fail('missing_well_identity', 'wellName');
  if (typeof job.ndicWellName !== 'string') return fail('missing_well_identity', 'ndicWellName');
  return {
    ok: true,
    well: { wellName: job.wellName.trim(), ndicWellName: job.ndicWellName.trim() },
  };
}

export function wellsEqual(a: WellIdentity, b: WellIdentity): boolean {
  return a.wellName === b.wellName && a.ndicWellName === b.ndicWellName;
}

export function canonicalWellFromRecord(record: Record<string, unknown>): WellIdentity {
  return {
    wellName: typeof record.wellName === 'string' ? record.wellName.trim() : '',
    ndicWellName: typeof record.ndicWellName === 'string' ? record.ndicWellName.trim() : '',
  };
}

export function evaluateCreateIfAbsent(input: {
  existing: Record<string, unknown> | null;
  expected: BirthIdentity;
}): StoreResult<{ result: 'create' | 'already_exists' }> {
  if (!input.existing) return { ok: true, result: 'create' };
  const existing = input.existing;
  const bind = readDispatchBinding(existing);
  if (!bind.complete || bind.partial) return fail('conflict', 'binding');
  const existingBind = bind.binding as DispatchBinding;
  if (!dispatchBindingsEqual(existingBind, input.expected.binding)) return fail('conflict', 'binding');
  const company = typeof existing.companyId === 'string' ? existing.companyId.trim() : '';
  const driver = typeof existing.driverId === 'string' ? existing.driverId.trim() : '';
  const jobType = typeof existing.jobType === 'string' ? existing.jobType.trim() : '';
  if (company !== input.expected.companyId) return fail('conflict', 'companyId');
  if (driver !== input.expected.driverId) return fail('conflict', 'driverId');
  if (jobType !== input.expected.jobTypeId) return fail('conflict', 'jobType');
  const existingWell = readCanonicalWell(existing);
  if (!existingWell.ok) return fail('conflict', existingWell.field || 'well');
  if (!wellsEqual(existingWell.well, input.expected.well)) {
    const field = existingWell.well.wellName !== input.expected.well.wellName ? 'wellName' : 'ndicWellName';
    return fail('conflict', field);
  }
  return { ok: true, result: 'already_exists' };
}

export function verifyDispatchPinsAgainstEnvelope(
  dispatch: Record<string, unknown>,
  envelope: ImmutableRevisionEnvelope,
  expectedCompanyId: string,
): StoreResult<{ binding: DispatchBinding }> {
  const bound = requireCompleteBinding(dispatch);
  if (!bound.ok) return bound;
  const company = typeof dispatch.companyId === 'string' ? dispatch.companyId.trim() : '';
  if (!company || company !== expectedCompanyId) return fail('revision_tenant_mismatch', 'companyId');
  if (envelope.companyId !== expectedCompanyId) return fail('revision_tenant_mismatch', 'companyId');
  const expected = stampDispatchBinding(envelope);
  if (!dispatchBindingsEqual(bound.binding, expected)) {
    if (bound.binding.packageId !== expected.packageId) return fail('revision_package_mismatch', 'packageId');
    if (bound.binding.packetRevision !== expected.packetRevision) return fail('revision_mismatch', 'packetRevision');
    if (bound.binding.contentHash !== expected.contentHash) return fail('content_hash_mismatch', 'contentHash');
    return fail('policy_hash_mismatch', 'policyHash');
  }
  const jobType = resolveCanonicalJobType(dispatch.jobType, envelope.jobTypes);
  if (!jobType.ok) return jobType;
  return { ok: true, binding: bound.binding };
}

export function rejectBindingMutation(
  existing: Record<string, unknown>,
  record: Record<string, unknown>,
): StoreResult<{ ok: true }> {
  const current = readDispatchBinding(existing);
  if (current.partial) return fail('partial_authority_group', 'binding');
  for (const key of DISPATCH_BINDING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined) {
      return fail('binding_immutable', key);
    }
  }
  if (current.complete) {
    for (const key of DISPATCH_BINDING_KEYS) {
      if (existing[key] === undefined || existing[key] === null) return fail('partial_authority_group', key);
    }
  }
  return { ok: true };
}

export function requireCompleteBinding(existing: Record<string, unknown> | null): StoreResult<{ binding: DispatchBinding }> {
  const read = readDispatchBinding(existing);
  if (read.partial) return fail('partial_authority_group', 'binding');
  if (!read.complete) return fail('unbound_dispatch', 'binding');
  return { ok: true, binding: read.binding as DispatchBinding };
}

export const DRIVER_DISPATCH_UPDATE_ALLOWLIST = Object.freeze([
  'status',
  'notes',
  'loadsCompleted',
  'invoiceDocId',
  'invoiceNumber',
] as const);

const DRIVER_UPDATE_TRANSITIONS: Record<string, readonly string[]> = {
  accepted: ['in_progress', 'paused', 'completed'],
  in_progress: ['paused', 'completed'],
  paused: ['in_progress', 'completed'],
};

export function evaluateExistingDispatchDriverUpdate(input: {
  existing: Record<string, unknown> | null;
  caller: { driverId: string; companyId: string };
  patch: Record<string, unknown>;
}): StoreResult<{ ok: true }> {
  if (!input.existing) return fail('cannot_create', 'dispatchId');
  const bound = requireCompleteBinding(input.existing);
  if (!bound.ok) return bound;
  const company = typeof input.existing.companyId === 'string' ? input.existing.companyId.trim() : '';
  const driver = typeof input.existing.driverId === 'string' ? input.existing.driverId.trim() : '';
  if (company !== input.caller.companyId) return fail('wrong_company');
  if (driver !== input.caller.driverId) return fail('other_driver');
  const bindGate = rejectBindingMutation(input.existing, input.patch);
  if (!bindGate.ok) return bindGate;
  for (const key of Object.keys(input.patch)) {
    if (input.patch[key] === undefined) continue;
    if (!(DRIVER_DISPATCH_UPDATE_ALLOWLIST as readonly string[]).includes(key)) {
      return fail('unexpected_field', key);
    }
  }
  const prev = typeof input.existing.status === 'string' ? input.existing.status.trim().toLowerCase() : '';
  if (['completed', 'cancelled', 'canceled', 'void'].includes(prev)) return fail('terminal_state', prev);
  if (typeof input.patch.status === 'string') {
    const next = input.patch.status.trim().toLowerCase();
    const allowed = DRIVER_UPDATE_TRANSITIONS[prev] || [];
    if (next !== prev && !allowed.includes(next)) return fail('invalid_transition', `${prev}->${next}`);
  }
  return { ok: true };
}

export function parseDispatchId(raw: unknown): StoreResult<{ dispatchId: string }> {
  if (typeof raw !== 'string' || !raw.trim()) return fail('dispatch_id_required', 'dispatchId');
  const dispatchId = raw.trim();
  if (dispatchId.length > 128 || dispatchId.includes('/')) return fail('malformed_dispatch_id', 'dispatchId');
  return { ok: true, dispatchId };
}
