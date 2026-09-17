import { readFileSync } from 'fs';
import { join } from 'path';

const backfill = readFileSync(
  join(__dirname, '../../../tools/backfillPublicCompanies.mjs'),
  'utf8',
);

describe('backfillPublicCompanies is emulator-only', () => {
  test('refuses to run without FIRESTORE_EMULATOR_HOST', () => {
    expect(backfill).toContain('FIRESTORE_EMULATOR_HOST');
    expect(backfill).toContain('Production is forbidden');
    expect(backfill).toContain('process.exit(2)');
  });

  test('rejects --production / --live flags', () => {
    expect(backfill).toContain('--production');
    expect(backfill).toContain('--live');
  });

  test('writes with merge:false to public_companies', () => {
    expect(backfill).toContain(".collection('public_companies')");
    expect(backfill).toContain('merge: false');
  });

  test('is not exported as a Cloud Function', () => {
    const indexSrc = readFileSync(join(__dirname, '../../index.ts'), 'utf8');
    expect(indexSrc).not.toContain('backfillPublicCompanies');
  });
});
