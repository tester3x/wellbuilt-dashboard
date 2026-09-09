import {
  DRIVER_DISPATCH_CREATE_ALLOWLIST,
  driverPlannedDispatchIds,
  evaluateDriverDispatchCreate,
  materializeDriverDispatchCreate,
  mintDriverPlanId,
  runCreateDriverDispatchIfAbsent,
} from '../driverDispatchCreateCore';

const UUID = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const COMPANY = 'liquid-gold';
const OTHER = 'acme-hauling';
const caller = { driverId: UUID, companyId: COMPANY };
const record = { wellName: 'Gabriel 1', operator: 'WPX', jobType: 'Production Water', driverName: 'Mike' };

describe('evaluateDriverDispatchCreate', () => {
  it('stamps auth identity, allowlists fields, and ignores client tenancy', () => {
    const decided = evaluateDriverDispatchCreate({
      dispatchId: 'dplan_abc_01',
      caller,
      existing: null,
      record: { ...record, driverId: 'forged', companyId: OTHER, source: 'dashboard', status: 'completed' },
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok || decided.result !== 'create') return;
    expect(decided.fields.driverId).toBe(UUID);
    expect(decided.fields.companyId).toBe(COMPANY);
    expect(decided.fields.source).toBe('driver');
    expect(decided.fields.assignedBy).toBe('driver');
    expect(decided.fields.status).toBe('pending');
    expect(decided.fields.driverHash).toBe(UUID);
    expect(decided.fields.jobType).toBe('pw');
    expect(decided.fields).not.toHaveProperty('isAdmin');
  });

  it('same-owner replay is already_exists; conflict writes nothing', () => {
    expect(evaluateDriverDispatchCreate({
      dispatchId: 'dplan_abc_01',
      caller,
      existing: { driverId: UUID, companyId: COMPANY },
      record,
    })).toEqual({ ok: true, result: 'already_exists' });
    expect(evaluateDriverDispatchCreate({
      dispatchId: 'dplan_abc_01',
      caller,
      existing: { driverId: 'other-driver', companyId: COMPANY },
      record,
    })).toEqual({ ok: false, reason: 'conflict' });
  });

  it('rejects unauthenticated / missing company / missing well', () => {
    expect(evaluateDriverDispatchCreate({
      dispatchId: 'x', caller: null, existing: null, record,
    }).ok).toBe(false);
    expect(evaluateDriverDispatchCreate({
      dispatchId: 'x', caller: { driverId: UUID, companyId: '' }, existing: null, record,
    })).toEqual({ ok: false, reason: 'unauthenticated_driver' });
    expect(evaluateDriverDispatchCreate({
      dispatchId: 'x', caller, existing: null, record: { operator: 'WPX' },
    })).toEqual({ ok: false, reason: 'well_required' });
  });

  it('keeps Flowback Water as service and Production Water as pw', () => {
    const fb = materializeDriverDispatchCreate({
      caller,
      record: { wellName: 'G1', jobType: 'Flowback Water' },
    });
    expect(fb.jobType).toBe('service');
    expect(fb.serviceType).toBe('Flowback Water');
    const pw = materializeDriverDispatchCreate({
      caller,
      record: { wellName: 'G1', jobType: 'Production Water' },
    });
    expect(pw.jobType).toBe('pw');
    expect(pw).not.toHaveProperty('serviceType');
  });

  it('drops non-allowlisted fields', () => {
    const fields = materializeDriverDispatchCreate({
      caller,
      record: { wellName: 'G1', extra: 'nope', isAdmin: true },
    });
    expect(fields).not.toHaveProperty('extra');
    expect(fields).not.toHaveProperty('isAdmin');
    expect(DRIVER_DISPATCH_CREATE_ALLOWLIST).toContain('wellName');
  });

  it('requires deterministic dplan_{planId}_{slot} ids', () => {
    const planId = mintDriverPlanId(1_700_000_000_000, 'entropy01');
    const ids = driverPlannedDispatchIds(planId, 3);
    expect(ids).toEqual(driverPlannedDispatchIds(planId, 3));
    expect(ids).toHaveLength(3);
    expect(ids[0]).toMatch(/^dplan_/);
    expect(evaluateDriverDispatchCreate({
      dispatchId: ids[0],
      caller,
      existing: null,
      record: { ...record, driverPlanId: planId, driverPlanSlot: 1 },
    }).ok).toBe(true);
    expect(evaluateDriverDispatchCreate({
      dispatchId: 'other-id',
      caller,
      existing: null,
      record: { ...record, driverPlanId: planId, driverPlanSlot: 1 },
    })).toEqual({ ok: false, reason: 'dispatchId_mismatch' });
  });

  it('create-if-absent is idempotent and conflict-safe', async () => {
    const mem = new Map<string, Record<string, unknown>>();
    const store = {
      get: async (id: string) => mem.get(id) || null,
      create: async (id: string, doc: Record<string, unknown>) => {
        if (mem.has(id)) throw new Error('overwrite');
        mem.set(id, doc);
      },
    };
    const first = await runCreateDriverDispatchIfAbsent({ dispatchId: 'id-1', caller, record, ...store });
    const second = await runCreateDriverDispatchIfAbsent({ dispatchId: 'id-1', caller, record, ...store });
    expect(first.result).toBe('created');
    expect(second.result).toBe('already_exists');
    expect(mem.get('id-1')?.status).toBe('pending');
    await expect(runCreateDriverDispatchIfAbsent({
      dispatchId: 'id-1',
      caller: { driverId: 'other', companyId: COMPANY },
      record,
      ...store,
    })).rejects.toThrow('conflict');
    expect(mem.get('id-1')?.driverId).toBe(UUID);
  });
});
