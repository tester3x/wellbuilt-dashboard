import { decidePhotoRequirementDoc, decidePhotoRequirementWrite, planLegacyPhotoRequirementMigration } from '../photoRequirementWrite';

describe('photo_requirements companyId schema', () => {
  it('stamps canonical companyId on every write', () => {
    expect(decidePhotoRequirementDoc({
      customerId: 'liquidgold',
      companyId: '',
      enabled: true,
      version: 1,
      requirements: [],
    })).toMatchObject({ ok: false, reason: 'companyId_required' });
    expect(decidePhotoRequirementDoc({
      customerId: 'liquidgold',
      companyId: 'liquid-gold',
      enabled: true,
      version: 2,
      requirements: [{ id: 'hose' }],
    })).toMatchObject({
      ok: true,
      doc: { customerId: 'liquidgold', companyId: 'liquid-gold', version: 2 },
    });
  });

  it('plans migration for legacy customerId-only documents', () => {
    expect(planLegacyPhotoRequirementMigration({ customerId: 'acme' })).toEqual({
      needsCompanyId: true,
      customerId: 'acme',
      existingCompanyId: null,
    });
    expect(planLegacyPhotoRequirementMigration({
      customerId: 'acme',
      companyId: 'acme-co',
    }).needsCompanyId).toBe(false);
  });

  it('company staff cannot overwrite a foreign existing document', () => {
    expect(decidePhotoRequirementWrite({
      existing: { companyId: 'acme', version: 3 },
      callerClass: 'company_staff',
      callerCompanyId: 'liquid-gold',
      stampCompanyId: 'liquid-gold',
      requirementsProvided: true,
    })).toMatchObject({ ok: false, reason: 'foreign_photo_requirement' });
  });

  it('legacy unscoped documents require platform migration', () => {
    expect(decidePhotoRequirementWrite({
      existing: { customerId: 'op', version: 1 },
      callerClass: 'company_staff',
      callerCompanyId: 'liquid-gold',
      stampCompanyId: 'liquid-gold',
      requirementsProvided: true,
    })).toMatchObject({ ok: false, reason: 'legacy_unscoped_requires_platform_migration' });
  });

  it('omitted requirements are invalid', () => {
    expect(decidePhotoRequirementWrite({
      existing: null,
      callerClass: 'company_staff',
      callerCompanyId: 'liquid-gold',
      stampCompanyId: 'liquid-gold',
      requirementsProvided: false,
    })).toMatchObject({ ok: false, reason: 'requirements_required' });
  });

  it('wrong-type requirements are invalid-argument material', () => {
    expect(decidePhotoRequirementDoc({
      customerId: 'op',
      companyId: 'liquid-gold',
      enabled: true,
      version: 1,
      requirements: 'nope' as unknown as unknown[],
    })).toMatchObject({ ok: false, reason: 'requirements_required' });
  });

  it('concurrent version mismatch is a conflict', () => {
    expect(decidePhotoRequirementWrite({
      existing: { companyId: 'liquid-gold', version: 4 },
      callerClass: 'company_staff',
      callerCompanyId: 'liquid-gold',
      stampCompanyId: 'liquid-gold',
      requirementsProvided: true,
      expectedVersion: 3,
    })).toMatchObject({ ok: false, reason: 'version_conflict' });
  });
});
