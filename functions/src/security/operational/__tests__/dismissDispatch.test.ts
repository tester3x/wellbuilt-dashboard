import { evaluateDismissDispatch } from '../dismissDispatch';
import {
  decideTrustedCompanyCapability,
  TRUSTED_CAPABILITY_MANAGE_DRIVERS,
  TRUSTED_CAPABILITY_MANAGE_ROLES,
  TRUSTED_STAFF_AUTHORITY_SCHEMA_VERSION,
} from '../../trustedStaffAuthority';
import { staffWriteDispatchAccessFromTrusted } from '../staffWriteDispatch';
import { parseDispatchId } from '../dispatchPacketPin';

describe('evaluateDismissDispatch', () => {
  const job = {
    id: 'bwr0XquQqxnnVsYYv94n',
    status: 'cancelled',
    companyId: 'liquid-gold',
  };

  it('dismisses declined and cancelled, blocks started, is idempotent', () => {
    expect(evaluateDismissDispatch({
      job: { ...job, status: 'declined' },
      siblings: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    }).ok).toBe(true);
    expect(evaluateDismissDispatch({
      job,
      siblings: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    }).ok).toBe(true);
    expect(evaluateDismissDispatch({
      job: { ...job, status: 'accepted' },
      siblings: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'job_in_progress' });
    expect(evaluateDismissDispatch({
      job: { ...job, status: 'dismissed' },
      siblings: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toMatchObject({ ok: true, idempotent: true });
  });

  it('blocks a split family with an in-progress sibling', () => {
    expect(evaluateDismissDispatch({
      job: { ...job, id: 'A', status: 'declined', splitGroupId: 's1' },
      siblings: [{ id: 'B', status: 'in_progress', companyId: 'liquid-gold', splitGroupId: 's1' }],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'family_in_progress' });
  });

  it('blocks accepted, in_progress, and paused family members', () => {
    for (const status of ['accepted', 'in_progress', 'paused'] as const) {
      expect(evaluateDismissDispatch({
        job: { ...job, id: 'A', status: 'declined', splitGroupId: 's1' },
        siblings: [{ id: 'B', status, companyId: 'liquid-gold', splitGroupId: 's1' }],
        callerCompanyId: 'liquid-gold',
        isPlatformAdmin: false,
      })).toEqual({ ok: false, reason: 'family_in_progress' });
    }
  });

  it('rejects a different-company sibling even for a platform administrator', () => {
    const decided = evaluateDismissDispatch({
      job: { ...job, id: 'A', status: 'declined', splitGroupId: 's1' },
      siblings: [{ id: 'B', status: 'pending', companyId: 'acme-hauling', splitGroupId: 's1' }],
      callerCompanyId: undefined,
      isPlatformAdmin: true,
    });
    expect(decided).toEqual({ ok: false, reason: 'sibling_cross_company' });
  });

  it('rejects a sibling with a missing companyId', () => {
    expect(evaluateDismissDispatch({
      job: { ...job, id: 'A', status: 'cancelled', splitGroupId: 's1' },
      siblings: [{ id: 'B', status: 'pending', splitGroupId: 's1' }],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'sibling_unscoped' });
  });

  it('rejects a selected job that became accepted/in_progress/paused after the preliminary read', () => {
    for (const status of ['accepted', 'in_progress', 'paused'] as const) {
      expect(evaluateDismissDispatch({
        job: { ...job, status },
        siblings: [],
        callerCompanyId: 'liquid-gold',
        isPlatformAdmin: false,
      })).toEqual({ ok: false, reason: 'job_in_progress' });
    }
  });

  it('rejects a split family whose sibling became in_progress after the preliminary read', () => {
    expect(evaluateDismissDispatch({
      job: { ...job, id: 'A', status: 'declined', splitGroupId: 's1' },
      siblings: [{ id: 'B', status: 'accepted', companyId: 'liquid-gold', splitGroupId: 's1' }],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'family_in_progress' });
  });

  it('does not dismiss completed or declined-field-wiping terminal states as dismissable except declined/cancelled', () => {
    expect(evaluateDismissDispatch({
      job: { ...job, status: 'completed' },
      siblings: [],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    })).toEqual({ ok: false, reason: 'not_dismissable' });
  });

  it('dismisses same-company pending siblings and preserves decline fields', () => {
    const decided = evaluateDismissDispatch({
      job: { ...job, id: 'A', status: 'declined', splitGroupId: 's1' },
      siblings: [{ id: 'B', status: 'pending', companyId: 'liquid-gold', splitGroupId: 's1' }],
      callerCompanyId: 'liquid-gold',
      isPlatformAdmin: false,
    });
    expect(decided).toEqual({
      ok: true,
      idempotent: false,
      dispatchIds: ['A', 'B'],
      preserveDecline: true,
    });
  });

  describe('Phase 2 regression: pending dispatch removal (Dashboard and driver-created)', () => {
    it('allows same-company dispatcher to remove a Dashboard-created pending dispatch', () => {
      const dashboardPending = {
        id: 'W0Om3TsAHAJ4bu8d8K49',
        status: 'pending',
        companyId: 'liquid-gold',
        assignedBy: 'testerxxx@comcast.net',
        source: undefined,
      };
      const result = evaluateDismissDispatch({
        job: dashboardPending,
        siblings: [],
        callerCompanyId: 'liquid-gold',
        isPlatformAdmin: false,
      });
      expect(result).toEqual({
        ok: true,
        idempotent: false,
        dispatchIds: ['W0Om3TsAHAJ4bu8d8K49'],
        preserveDecline: true,
      });
    });

    it('allows same-company dispatcher to remove a driver-created pending dispatch (provenance is not ownership)', () => {
      const driverPending = {
        id: 'dplan_mu360zoo2paignsw_01',
        status: 'pending',
        companyId: 'liquid-gold',
        assignedBy: 'driver',
        source: 'driver',
      };
      const result = evaluateDismissDispatch({
        job: driverPending,
        siblings: [],
        callerCompanyId: 'liquid-gold',
        isPlatformAdmin: false,
      });
      expect(result).toEqual({
        ok: true,
        idempotent: false,
        dispatchIds: ['dplan_mu360zoo2paignsw_01'],
        preserveDecline: true,
      });
    });

    it('denies cross-company removal of a pending dispatch', () => {
      const pendingJob = {
        id: 'dplan_mu360zoo2paignsw_01',
        status: 'pending',
        companyId: 'liquid-gold',
        source: 'driver',
      };
      const result = evaluateDismissDispatch({
        job: pendingJob,
        siblings: [],
        callerCompanyId: 'other-company',
        isPlatformAdmin: false,
      });
      expect(result).toEqual({
        ok: false,
        reason: 'cross_company',
      });
    });

    it('denies removal if caller has no companyId and is not platform admin', () => {
      const pendingJob = {
        id: 'dplan_mu360zoo2paignsw_01',
        status: 'pending',
        companyId: 'liquid-gold',
      };
      const result = evaluateDismissDispatch({
        job: pendingJob,
        siblings: [],
        callerCompanyId: '',
        isPlatformAdmin: false,
      });
      expect(result).toEqual({
        ok: false,
        reason: 'cross_company',
      });
    });

    it('is idempotent on repeated removal requests for an already-dismissed job', () => {
      const dismissedJob = {
        id: 'W0Om3TsAHAJ4bu8d8K49',
        status: 'dismissed',
        companyId: 'liquid-gold',
      };
      const result = evaluateDismissDispatch({
        job: dismissedJob,
        siblings: [],
        callerCompanyId: 'liquid-gold',
        isPlatformAdmin: false,
      });
      expect(result).toEqual({
        ok: true,
        idempotent: true,
        dispatchIds: ['W0Om3TsAHAJ4bu8d8K49'],
        preserveDecline: true,
      });
    });
  });
});

describe('dismissDispatch callable source', () => {
  const { readFileSync } = require('fs') as typeof import('fs');
  const { join } = require('path') as typeof import('path');
  const callable = readFileSync(join(__dirname, '../../dismissDispatchCallable.ts'), 'utf8');

  it('does not wipe decline fields on dismiss', () => {
    expect(callable).toMatch(/status:\s*'dismissed'/);
    expect(callable).toMatch(/dismissedAt:\s*FieldValue\.serverTimestamp\(\)/);
    expect(callable).not.toMatch(/declineReason:\s*(FieldValue\.delete|null|''|"")/);
    expect(callable).not.toMatch(/declinedAt:\s*(FieldValue\.delete|null)/);
    expect(callable).not.toMatch(/declinedBy:\s*(FieldValue\.delete|null|''|"")/);
  });

  it('re-reads the selected job and split family inside a transaction before writing', () => {
    expect(callable).toMatch(/runTransaction/);
    expect(callable).toMatch(/tx\.get\(jobRef\)/);
    expect(callable).toMatch(/where\('splitGroupId'/);
    expect(callable).toMatch(/tx\.get\(/);
  });

  it('authorizes through trusted manageDrivers, never requireManageDrivers', () => {
    expect(callable).toMatch(/requireTrustedCompanyCapability/);
    expect(callable).toMatch(/TRUSTED_CAPABILITY_MANAGE_DRIVERS/);
    expect(callable).toMatch(/staffWriteDispatchAccessFromTrusted/);
    expect(callable).toMatch(/parseDispatchId/);
    expect(callable).not.toMatch(/requireManageDrivers/);
    expect(callable).not.toMatch(/adminAuth/);
    expect(callable).toMatch(/isPlatformAdmin: access\.isPlatformAdmin/);
    expect(callable).toMatch(/callerCompanyId: access\.companyId/);
    expect(callable).toMatch(/dismissedBy: access\.uid/);
  });
});

describe('dismissDispatch trusted authority gate', () => {
  const UID = 'uid-staff-1';
  const COMPANY = 'liquid-gold';
  const OTHER = 'other-hauler';
  const JOB = 'W0Om3TsAHAJ4bu8d8K49';

  function rec(over: Record<string, unknown> = {}) {
    return {
      schemaVersion: TRUSTED_STAFF_AUTHORITY_SCHEMA_VERSION,
      uid: UID,
      companyId: COMPANY,
      active: true,
      capabilities: [TRUSTED_CAPABILITY_MANAGE_DRIVERS],
      ...over,
    };
  }

  function decide(authUid: string | undefined, record: unknown, jobCompany = COMPANY) {
    const trusted = decideTrustedCompanyCapability(authUid, record, TRUSTED_CAPABILITY_MANAGE_DRIVERS);
    if (!trusted.ok) return trusted;
    const access = staffWriteDispatchAccessFromTrusted(trusted);
    if (!access.ok) return access;
    const id = parseDispatchId(JOB);
    if (!id.ok) return id;
    return evaluateDismissDispatch({
      job: { id: JOB, status: 'declined', companyId: jobCompany },
      siblings: [],
      callerCompanyId: access.companyId,
      isPlatformAdmin: access.isPlatformAdmin,
    });
  }

  it('trusted manageDrivers can dismiss a same-company declined job', () => {
    const r = decide(UID, rec());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.idempotent).toBe(false);
  });

  it('missing/inactive/mismatched/malformed trusted records fail before evaluate', () => {
    expect(decide(UID, null)).toMatchObject({ ok: false, reason: 'no_trusted_authority_record' });
    expect(decide(UID, rec({ active: false }))).toMatchObject({ ok: false, reason: 'trusted_authority_inactive' });
    expect(decide(UID, rec({ uid: 'other-uid' }))).toMatchObject({ ok: false, reason: 'trusted_authority_uid_mismatch' });
    expect(decide(UID, rec({ extra: true })).ok).toBe(false);
  });

  it('manageRoles without manageDrivers cannot dismiss', () => {
    expect(decide(UID, rec({ capabilities: [TRUSTED_CAPABILITY_MANAGE_ROLES] })))
      .toMatchObject({ ok: false, reason: 'missing_required_capability' });
  });

  it('cross-company dispatch fails closed with isPlatformAdmin hard-false', () => {
    const r = decide(UID, rec(), OTHER);
    expect(r).toMatchObject({ ok: false, reason: 'cross_company' });
    const access = staffWriteDispatchAccessFromTrusted({ uid: UID, companyId: COMPANY });
    expect(access.ok && access.isPlatformAdmin).toBe(false);
  });
});
