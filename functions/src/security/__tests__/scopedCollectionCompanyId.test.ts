/**
 * Newly scoped collections must carry canonical companyId.
 * Evidence is fixtures + source writers — no production inspection.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { decidePhotoRequirementDoc, planLegacyPhotoRequirementMigration } from '../photoRequirementWrite';

describe('scoped collection companyId inventory', () => {
  it('photo_requirements writer stamps companyId', () => {
    const decided = decidePhotoRequirementDoc({
      customerId: 'opslug',
      companyId: 'liquid-gold',
      enabled: true,
      version: 1,
      requirements: [],
    });
    expect(decided.ok && decided.doc.companyId).toBe('liquid-gold');
  });

  it('legacy photo_requirements without companyId are flagged for migration', () => {
    expect(planLegacyPhotoRequirementMigration({ customerId: 'opslug' }).needsCompanyId).toBe(true);
  });

  it('canonical_jobs / chat / route parent writers require companyId in source', () => {
    const upsert = readFileSync(
      join(__dirname, '..', '..', 'canonical-jobs', 'upsertCanonicalJob.ts'),
      'utf8',
    );
    expect(upsert).toMatch(/companyId/);
    const invoiceOps = readFileSync(
      join(__dirname, '..', 'operational', 'invoiceOps.ts'),
      'utf8',
    );
    expect(invoiceOps).toMatch(/companyId/);
    const rules = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'firestore.rules'),
      'utf8',
    );
    expect(rules).toMatch(/match \/canonical_jobs/);
    expect(rules).toMatch(/match \/photo_requirements/);
    expect(rules).toMatch(/staffSameCompany\(resource\.data\)/);
  });
});
