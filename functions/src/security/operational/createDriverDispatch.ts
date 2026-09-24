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
  'disposal',
  'hauledTo',
  'driverFirstName',
  'driverPlanId',
  'driverPlanSlot',
  'driverPlanCount',
  'priority',
  'notes',
] as const);

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
    jobType: input.jobTypeId,
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
}): StoreResult<{ result: 'create' | 'already_exists'; fields?: Record<string, unknown>; identity?: BirthIdentity }> {
  const id = parseDispatchId(input.dispatchId);
  if (!id.ok) return id;
  if (!input.caller?.driverId || !input.caller.companyId) return fail('unauthenticated_driver');
  const picked = pickDriverCreateFields(input.record);
  if (!picked.ok) return picked;
  const jobType = resolveCanonicalJobType(picked.fields.jobType, input.envelope.jobTypes);
  if (!jobType.ok) return jobType;
  const binding = stampDispatchBinding(input.envelope);
  const well = canonicalWellFromRecord(picked.fields);
  if (!well.wellName && !well.ndicWellName) return fail('well_required', 'wellName');
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
