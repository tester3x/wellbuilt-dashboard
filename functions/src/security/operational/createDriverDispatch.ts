import { driverRequestedJobType } from './driverJobTypeCompatibility';
import { fail, type StoreResult } from './jobPacketRevisionStore';
import {
  canonicalWellFromRecord,
  evaluateCreateIfAbsent,
  parseDispatchId,
  rejectCallerAuthorityFields,
  resolveCanonicalJobType,
  stampDispatchBinding,
  type BirthIdentity,
  type DispatchBinding,
} from './dispatchPacketPin';
import type { ImmutableRevisionEnvelope } from './jobPacketRevisionStore';

export const CREATE_DRIVER_DISPATCH_CALLABLE = 'createDriverDispatchIfAbsent';

export const DRIVER_DISPATCH_CREATE_ALLOWLIST = Object.freeze([
  'wellName',
  'ndicWellName',
  'operator',
  'jobType',
  'jobTypeId',
  'serviceType',
  'disposal',
  'hauledTo',
  'driverFirstName',
  'driverPlanId',
  'driverPlanSlot',
  'driverPlanCount',
  'priority',
  'notes',
  'projectId',
  'splitGroupId',
  'splitSequence',
  'splitTotal',
  'bbls',
  'isHeavyWater',
] as const);

export function driverMayJoinProject(project: Record<string, unknown> | null, caller: { companyId: string; driverId: string }, record: Record<string, unknown>): boolean {
  if (!project || project.status !== 'active' || project.companyId !== caller.companyId) return false;
  const roster = [
    ...(Array.isArray(project.dayDriverIds) ? project.dayDriverIds : []),
    ...(Array.isArray(project.nightDriverIds) ? project.nightDriverIds : []),
    ...(Array.isArray(project.dayDriverHashes) ? project.dayDriverHashes : []),
    ...(Array.isArray(project.nightDriverHashes) ? project.nightDriverHashes : []),
  ];
  if (!roster.includes(caller.driverId)) return false;
  if (typeof project.operatorName === 'string' && project.operatorName.trim() &&
      typeof record.operator === 'string' && project.operatorName.trim().toLowerCase() !== record.operator.trim().toLowerCase()) return false;
  return true;
}

export function pickDriverCreateFields(record: Record<string, unknown>): StoreResult<{ fields: Record<string, unknown> }> {
  const rejected = rejectCallerAuthorityFields(record);
  if (!rejected.ok) return rejected;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) continue;
    if (!(DRIVER_DISPATCH_CREATE_ALLOWLIST as readonly string[]).includes(key)) {
      return fail('unexpected_field', key);
    }
    out[key] = record[key];
  }
  return { ok: true, fields: out };
}

export function materializeDriverCreate(input: {
  caller: { driverId: string; companyId: string };
  fields: Record<string, unknown>;
  jobTypeId: string;
  binding: DispatchBinding;
}): Record<string, unknown> {
  return {
    ...input.fields,
    jobTypeId: input.jobTypeId,
    jobType: input.jobTypeId === 'pw' ? 'pw' : 'service',
    driverId: input.caller.driverId,
    companyId: input.caller.companyId,
    driverHash: input.caller.driverId,
    source: 'driver',
    assignedBy: 'driver',
    status: 'pending',
    loadCount: 1,
    loadsCompleted: 0,
    priority: typeof input.fields.priority === 'number' ? input.fields.priority : 0,
    ...input.binding,
  };
}

export function evaluateDriverDispatchBirth(input: {
  dispatchId: unknown;
  caller: { driverId: string; companyId: string } | null;
  existing: Record<string, unknown> | null;
  record: Record<string, unknown>;
  envelope: ImmutableRevisionEnvelope;
  companyCustomJobTypes?: unknown[];
}): StoreResult<{ result: 'create' | 'already_exists'; fields?: Record<string, unknown>; identity?: BirthIdentity }> {
  const id = parseDispatchId(input.dispatchId);
  if (!id.ok) return id;
  if (!input.caller?.driverId || !input.caller.companyId) return fail('unauthenticated_driver');
  const picked = pickDriverCreateFields(input.record);
  if (!picked.ok) return picked;
  const requestedJobType = driverRequestedJobType(picked.fields);
  const jobType = resolveCanonicalJobType(requestedJobType, input.envelope.jobTypes, input.companyCustomJobTypes);
  if (!jobType.ok) return jobType;
  // Preserve the governed job label (and the one hourly PW service variant)
  // without letting a caller invent an unrelated billing subtype.
  if (picked.fields.serviceType !== undefined) {
    const subtype = picked.fields.serviceType;
    const publishedLabel = input.envelope.jobTypes.find(jt => jt.jobTypeId === jobType.jobTypeId)?.label;
    const customLabel = input.companyCustomJobTypes?.map(raw => {
      if (typeof raw === 'string') return { id: raw.toLowerCase().replace(/[\s_]+/g, '-'), label: raw };
      if (!raw || typeof raw !== 'object') return null;
      const entry = raw as { id?: unknown; label?: unknown };
      if (typeof entry.label !== 'string') return null;
      return { id: typeof entry.id === 'string' ? entry.id : entry.label.toLowerCase().replace(/[\s_]+/g, '-'), label: entry.label };
    }).find(entry => entry?.id === jobType.jobTypeId)?.label;
    const allowed = jobType.jobTypeId !== 'pw' &&
      ((jobType.jobTypeId === 'service-work' && subtype === 'Production Water') ||
        subtype === publishedLabel || subtype === customLabel);
    if (!allowed) return fail('invalid_service_type');
  }
  const binding = stampDispatchBinding(input.envelope);
  const well = canonicalWellFromRecord(picked.fields);
  const identity: BirthIdentity = {
    companyId: input.caller.companyId,
    driverId: input.caller.driverId,
    jobTypeId: jobType.jobTypeId,
    binding,
    well,
  };
  const replay = evaluateCreateIfAbsent({ existing: input.existing, expected: identity });
  if (!replay.ok) return replay;
  if (replay.result === 'already_exists') return { ok: true, result: 'already_exists', identity };
  return {
    ok: true,
    result: 'create',
    identity,
    fields: materializeDriverCreate({
      caller: input.caller,
      fields: picked.fields,
      jobTypeId: jobType.jobTypeId,
      binding,
    }),
  };
}
