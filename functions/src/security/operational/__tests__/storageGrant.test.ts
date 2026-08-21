import {
  canonicalObjectReadUrl,
  decideConsumeGrant,
  decidePhotoReadAccess,
  decideSignedReadReuse,
  decideUploadGrant,
} from '../storageTokens';

describe('scoped upload grants', () => {
  it('requires invoice ownership and refuses overwrite', () => {
    expect(
      decideUploadGrant({
        kind: 'ticket_photo',
        driverId: 'drv-a',
        companyId: 'liquid-gold',
        invoiceCompanyId: 'liquid-gold',
        invoiceDriverId: 'drv-a',
        contentType: 'image/jpeg',
        byteSize: 1000,
      }).ok,
    ).toBe(true);
    expect(
      decideUploadGrant({
        kind: 'ticket_photo',
        driverId: 'drv-a',
        companyId: 'liquid-gold',
        invoiceCompanyId: 'acme',
        invoiceDriverId: 'drv-a',
        contentType: 'image/jpeg',
        byteSize: 1000,
      }).ok,
    ).toBe(false);
    expect(
      decideUploadGrant({
        kind: 'ticket_photo',
        driverId: 'drv-a',
        companyId: 'liquid-gold',
        invoiceCompanyId: 'liquid-gold',
        invoiceDriverId: 'drv-a',
        contentType: 'image/jpeg',
        byteSize: 1000,
        objectExists: true,
      }),
    ).toMatchObject({ ok: false, reason: 'overwrite_refused' });
  });

  it('refuses replay and expired grants', () => {
    expect(decideConsumeGrant({ used: true, expiresAt: Date.now() + 1000, nowMs: Date.now(), pathMatches: true })).toMatchObject({
      ok: false,
      reason: 'replay',
    });
    expect(decideConsumeGrant({ used: false, expiresAt: 1, nowMs: 100, pathMatches: true })).toMatchObject({
      ok: false,
      reason: 'expired',
    });
    expect(decideConsumeGrant({
      used: false,
      expiresAt: Date.now() + 1000,
      nowMs: Date.now(),
      pathMatches: true,
      objectExists: true,
      storedBytes: 1000,
      declaredBytes: 1000,
      storedContentType: 'image/jpeg',
      declaredContentType: 'image/jpeg',
    }).ok).toBe(true);
    expect(decideConsumeGrant({
      used: false,
      expiresAt: Date.now() + 1000,
      nowMs: Date.now(),
      pathMatches: true,
      objectExists: false,
    })).toMatchObject({ ok: false, reason: 'object_missing' });
  });

  it('builds a canonical read URL for the actual bucket and path', () => {
    const url = canonicalObjectReadUrl('wellbuilt-sync.firebasestorage.app', 'photos/a/b/c.jpg');
    expect(url).toContain('wellbuilt-sync.firebasestorage.app');
    expect(url).toContain('photos/a/b/c.jpg');
    expect(url).not.toContain('appspot.com');
    expect(url).not.toMatch(/firebasestorage\.googleapis\.com.*alt=media$/);
  });

  it('authorizes owner driver and same-company staff; denies others', () => {
    expect(decidePhotoReadAccess({
      callerClass: 'driver',
      callerDriverId: 'drv-a',
      callerCompanyId: 'liquid-gold',
      photoDriverId: 'drv-a',
      photoCompanyId: 'liquid-gold',
    }).ok).toBe(true);
    expect(decidePhotoReadAccess({
      callerClass: 'staff',
      callerCompanyId: 'liquid-gold',
      photoCompanyId: 'liquid-gold',
      staffAuthorized: true,
    }).ok).toBe(true);
    expect(decidePhotoReadAccess({
      callerClass: 'driver',
      callerDriverId: 'drv-b',
      callerCompanyId: 'liquid-gold',
      photoDriverId: 'drv-a',
      photoCompanyId: 'liquid-gold',
    })).toMatchObject({ ok: false, reason: 'not_owner' });
    expect(decidePhotoReadAccess({
      callerClass: 'staff',
      callerCompanyId: 'acme',
      photoCompanyId: 'liquid-gold',
      staffAuthorized: true,
    })).toMatchObject({ ok: false, reason: 'cross_company' });
  });

  it('refuses reuse of an expired signed read URL', () => {
    expect(decideSignedReadReuse({ expiresAt: 100, nowMs: 101 })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(decideSignedReadReuse({ expiresAt: 200, nowMs: 100 }).ok).toBe(true);
  });
});
