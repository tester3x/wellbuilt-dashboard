import {
  attachPhotoToInvoicePhotos,
  buildCanonicalInvoicePhoto,
  decideInvoicePhotoAllowlist,
  decidePhotoId,
} from '../invoicePhotoAttach';

const photo = buildCanonicalInvoicePhoto({
  photoId: 'ph_abc123xyz',
  bucket: 'wellbuilt-sync.firebasestorage.app',
  path: 'photos/liquid-gold/drv-a/inv-1/ph_abc123xyz.jpg',
  generation: '9',
  companyId: 'liquid-gold',
  driverId: 'drv-a',
  invoiceId: 'inv-1',
});

describe('invoice photo attach', () => {
  it('validates or mints photoId', () => {
    expect(decidePhotoId('ph_abc123xyz')).toEqual({ ok: true, photoId: 'ph_abc123xyz', minted: false });
    expect(decidePhotoId('../etc')).toMatchObject({ ok: false });
    expect(decidePhotoId(null).ok).toBe(true);
    expect(decidePhotoId(null)).toMatchObject({ minted: true });
  });

  it('idempotent finalize does not duplicate', () => {
    const once = attachPhotoToInvoicePhotos([], photo);
    expect(once.photos).toHaveLength(1);
    const twice = attachPhotoToInvoicePhotos(once.photos, photo);
    expect(twice.duplicate).toBe(true);
    expect(twice.photos).toHaveLength(1);
  });

  it('client invoice photos are not writable', () => {
    expect(decideInvoicePhotoAllowlist({ clientPhotos: [{ path: 'forged' }] })).toMatchObject({
      ok: false,
      reason: 'photos_not_client_writable',
    });
    expect(decideInvoicePhotoAllowlist({})).toEqual({ ok: true });
  });
});
