import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CANCEL_ALLOWED_FROM,
  CANCEL_TERMINAL,
  CREATE_STATUSES,
  UPDATE_STATUS_TRANSITIONS,
  evaluateStaffWriteDispatch,
  materializeStaffCreate,
  serializeStaffDispatchRecord,
  DISPATCH_CREATE_ALLOWLIST,
  DISPATCH_UPDATE_ALLOWLIST,
} from '../staffWriteDispatch';

const lg = { callerCompanyId: 'liquid-gold', isPlatformAdmin: false };

function ts(ms: number) {
  return { toMillis: () => ms };
}

describe('status transition table', () => {
  it('publishes the exact create / cancel / update contract', () => {
    expect([...CREATE_STATUSES]).toEqual(['pending']);
    expect([...CANCEL_ALLOWED_FROM]).toEqual([
      'pending', 'pending_approval', 'accepted', 'in_progress', 'paused',
    ]);
    expect([...CANCEL_TERMINAL]).toEqual(['completed', 'dismissed', 'declined']);
    expect(UPDATE_STATUS_TRANSITIONS.pending_approval).toEqual(['pending']);
    expect(UPDATE_STATUS_TRANSITIONS.pending).toEqual([]);
    expect(UPDATE_STATUS_TRANSITIONS.completed).toEqual([]);
  });

  it('rejects unknown status strings', () => {
    expect(evaluateStaffWriteDispatch({
      op: 'create', job: null, record: { wellName: 'G', status: 'bogus' }, ...lg,
    })).toMatchObject({ ok: false, reason: 'unknown_status' });
  });

  it('restricts create to pending', () => {
    expect(evaluateStaffWriteDispatch({
      op: 'create', job: null, record: { wellName: 'G', status: 'accepted' }, ...lg,
    })).toMatchObject({ ok: false, reason: 'invalid_create_status' });
    expect(evaluateStaffWriteDispatch({
      op: 'create', job: null, record: { wellName: 'G', status: 'pending' }, ...lg,
    }).ok).toBe(true);
  });

  it('enforces permitted update transitions', () => {
    expect(evaluateStaffWriteDispatch({
      op: 'update',
      job: { status: 'pending_approval', companyId: 'liquid-gold' },
      record: { status: 'pending' },
      ...lg,
    }).ok).toBe(true);
    expect(evaluateStaffWriteDispatch({
      op: 'update',
      job: { status: 'pending', companyId: 'liquid-gold' },
      record: { status: 'accepted' },
      ...lg,
    })).toMatchObject({ ok: false, reason: 'invalid_transition' });
    expect(evaluateStaffWriteDispatch({
      op: 'update',
      job: { status: 'completed', companyId: 'liquid-gold' },
      record: { notes: 'ok' },
      ...lg,
    }).ok).toBe(true);
  });

  it('cancel does not overwrite terminal states; cancelled is idempotent', () => {
    for (const status of CANCEL_TERMINAL) {
      expect(evaluateStaffWriteDispatch({
        op: 'cancel',
        job: { status, companyId: 'liquid-gold' },
        ...lg,
      })).toMatchObject({ ok: false, reason: 'terminal_state' });
    }
    expect(evaluateStaffWriteDispatch({
      op: 'cancel',
      job: { status: 'cancelled', companyId: 'liquid-gold' },
      ...lg,
    })).toMatchObject({ ok: true, idempotent: true });
    expect(evaluateStaffWriteDispatch({
      op: 'cancel',
      job: { status: 'in_progress', companyId: 'liquid-gold' },
      ...lg,
    }).ok).toBe(true);
  });

  it('status dismissed remains dismissDispatch-only and companyId is immutable', () => {
    expect(evaluateStaffWriteDispatch({
      op: 'create', job: null, record: { wellName: 'G', status: 'dismissed' }, ...lg,
    })).toMatchObject({ ok: false, reason: 'use_dismiss_callable' });
    expect(evaluateStaffWriteDispatch({
      op: 'update',
      job: { status: 'pending', companyId: 'liquid-gold' },
      record: { status: 'dismissed' },
      ...lg,
    })).toMatchObject({ ok: false, reason: 'use_dismiss_callable' });
    expect(evaluateStaffWriteDispatch({
      op: 'update',
      job: { status: 'pending', companyId: 'liquid-gold' },
      record: { companyId: 'acme-hauling' },
      ...lg,
    })).toMatchObject({ ok: false, reason: 'company_immutable' });
  });

  it('never accepts decline field writes on staff update/cancel/create', () => {
    expect(evaluateStaffWriteDispatch({
      op: 'update',
      job: { status: 'declined', companyId: 'liquid-gold', declineReason: 'full' },
      record: { declineReason: '' },
      ...lg,
    })).toMatchObject({ ok: false, reason: 'decline_fields_immutable' });
    expect(evaluateStaffWriteDispatch({
      op: 'cancel',
      job: { status: 'pending', companyId: 'liquid-gold' },
      record: { declinedAt: null },
      ...lg,
    })).toMatchObject({ ok: false, reason: 'decline_fields_immutable' });
  });
});

describe('jsonSafe / timestamp serialization', () => {
  it('omits assignedAt as server-authoritative and serializes other timestamps', () => {
    const out = serializeStaffDispatchRecord({
      wellName: 'Gab 1',
      assignedAt: ts(1_700_000_000_000),
      onsiteBy: '08:00',
    }, DISPATCH_CREATE_ALLOWLIST);
    expect(out.ok).toBe(true);
    expect(out.record?.assignedAt).toBeUndefined();
    expect(out.record?.wellName).toBe('Gab 1');
    expect(out.record?.onsiteBy).toBe('08:00');
  });

  it('does not silently drop an allowed Timestamp-like business field', () => {
    const out = serializeStaffDispatchRecord({
      wellName: 'Gab 1',
      onsiteBy: ts(1_700_000_123_000),
    }, DISPATCH_CREATE_ALLOWLIST);
    expect(out.ok).toBe(true);
    expect(out.record?.onsiteBy).toEqual({ seconds: 1700000123, nanoseconds: 0 });
  });

  it('rejects Timestamp-like values on unknown keys instead of dropping them', () => {
    const out = serializeStaffDispatchRecord({
      wellName: 'Gab 1',
      mysteryTime: ts(1),
    }, DISPATCH_CREATE_ALLOWLIST);
    expect(out).toMatchObject({ ok: false, reason: 'unexpected_field', field: 'mysteryTime' });
  });
});

describe('payload parity fixtures', () => {
  const caller = { companyId: 'liquid-gold', isPlatformAdmin: false };

  function preserved(record: Record<string, unknown>, expected: Record<string, unknown>) {
    const out = materializeStaffCreate(record, caller);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    for (const [key, val] of Object.entries(expected)) {
      expect(out.fields[key]).toEqual(val);
    }
    expect(out.fields.assignedAt).toEqual({ _serverTimestamp: true });
    expect(out.fields.companyId).toBe('liquid-gold');
  }

  it('normal PW', () => {
    preserved({
      driverHash: 'h1', driverName: 'gab1', driverFirstName: 'Gab',
      wellName: 'Python', ndicWellName: 'PYTHON 1', route: 'North',
      jobType: 'pw', packageId: 'water-hauling', status: 'pending',
      notes: '', priority: 1, assignedBy: 'mike@', estimatedPullTime: '',
      currentLevel: '5\'0"', flowRate: '1:00',
    }, { wellName: 'Python', jobType: 'pw', packageId: 'water-hauling', status: 'pending' });
  });

  it('multi-load PW', () => {
    preserved({
      wellName: 'Python', jobType: 'pw', status: 'pending', loadCount: 4,
      driverHash: 'h1', driverName: 'gab1',
    }, { loadCount: 4, wellName: 'Python' });
  });

  it('SW', () => {
    preserved({
      wellName: 'Python', jobType: 'service', serviceType: 'Hot Shot',
      status: 'pending', onsiteBy: '07:30', isHeavyWater: true,
      driverHash: 'h1', driverName: 'gab1', serviceGroupId: 'sg_1',
      assignedDrivers: ['Gab', 'Ty'],
    }, { serviceType: 'Hot Shot', onsiteBy: '07:30', isHeavyWater: true, serviceGroupId: 'sg_1' });
  });

  it('split legs A/B carry splitTotal', () => {
    preserved({
      wellName: 'Python', jobType: 'service', status: 'pending',
      splitGroupId: 'split_1', splitSequence: 1, splitTotal: 3,
      driverHash: 'h1', driverName: 'gab1',
    }, { splitGroupId: 'split_1', splitSequence: 1, splitTotal: 3 });
    preserved({
      wellName: 'SWD X', jobType: 'service', status: 'pending',
      splitGroupId: 'split_1', splitSequence: 2, splitTotal: 3,
      driverHash: 'h1', driverName: 'gab1',
    }, { splitSequence: 2, splitTotal: 3 });
  });

  it('extra split leg preserves splitTotal and bbls', () => {
    const out = materializeStaffCreate({
      wellName: 'SWD Extra', ndicWellName: 'SWD Extra', disposal: 'SWD Extra',
      jobType: 'service', serviceType: 'Hot Shot', status: 'pending',
      splitGroupId: 'split_1', splitSequence: 3, splitTotal: 3, bbls: 140,
      driverHash: 'h1', driverName: 'gab1',
    }, caller);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.fields.splitTotal).toBe(3);
    expect(out.fields.bbls).toBe(140);
    expect(out.fields.splitSequence).toBe(3);
    expect(DISPATCH_CREATE_ALLOWLIST).toEqual(expect.arrayContaining(['splitTotal', 'bbls']));
  });

  it('project dispatch', () => {
    preserved({
      wellName: 'Python', jobType: 'service', serviceType: null, notes: null,
      status: 'pending', projectId: 'proj1', operator: 'Kraken',
      driverHash: 'h1', driverName: 'gab1', priority: 500,
    }, { projectId: 'proj1', operator: 'Kraken', serviceType: null, notes: null });
  });

  it('transfer update pending_approval → pending is the allowed transition', () => {
    expect(evaluateStaffWriteDispatch({
      op: 'update',
      job: { status: 'pending_approval', companyId: 'liquid-gold' },
      record: { driverHash: 'h2', driverName: 'Ty', driverFirstName: 'Ty', status: 'pending' },
      ...lg,
    }).ok).toBe(true);
  });

  it('partial reassign updates loadCount only', () => {
    expect(evaluateStaffWriteDispatch({
      op: 'update',
      job: { status: 'pending', companyId: 'liquid-gold', loadCount: 4 },
      record: { loadCount: 2 },
      ...lg,
    }).ok).toBe(true);
  });

  it('full reassign create preserves job fields then cancel is allowed', () => {
    preserved({
      wellName: 'Python', jobType: 'pw', status: 'pending',
      driverHash: 'h2', driverName: 'Ty', packageId: 'water-hauling',
      disposal: 'SWD',
    }, { disposal: 'SWD', driverHash: 'h2' });
    expect(evaluateStaffWriteDispatch({
      op: 'cancel',
      job: { status: 'pending', companyId: 'liquid-gold' },
      ...lg,
    }).ok).toBe(true);
  });

  it('completed-job edit patches fields without changing status', () => {
    expect(evaluateStaffWriteDispatch({
      op: 'update',
      job: { status: 'completed', companyId: 'liquid-gold', declineReason: 'n/a' },
      record: { wellName: 'Python', ndicWellName: 'PYTHON 1', disposal: 'SWD', hauledTo: 'SWD', totalBBL: 88, notes: 'edit', operator: 'Kraken', invoiceNumber: 'INV-1' },
      ...lg,
    }).ok).toBe(true);
    expect(DISPATCH_UPDATE_ALLOWLIST).toEqual(expect.arrayContaining([
      'totalBBL', 'invoiceNumber', 'hauledTo', 'operator',
    ]));
  });

  it('rejects unknown business fields instead of dropping them', () => {
    expect(materializeStaffCreate({
      wellName: 'Python', status: 'pending', driverHash: 'h', driverName: 'g',
      notARealField: true,
    }, caller)).toMatchObject({ ok: false, reason: 'unexpected_field' });
  });
});

describe('company containment', () => {
  const job = { id: 'j1', status: 'pending', companyId: 'liquid-gold', wellName: 'Gab 1' };

  it('creates for company staff stamped to their company', () => {
    expect(evaluateStaffWriteDispatch({
      op: 'create', job: null, record: { wellName: 'Gab 1', driverHash: 'abc' }, ...lg,
    })).toMatchObject({ ok: true, op: 'create', companyId: 'liquid-gold' });
  });

  it('rejects cross-company create and cancel', () => {
    expect(evaluateStaffWriteDispatch({
      op: 'create', job: null, record: { wellName: 'Gab 1', companyId: 'acme-hauling' }, ...lg,
    })).toEqual({ ok: false, reason: 'cross_company' });
    expect(evaluateStaffWriteDispatch({
      op: 'cancel', job, callerCompanyId: 'acme-hauling', isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'cross_company' });
  });

  it('platform admin may cancel another company job', () => {
    expect(evaluateStaffWriteDispatch({
      op: 'cancel', job: { ...job, companyId: 'acme-hauling' }, isPlatformAdmin: true,
    }).ok).toBe(true);
  });
});

describe('staffWriteDispatch callable transactions', () => {
  const callable = readFileSync(join(__dirname, '../../staffWriteDispatchCallable.ts'), 'utf8');
  it('status-changing update/cancel re-read inside a transaction', () => {
    expect(callable).toMatch(/runTransaction/);
    expect(callable).toMatch(/tx\.get\(ref\)/);
    expect(callable).toMatch(/evaluateStaffWriteDispatch/);
  });
});
