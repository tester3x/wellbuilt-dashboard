import {
  bindGrantToObject,
  decideBoundPhotoRead,
  findBoundInvoicePhoto,
  runIssueStorageReadUrl,
} from '../storageReadBinding';

const live = 'wellbuilt-sync.firebasestorage.app';
const boundPath = 'photos/liquid-gold/drv-a/inv-1/p.jpg';
const invoice = {
  companyId: 'liquid-gold',
  driverId: 'drv-a',
  photos: [{ photoId: 'ph_1', bucket: live, path: boundPath, generation: '7' }],
};

describe('server-owned storage read binding', () => {
  it('rejects a foreign path on an owned invoice', async () => {
    const r = await runIssueStorageReadUrl(
      { invoiceId: 'inv-1', photoId: 'ph_1', path: 'photos/liquid-gold/drv-a/other/x.jpg' },
      { class: 'driver', driverId: 'drv-a', companyId: 'liquid-gold' },
      {
        liveBucket: () => live,
        getInvoice: async () => invoice,
        getGrant: async () => null,
        signRead: async () => 'https://signed.example/x?X-Goog-Signature=abc',
      },
    );
    expect(r).toMatchObject({ ok: false, reason: 'path_not_bound' });
  });

  it('rejects an unrelated same-company path not bound to the invoice', async () => {
    const found = findBoundInvoicePhoto({
      invoice,
      invoiceId: 'inv-1',
      liveBucket: live,
      claimedPath: 'photos/liquid-gold/drv-a/other-inv/y.jpg',
    });
    expect(found).toMatchObject({ ok: false, reason: 'photo_not_bound_to_invoice' });
  });

  it('does not trust forged path company/driver segments', () => {
    const grant = bindGrantToObject({
      grant: { path: 'secrets/other.jpg', companyId: 'liquid-gold', driverId: 'drv-a', kind: 'ticket_photo' },
      grantId: 'g1',
      liveBucket: live,
    });
    expect(grant).toMatchObject({ ok: false, reason: 'non_photo_prefix' });
  });

  it('issues a signed URL only for the bound object', async () => {
    const r = await runIssueStorageReadUrl(
      { invoiceId: 'inv-1', photoId: 'ph_1' },
      { class: 'driver', driverId: 'drv-a', companyId: 'liquid-gold' },
      {
        liveBucket: () => live,
        getInvoice: async () => invoice,
        getGrant: async () => null,
        signRead: async (path) => {
          expect(path).toBe(boundPath);
          return `https://storage.googleapis.com/${live}/${path}?X-Goog-Signature=tok&X-Goog-Expires=1`;
        },
      },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toBe(boundPath);
      expect(r.bucket).toBe(live);
      expect(r.readUrl).toContain('X-Goog-Signature');
    }
  });

  it('staff needs viewTickets and matching company', () => {
    const bound = {
      bucket: live,
      path: boundPath,
      companyId: 'liquid-gold',
      driverId: 'drv-a',
      invoiceId: 'inv-1',
      photoId: 'ph_1',
      grantId: null,
      kind: 'ticket_photo',
    };
    expect(decideBoundPhotoRead({
      bound,
      liveBucket: live,
      callerClass: 'staff',
      callerCompanyId: 'liquid-gold',
      staffHasViewTickets: false,
    }).ok).toBe(false);
    expect(decideBoundPhotoRead({
      bound,
      liveBucket: live,
      callerClass: 'staff',
      callerCompanyId: 'liquid-gold',
      staffHasViewTickets: true,
    }).ok).toBe(true);
    expect(decideBoundPhotoRead({
      bound,
      liveBucket: live,
      callerClass: 'platform',
      platformDualGated: false,
    })).toMatchObject({ ok: false, reason: 'platform_dual_gate' });
    expect(decideBoundPhotoRead({
      bound,
      liveBucket: live,
      callerClass: 'platform',
      platformDualGated: true,
    }).ok).toBe(true);
    expect(decideBoundPhotoRead({
      bound,
      liveBucket: live,
      callerClass: 'driver',
      callerDriverId: 'drv-b',
      callerCompanyId: 'liquid-gold',
    })).toMatchObject({ ok: false, reason: 'not_owner' });
  });
});
