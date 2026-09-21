import { readFileSync } from 'fs';
import { join } from 'path';
import {
  evaluateStaffIngestPull,
  parseStaffIngestPull,
} from '../staffIngestDashboardPull';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');

describe('staffIngestDashboardPull', () => {
  it('rejects authority fields and unknown wells', () => {
    expect(parseStaffIngestPull({
      wellName: 'Python',
      tankLevelFeet: 1,
      bblsTaken: 140,
      dateTimeUTC: '2026-09-21T00:00:00.000Z',
      companyId: 'liquid-gold',
    })).toMatchObject({ ok: false, reason: 'caller_authority_field' });
    const parsed = parseStaffIngestPull({
      wellName: 'Python',
      tankLevelFeet: 1,
      bblsTaken: 140,
      dateTimeUTC: '2026-09-21T00:00:00.000Z',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(evaluateStaffIngestPull({
      request: parsed,
      catalog: { Python: { ndicName: 'PYTHON 1' } },
      actingCompanyId: 'liquid-gold',
    }).ok).toBe(true);
    expect(evaluateStaffIngestPull({
      request: parsed,
      catalog: { Other: { ndicName: 'OTHER 1' } },
      actingCompanyId: 'liquid-gold',
    })).toMatchObject({ ok: false, reason: 'well_unauthorized' });
  });

  it('callable is trusted manageDrivers and AddPullModal no longer client-writes incoming', () => {
    const callable = readFileSync(join(ROOT, 'functions', 'src', 'security', 'staffIngestDashboardPullCallable.ts'), 'utf8');
    expect(callable).toMatch(/TRUSTED_CAPABILITY_MANAGE_DRIVERS/);
    expect(callable).toMatch(/packets\/incoming\//);
    expect(callable).toMatch(/duplicate: true/);
    const modal = readFileSync(join(ROOT, 'src', 'components', 'AddPullModal.tsx'), 'utf8');
    expect(modal).toMatch(/staffIngestDashboardPull/);
    expect(modal).not.toMatch(/packets\/incoming/);
  });
});
