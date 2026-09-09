/**
 * Proven e35184e create-if-absent semantics for driver self-create.
 * Auth stamps identity. Allowlisted job fields only. No legacy hash.
 */

export const DRIVER_DISPATCH_CREATE_ALLOWLIST = [
  'wellName',
  'ndicWellName',
  'operator',
  'jobType',
  'serviceType',
  'packageId',
  'disposal',
  'hauledTo',
  'driverName',
  'driverFirstName',
  'driverPlanId',
  'driverPlanSlot',
  'driverPlanCount',
  'priority',
  'notes',
] as const;

export type DriverDispatchCreateCaller = {
  driverId: string;
  companyId: string;
};

export type DriverDispatchCreateExisting = {
  driverId?: unknown;
  companyId?: unknown;
} | null;

export type DriverDispatchCreateDecision =
  | { ok: true; result: 'create'; fields: Record<string, unknown> }
  | { ok: true; result: 'already_exists' }
  | { ok: false; reason: string };

function normalizePlannedCount(count: number): number {
  if (!Number.isFinite(count)) return 1;
  return Math.max(1, Math.min(20, Math.trunc(count)));
}

export function mintDriverPlanId(nowMs: number, entropy: string): string {
  const clean = String(entropy || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
  return `${nowMs.toString(36)}${clean || 'x'}`;
}

export function driverPlannedDispatchId(planId: string, slot: number): string {
  const plan = String(planId || '').trim();
  const n = Number(slot);
  if (!plan || !Number.isFinite(n) || n < 1) return '';
  return `dplan_${plan}_${String(Math.trunc(n)).padStart(2, '0')}`;
}

export function driverPlannedDispatchIds(planId: string, count: number): string[] {
  const plan = String(planId || '').trim();
  if (!plan) return [];
  const n = normalizePlannedCount(count);
  const ids: string[] = [];
  for (let slot = 1; slot <= n; slot += 1) {
    ids.push(driverPlannedDispatchId(plan, slot));
  }
  return ids;
}

export function pickDriverDispatchCreateFields(
  record: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!record || typeof record !== 'object') return out;
  for (const key of DRIVER_DISPATCH_CREATE_ALLOWLIST) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  return out;
}

function mapJobType(picked: Record<string, unknown>): {
  jobType: 'pw' | 'service';
  serviceType?: string;
} {
  const raw = typeof picked.jobType === 'string' ? picked.jobType.trim() : '';
  const service = typeof picked.serviceType === 'string' ? picked.serviceType.trim() : '';
  if (raw === 'Production Water' || raw === 'pw') {
    return { jobType: 'pw' };
  }
  const serviceType = service || (raw && raw !== 'service' ? raw : '');
  return serviceType ? { jobType: 'service', serviceType } : { jobType: 'service' };
}

export function materializeDriverDispatchCreate(input: {
  caller: DriverDispatchCreateCaller;
  record: Record<string, unknown>;
}): Record<string, unknown> {
  const picked = pickDriverDispatchCreateFields(input.record);
  const mapped = mapJobType(picked);
  const { jobType: _dropped, serviceType: _droppedService, ...rest } = picked;
  void _dropped;
  void _droppedService;
  return {
    ...rest,
    ...mapped,
    driverId: input.caller.driverId,
    companyId: input.caller.companyId,
    driverHash: input.caller.driverId,
    source: 'driver',
    assignedBy: 'driver',
    status: 'pending',
    loadCount: 1,
    loadsCompleted: 0,
    priority: typeof picked.priority === 'number' ? picked.priority : 0,
  };
}

export function evaluateDriverDispatchCreate(input: {
  dispatchId: string;
  caller: DriverDispatchCreateCaller | null | undefined;
  existing: DriverDispatchCreateExisting;
  record: Record<string, unknown>;
}): DriverDispatchCreateDecision {
  const dispatchId = typeof input.dispatchId === 'string' ? input.dispatchId.trim() : '';
  if (!dispatchId) return { ok: false, reason: 'dispatchId_required' };
  const driverId = typeof input.caller?.driverId === 'string' ? input.caller.driverId.trim() : '';
  const companyId = typeof input.caller?.companyId === 'string' ? input.caller.companyId.trim() : '';
  if (!driverId || !companyId) return { ok: false, reason: 'unauthenticated_driver' };

  const wellName = typeof input.record?.wellName === 'string' ? input.record.wellName.trim() : '';
  if (!wellName) return { ok: false, reason: 'well_required' };

  const planId = typeof input.record?.driverPlanId === 'string' ? input.record.driverPlanId.trim() : '';
  const slotRaw = input.record?.driverPlanSlot;
  const slot = typeof slotRaw === 'number' ? slotRaw : Number(slotRaw);
  if (planId && Number.isFinite(slot) && slot >= 1) {
    const expected = driverPlannedDispatchId(planId, slot);
    if (dispatchId !== expected) return { ok: false, reason: 'dispatchId_mismatch' };
  }

  if (input.existing) {
    const existingDriver = typeof input.existing.driverId === 'string' ? input.existing.driverId.trim() : '';
    const existingCompany = typeof input.existing.companyId === 'string' ? input.existing.companyId.trim() : '';
    if (existingDriver === driverId && existingCompany === companyId) {
      return { ok: true, result: 'already_exists' };
    }
    return { ok: false, reason: 'conflict' };
  }

  return {
    ok: true,
    result: 'create',
    fields: materializeDriverDispatchCreate({
      caller: { driverId, companyId },
      record: input.record,
    }),
  };
}

export async function runCreateDriverDispatchIfAbsent(input: {
  dispatchId: string;
  caller: DriverDispatchCreateCaller;
  record: Record<string, unknown>;
  get: (id: string) => Promise<DriverDispatchCreateExisting>;
  create: (id: string, fields: Record<string, unknown>) => Promise<void>;
}): Promise<{ result: 'created' | 'already_exists' }> {
  const existing = await input.get(input.dispatchId);
  const decided = evaluateDriverDispatchCreate({
    dispatchId: input.dispatchId,
    caller: input.caller,
    existing,
    record: input.record,
  });
  if (!decided.ok) {
    throw new Error(decided.reason);
  }
  if (decided.result === 'already_exists') return { result: 'already_exists' };
  await input.create(input.dispatchId, decided.fields);
  return { result: 'created' };
}
