import {
  evaluateAssignmentMigration,
  sanitizeMigrationReport,
} from '../assignmentMigration';

const MIKE_Z = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
const MIKE_S = '99ff4b35-51ab-4d45-8d54-18b3b8515c9b';
const HASH_Z = 'b'.repeat(64);
const HASH_S = 'c'.repeat(64);

describe('evaluateAssignmentMigration', () => {
  const approved = [
    {
      id: HASH_Z,
      displayName: 'Mikezfold',
      companyId: 'liquid-gold',
      active: true,
      assignedRoutes: ['Gabriels', 'Watford'],
    },
    {
      id: HASH_S,
      displayName: 'MikeS24',
      companyId: 'liquid-gold',
      active: true,
      assignedRoutes: ['Gabriels'],
    },
  ];
  const profiles = [
    {
      id: MIKE_Z,
      displayName: 'Mikezfold',
      companyId: 'liquid-gold',
      active: true,
    },
    {
      id: MIKE_S,
      displayName: 'MikeS24',
      companyId: 'liquid-gold',
      active: true,
    },
  ];

  it('is deterministic and idempotent for unique active matches', () => {
    const a = evaluateAssignmentMigration({
      requestedNames: ['Mikezfold', 'MikeS24'],
      approved,
      profiles,
    });
    const b = evaluateAssignmentMigration({
      requestedNames: ['Mikezfold', 'MikeS24'],
      approved,
      profiles,
    });
    expect(a).toEqual(b);
    expect(a.wouldWriteCount).toBe(2);
    expect(a.refusedCount).toBe(0);
    expect(a.results[0].ok && a.results[0].driverId).toBe(MIKE_Z);
    expect(a.results[1].ok && a.results[1].driverId).toBe(MIKE_S);
    const already = evaluateAssignmentMigration({
      requestedNames: ['Mikezfold'],
      approved,
      profiles: [
        {
          ...profiles[0],
          assignedRoutes: ['Gabriels', 'Watford'],
        },
      ],
    });
    expect(already.results[0].ok && already.results[0].status).toBe('already_applied');
    expect(already.wouldWriteCount).toBe(0);
    expect(already.alreadyAppliedCount).toBe(1);
  });

  it('refuses duplicate canonical mappings', () => {
    const r = evaluateAssignmentMigration({
      requestedNames: ['Mikezfold'],
      approved,
      profiles: [profiles[0], { ...profiles[0], id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }],
    });
    expect(r.results[0]).toMatchObject({ ok: false, reason: 'canonical_duplicate' });
  });

  it('refuses company mismatch', () => {
    const r = evaluateAssignmentMigration({
      requestedNames: ['Mikezfold'],
      approved,
      profiles: [{ ...profiles[0], companyId: 'acme-eog-test' }],
    });
    expect(r.results[0]).toMatchObject({ ok: false, reason: 'company_mismatch' });
  });

  it('sanitized report never contains a 64-hex legacy key', () => {
    const r = evaluateAssignmentMigration({
      requestedNames: ['Mikezfold', 'MikeS24'],
      approved,
      profiles,
    });
    expect(() => sanitizeMigrationReport(r)).not.toThrow();
    expect(JSON.stringify(r)).not.toMatch(/[a-f0-9]{64}/i);
  });
});
