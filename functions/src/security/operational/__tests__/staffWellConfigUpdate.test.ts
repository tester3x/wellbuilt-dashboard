/**
 * Unit contract for governed well-config UPDATE (Save Changes) — the op:'update'
 * path that already exists in this source lineage (deployed binary lags it).
 * Proves: cross-company/unauthorized rejected, valid update returns a restricted
 * patch, missing well not-found, rename/NDIC/extra fields rejected, idempotent.
 */
import { evaluateStaffWriteWellConfig, WELL_CONFIG_UPDATE_ALLOWLIST } from '../staffWriteWellConfig';

const validCfg = () => ({
  route: 'Gabriels', bottomLevel: 3, tanks: 2, numTanks: 2, pullBbls: 140,
  tankCapacity: 400, tankHeight: 11, bblPerFoot: 20, allowedBottom: 3, h2sStatus: 'none',
});
const base = (over: Record<string, unknown> = {}) => ({
  op: 'update' as const,
  wellName: 'Gabriel 3',
  config: validCfg(),
  existingByName: { ...validCfg(), pullBbls: 100 }, // differs → real update
  existingNameKey: 'Gabriel 3',
  duplicateApiWell: null,
  callerCompanyId: undefined as string | undefined,
  isPlatformAdmin: true,
  ...over,
});

describe('staff well-config update authorization + contract', () => {
  it('rejects a cross-company (non-global-pool) caller', () => {
    const d = evaluateStaffWriteWellConfig(base({ isPlatformAdmin: false, callerCompanyId: 'some-other-co' }));
    expect(d).toMatchObject({ ok: false, reason: 'pool_forbidden' });
  });

  it('allows a platform admin to update an existing well (restricted patch)', () => {
    const d = evaluateStaffWriteWellConfig(base());
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.action).toBe('update');
      if (d.action === 'update') {
        // only allowlisted fields in the patch — never a rename or NDIC/AFR field
        for (const k of Object.keys(d.patch)) {
          expect(WELL_CONFIG_UPDATE_ALLOWLIST as readonly string[]).toContain(k);
        }
        expect('wellName' in d.patch).toBe(false);
        expect('ndicApiNo' in d.patch).toBe(false);
      }
    }
  });

  it('fails not_found when the well does not exist', () => {
    const d = evaluateStaffWriteWellConfig(base({ existingByName: null, existingNameKey: null }));
    expect(d).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('rejects rename / NDIC / any non-allowlisted field (no rename via update)', () => {
    const withName = evaluateStaffWriteWellConfig(base({ config: { ...validCfg(), wellName: 'Renamed Well' } }));
    expect(withName).toMatchObject({ ok: false, reason: 'unexpected_field' });
    const withNdic = evaluateStaffWriteWellConfig(base({ config: { ...validCfg(), ndicApiNo: '33-053-00000-00-00' } }));
    expect(withNdic).toMatchObject({ ok: false, reason: 'unexpected_field' });
  });

  it('is idempotent when the patch matches the existing config', () => {
    const d = evaluateStaffWriteWellConfig(base({ existingByName: { ...validCfg() } }));
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.action).toBe('already_exact');
  });

  it('create path still works (baseline not regressed)', () => {
    const d = evaluateStaffWriteWellConfig({
      op: 'create', wellName: 'New Demo Well',
      config: { ...validCfg(), ndicName: 'NEW WELL', ndicApiNo: '33-053-12345-00-00' },
      existingByName: null, existingNameKey: null, duplicateApiWell: null,
      callerCompanyId: undefined, isPlatformAdmin: true,
    });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.action).toBe('create');
  });
});
