import {
  decideFirestoreStaffAccess,
  decideOwnerScopedRead,
  decideStorageObjectAccess,
} from '../staffAuthority';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Firestore staff authority', () => {
  it('allows platform admin only with wellbuiltAdmin AND enabled platform_admins/{uid}', () => {
    expect(
      decideFirestoreStaffAccess({ wellbuiltAdmin: true, platformAdminEnabled: true }),
    ).toEqual({ ok: true, via: 'platform_admin' });
    expect(
      decideFirestoreStaffAccess({ wellbuiltAdmin: true, platformAdminEnabled: false }),
    ).toMatchObject({ ok: false, reason: 'platform_admin_revoked' });
  });

  it('allows IT / manager / dispatch / admin staff for their company only', () => {
    for (const role of ['admin', 'it', 'manager', 'dispatch']) {
      expect(
        decideFirestoreStaffAccess({
          staff: { enabled: true, role, companyId: 'liquid-gold' },
          resourceCompanyId: 'liquid-gold',
        }),
      ).toEqual({ ok: true, via: 'company_staff' });
    }
  });

  it('denies disabled staff, wrong company, and ordinary signed-in users', () => {
    expect(
      decideFirestoreStaffAccess({
        staff: { enabled: false, role: 'it', companyId: 'liquid-gold' },
        resourceCompanyId: 'liquid-gold',
      }),
    ).toMatchObject({ ok: false, reason: 'staff_disabled' });
    expect(
      decideFirestoreStaffAccess({
        staff: { enabled: true, role: 'it', companyId: 'liquid-gold' },
        resourceCompanyId: 'acme-eog-test',
      }),
    ).toMatchObject({ ok: false, reason: 'staff_company' });
    expect(
      decideFirestoreStaffAccess({ kind: 'driver', staff: null, resourceCompanyId: 'liquid-gold' }),
    ).toMatchObject({ ok: false, reason: 'staff_disabled' });
  });

  it('does not treat token.role as authority in the rules source', () => {
    const rules = readFileSync(join(__dirname, '../../../../../firestore.rules'), 'utf8');
    expect(rules).not.toMatch(/request\.auth\.token\.role/);
    expect(rules).toMatch(/platform_admins/);
    expect(rules).toMatch(/staff\/\{uid\}/);
    expect(rules).toMatch(/allow create, update, delete: if false/);
  });
});

describe('owner-scoped operational reads', () => {
  it('denies same-company wrong owner, missing company, missing owner', () => {
    expect(
      decideOwnerScopedRead({
        callerDriverId: 'a',
        callerCompanyId: 'liquid-gold',
        resourceDriverId: 'b',
        resourceCompanyId: 'liquid-gold',
      }),
    ).toMatchObject({ ok: false, reason: 'not_owner' });
    expect(
      decideOwnerScopedRead({
        callerDriverId: 'a',
        callerCompanyId: 'liquid-gold',
        resourceDriverId: 'a',
        resourceCompanyId: undefined,
      }),
    ).toMatchObject({ ok: false, reason: 'unscoped' });
    expect(
      decideOwnerScopedRead({
        callerDriverId: 'a',
        callerCompanyId: 'liquid-gold',
        resourceDriverId: undefined,
        resourceCompanyId: 'liquid-gold',
      }),
    ).toMatchObject({ ok: false, reason: 'missing_owner' });
  });
});

describe('storage issued path binding', () => {
  const base = {
    callerDriverId: 'drv-a',
    callerCompanyId: 'liquid-gold',
    pathCompanyId: 'liquid-gold',
    pathDriverId: 'drv-a',
    contentType: 'image/jpeg',
    bytes: 1000,
    maxBytes: 12 * 1024 * 1024,
  };

  it('allows the issuing driver and denies same-company overwrite by another driver', () => {
    expect(decideStorageObjectAccess({ ...base, op: 'write' }).ok).toBe(true);
    expect(
      decideStorageObjectAccess({ ...base, pathDriverId: 'drv-b', op: 'write' }),
    ).toMatchObject({ ok: false, reason: 'not_owner' });
  });

  it('denies cross-company, delete, wrong type, and oversized objects', () => {
    expect(
      decideStorageObjectAccess({ ...base, pathCompanyId: 'acme-eog-test', op: 'write' }),
    ).toMatchObject({ ok: false, reason: 'cross_company' });
    expect(decideStorageObjectAccess({ ...base, op: 'delete' })).toMatchObject({
      ok: false,
      reason: 'delete_denied',
    });
    expect(
      decideStorageObjectAccess({ ...base, contentType: 'application/octet-stream', op: 'write' }),
    ).toMatchObject({ ok: false, reason: 'content_type' });
    expect(
      decideStorageObjectAccess({ ...base, bytes: 20 * 1024 * 1024, op: 'write' }),
    ).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('issued paths contain driverId so rules can bind the claim', () => {
    const src = readFileSync(join(__dirname, '../storageTokens.ts'), 'utf8');
    expect(src).toMatch(/photos\/\$\{companyId\}\/\$\{driver\.driverId\}/);
    expect(src).toMatch(/chat_photos\/\$\{companyId\}\/\$\{driver\.driverId\}/);
    const rules = readFileSync(join(__dirname, '../../../../../storage.rules'), 'utf8');
    expect(rules).toMatch(/photos\/\{cid\}\/\{did\}/);
    expect(rules).toMatch(/driverId\(\) == did/);
  });
});
