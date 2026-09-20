import { fail, revisionDocId, type StoreResult } from './jobPacketRevisionStore';
import {
  evaluateCreateIfAbsent,
  evaluateWellAuthorized,
  loadVerifiedRevisionFromData,
  parseDispatchId,
  parsePacketRef,
  readCanonicalWell,
  rejectCallerAuthorityFields,
  requireCompleteBinding,
  resolveCanonicalJobType,
  stampDispatchBinding,
  verifyDispatchPinsAgainstEnvelope,
  type BirthIdentity,
  type DispatchBinding,
} from './dispatchPacketPin';

export const ADD_SPLIT_LEG_CALLABLE = 'addSplitLeg';

export const CHILD_DISPATCH_ID_REQUIRED = 'child_dispatch_id_required';

export const FUTURE_WBT_SPLIT_LEG_WIRING =
  'Future WB-T wiring: AddSplitLegModal must send a client-minted dispatchId (exact child document id) together with parentDispatchId and legSpec. Server auto-ids (.doc()/.add()) are forbidden.';

export const ADD_SPLIT_LEG_REQUEST_KEYS = Object.freeze([
  'parentDispatchId',
  'dispatchId',
  'callerDriverHash',
  'legSpec',
] as const);

export const LEG_SPEC_KEYS = Object.freeze([
  'disposal',
  'disposalLat',
  'disposalLng',
  'bbls',
  'jobType',
  'serviceType',
  'notes',
  'destinationType',
] as const);

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function matchOptionalCallerDriverHash(
  callerDriverId: string,
  callerDriverHash: unknown,
): StoreResult<{ ok: true }> {
  if (callerDriverHash === undefined || callerDriverHash === null || callerDriverHash === '') {
    return { ok: true };
  }
  if (typeof callerDriverHash !== 'string' || callerDriverHash.trim() !== callerDriverId) {
    return fail('other_driver', 'callerDriverHash');
  }
  return { ok: true };
}

function parseLegSpec(raw: unknown): StoreResult<{
  disposal: string;
  jobType?: string;
  fields: Record<string, unknown>;
}> {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('leg_spec_required', 'legSpec');
  }
  const obj = raw as Record<string, unknown>;
  const authority = rejectCallerAuthorityFields(obj);
  if (!authority.ok) return authority;
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) continue;
    if (!(LEG_SPEC_KEYS as readonly string[]).includes(key)) {
      return fail('unexpected_field', `legSpec.${key}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'wellName') || Object.prototype.hasOwnProperty.call(obj, 'ndicWellName')) {
    return fail('caller_well_not_authority', 'wellName');
  }
  const disposal = str(obj.disposal);
  if (!disposal) return fail('disposal_required', 'legSpec.disposal');
  const fields: Record<string, unknown> = { disposal };
  if (typeof obj.disposalLat === 'number' && Number.isFinite(obj.disposalLat)) fields.disposalLat = obj.disposalLat;
  if (typeof obj.disposalLng === 'number' && Number.isFinite(obj.disposalLng)) fields.disposalLng = obj.disposalLng;
  if (typeof obj.bbls === 'number' && Number.isFinite(obj.bbls)) fields.bbls = obj.bbls;
  if (typeof obj.serviceType === 'string' && obj.serviceType.trim()) fields.serviceType = obj.serviceType.trim();
  if (typeof obj.notes === 'string') fields.notes = obj.notes;
  if (typeof obj.destinationType === 'string' && obj.destinationType.trim()) {
    fields.destinationType = obj.destinationType.trim();
  }
  const jobType = typeof obj.jobType === 'string' && obj.jobType.trim() ? obj.jobType.trim() : undefined;
  return { ok: true, disposal, jobType, fields };
}

function parentOwnedByCaller(
  parent: Record<string, unknown>,
  caller: { driverId: string; companyId: string },
): StoreResult<{ ok: true }> {
  const company = str(parent.companyId);
  if (!company || company !== caller.companyId) return fail('wrong_company');
  const assigned = str(parent.driverId);
  if (!assigned || assigned !== caller.driverId) return fail('other_driver');
  return { ok: true };
}

function materializeChild(input: {
  caller: { driverId: string; companyId: string };
  parent: Record<string, unknown>;
  parentDispatchId: string;
  binding: DispatchBinding;
  well: { wellName: string; ndicWellName: string };
  jobTypeId: string;
  splitGroupId: string;
  splitSequence: number;
  splitTotal: number;
  rootParentId: string;
  fields: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    driverId: input.caller.driverId,
    driverHash: str(input.parent.driverHash) || input.caller.driverId,
    driverName: input.parent.driverName ?? null,
    driverFirstName: input.parent.driverFirstName ?? null,
    wellName: input.well.wellName,
    ndicWellName: input.well.ndicWellName,
    operator: input.parent.operator ?? null,
    companyId: input.caller.companyId,
    priority: typeof input.parent.priority === 'number' ? input.parent.priority : 5,
    onsiteBy: input.parent.onsiteBy ?? null,
    ...input.fields,
    jobType: input.jobTypeId,
    ...input.binding,
    splitGroupId: input.splitGroupId,
    splitSequence: input.splitSequence,
    splitTotal: input.splitTotal,
    parentDispatchId: input.rootParentId,
    splitOriginatedAt: 'field',
    splitOriginatedBy: `driver:${input.caller.driverId}`,
    status: 'pending',
    assignedBy: `driver:${input.caller.driverId}`,
    source: 'driver',
    loadCount: 1,
    loadsCompleted: 0,
  };
}

export async function runAddSplitLeg(input: {
  caller: { driverId: string; companyId: string } | null;
  parentDispatchId: unknown;
  dispatchId: unknown;
  callerDriverHash?: unknown;
  legSpec?: unknown;
  authorizedWells: readonly string[];
  getDispatch: (id: string) => Promise<Record<string, unknown> | null>;
  getRevision: (id: string) => Promise<{ exists: boolean; data?: Record<string, unknown> }>;
  listSiblings: (splitGroupId: string) => Promise<Array<{ id: string; data: Record<string, unknown> }>>;
  listInvoices?: (splitGroupId: string) => Promise<Array<{ id: string }>>;
  applyCreate: (id: string, data: Record<string, unknown>) => void;
  applySiblingTotal?: (id: string, total: number) => void;
  applyInvoiceTotal?: (id: string, total: number) => void;
}): Promise<StoreResult<{
  result: 'created' | 'already_exists';
  dispatchId: string;
  splitGroupId: string;
  splitSequence: number;
  splitTotal: number;
  revisionDocId: string;
}>> {
  if (!input.caller?.driverId || !input.caller.companyId) return fail('unauthenticated_driver');
  const hashGate = matchOptionalCallerDriverHash(input.caller.driverId, input.callerDriverHash);
  if (!hashGate.ok) return hashGate;
  if (typeof input.dispatchId !== 'string' || !input.dispatchId.trim()) {
    return fail(CHILD_DISPATCH_ID_REQUIRED, 'dispatchId');
  }
  const childId = parseDispatchId(input.dispatchId);
  if (!childId.ok) return childId;
  const parentId = parseDispatchId(input.parentDispatchId);
  if (!parentId.ok) return fail('parent_dispatch_id_required', 'parentDispatchId');
  const spec = parseLegSpec(input.legSpec);
  if (!spec.ok) return spec;

  const parent = await input.getDispatch(parentId.dispatchId);
  if (!parent) return fail('not_found', 'parentDispatchId');
  const childExisting = await input.getDispatch(childId.dispatchId);

  const owned = parentOwnedByCaller(parent, input.caller);
  if (!owned.ok) return owned;
  const bound = requireCompleteBinding(parent);
  if (!bound.ok) return bound;
  const selector = parsePacketRef({
    packageId: bound.binding.packageId,
    revision: bound.binding.packetRevision,
  });
  if (!selector.ok) return selector;
  const revId = revisionDocId(input.caller.companyId, selector.packetRef.packageId, selector.packetRef.revision);
  const revSnap = await input.getRevision(revId);
  const loaded = await loadVerifiedRevisionFromData(
    revSnap.exists,
    revSnap.data,
    input.caller.companyId,
    selector.packetRef,
  );
  if (!loaded.ok) return loaded;
  const pins = verifyDispatchPinsAgainstEnvelope(parent, loaded.envelope, input.caller.companyId);
  if (!pins.ok) return pins;

  const parentWell = readCanonicalWell(parent);
  if (!parentWell.ok) return parentWell;
  const wellGate = evaluateWellAuthorized(
    parentWell.well.wellName,
    parentWell.well.ndicWellName,
    input.authorizedWells,
  );
  if (!wellGate.ok) return wellGate;

  const requestedType = spec.jobType || str(parent.jobType);
  const jobType = resolveCanonicalJobType(requestedType, loaded.envelope.jobTypes);
  if (!jobType.ok) return jobType;

  const splitGroupId = str(parent.splitGroupId);
  if (!splitGroupId) return fail('parent_not_split_chain', 'splitGroupId');

  const identity: BirthIdentity = {
    companyId: input.caller.companyId,
    driverId: input.caller.driverId,
    jobTypeId: jobType.jobTypeId,
    binding: stampDispatchBinding(loaded.envelope),
    well: parentWell.well,
  };
  const replay = evaluateCreateIfAbsent({ existing: childExisting, expected: identity });
  if (!replay.ok) return replay;
  if (replay.result === 'already_exists') {
    return {
      ok: true,
      result: 'already_exists',
      dispatchId: childId.dispatchId,
      splitGroupId,
      splitSequence: typeof childExisting?.splitSequence === 'number' ? childExisting.splitSequence : 0,
      splitTotal: typeof childExisting?.splitTotal === 'number' ? childExisting.splitTotal : 0,
      revisionDocId: loaded.revisionDocId,
    };
  }

  const siblings = await input.listSiblings(splitGroupId);
  const invoiceIds = input.listInvoices ? await input.listInvoices(splitGroupId) : [];
  const sibs = siblings.some((s) => s.id === parentId.dispatchId)
    ? siblings
    : [...siblings, { id: parentId.dispatchId, data: parent }];
  if (!sibs.length) return fail('split_siblings_missing', 'splitGroupId');
  let maxSequence = 0;
  let leg1Id: string | null = null;
  for (const sib of sibs) {
    const seq = typeof sib.data.splitSequence === 'number' ? sib.data.splitSequence : 0;
    if (seq > maxSequence) maxSequence = seq;
    if (seq === 1) leg1Id = sib.id;
  }
  const splitSequence = maxSequence + 1;
  const splitTotal = sibs.length + 1;
  const fields = materializeChild({
    caller: input.caller,
    parent,
    parentDispatchId: parentId.dispatchId,
    binding: identity.binding,
    well: identity.well,
    jobTypeId: jobType.jobTypeId,
    splitGroupId,
    splitSequence,
    splitTotal,
    rootParentId: leg1Id || parentId.dispatchId,
    fields: spec.fields,
  });
  input.applyCreate(childId.dispatchId, fields);
  if (input.applySiblingTotal) {
    for (const sib of sibs) input.applySiblingTotal(sib.id, splitTotal);
  }
  if (input.applyInvoiceTotal) {
    for (const inv of invoiceIds) input.applyInvoiceTotal(inv.id, splitTotal);
  }
  return {
    ok: true,
    result: 'created',
    dispatchId: childId.dispatchId,
    splitGroupId,
    splitSequence,
    splitTotal,
    revisionDocId: loaded.revisionDocId,
  };
}
