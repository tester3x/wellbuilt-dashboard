import {
  callerCanMutatePhotoReview,
  callerCanViewPhotoReview,
  displayUrlForInvoicePhoto,
  effectiveReviewStatus,
  evaluateReviewDispatchPhoto,
  extractInvoicePhotos,
  photoMatchesFilters,
  photoReviewDocId,
  resolvePhotoReviewCompany,
} from '../dispatchPhotoReviewCore';

const COMPANY = 'liquid-gold';
const OTHER = 'acme-eog-test';
const reviewer = {
  uid: 'staff-1',
  roles: ['dispatch'],
  companyId: COMPANY,
  isPlatformAdmin: false,
  email: 'dispatch@example.com',
  displayName: 'Pat Dispatch',
};

describe('dispatchPhotoReviewCore', () => {
  it('company staff can view and mutate; viewer is read-only; driver is denied', () => {
    expect(callerCanViewPhotoReview(reviewer)).toBe(true);
    expect(callerCanMutatePhotoReview(reviewer)).toBe(true);
    expect(callerCanMutatePhotoReview({ ...reviewer, roles: ['viewer'] })).toBe(false);
    expect(callerCanViewPhotoReview({ ...reviewer, roles: ['viewer'] })).toBe(true);
    expect(callerCanViewPhotoReview({ ...reviewer, roles: ['driver'] })).toBe(false);
    expect(callerCanViewPhotoReview({ ...reviewer, roles: ['payroll'] })).toBe(false);
  });

  it('binds listing to the caller company and rejects cross-company', () => {
    expect(resolvePhotoReviewCompany(reviewer, COMPANY)).toEqual({ ok: true, companyId: COMPANY });
    expect(resolvePhotoReviewCompany(reviewer, OTHER)).toEqual({ ok: false, reason: 'wrong_company' });
    expect(resolvePhotoReviewCompany(reviewer, '')).toEqual({ ok: true, companyId: COMPANY });
    expect(resolvePhotoReviewCompany({ ...reviewer, companyId: '', isPlatformAdmin: true }, '')).toEqual({
      ok: false, reason: 'companyId_required',
    });
    expect(resolvePhotoReviewCompany({ ...reviewer, companyId: '', isPlatformAdmin: true }, COMPANY)).toEqual({
      ok: true, companyId: COMPANY,
    });
  });

  it('treats missing sidecar as Unreviewed and does not rewrite invoices', () => {
    expect(effectiveReviewStatus(null)).toBe('unreviewed');
    expect(photoReviewDocId('inv1', 'ph_1')).toBe('inv1_ph_1');
  });

  it('requires a reject reason and never asks for a retake transition', () => {
    const reject = evaluateReviewDispatchPhoto({
      caller: reviewer,
      companyId: COMPANY,
      invoiceId: 'inv1',
      photoId: 'ph_1',
      action: 'reject',
      photoBelongsToCompany: true,
      existing: null,
    });
    expect(reject).toEqual({ ok: false, reason: 'reject_reason_required' });
    const ok = evaluateReviewDispatchPhoto({
      caller: reviewer,
      companyId: COMPANY,
      invoiceId: 'inv1',
      photoId: 'ph_1',
      action: 'reject',
      rejectReason: 'Blurry gauge, coaching required',
      supervisorNote: 'Talk Monday',
      photoBelongsToCompany: true,
      existing: null,
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.nextStatus).toBe('rejected');
    expect(ok.rejectReason).toContain('coaching');
  });

  it('rejected → addressed; addressed cannot approve; foreign photo denied', () => {
    const addressed = evaluateReviewDispatchPhoto({
      caller: reviewer,
      companyId: COMPANY,
      invoiceId: 'inv1',
      photoId: 'ph_1',
      action: 'address',
      addressedNote: 'Driver coached 2026-09-16',
      photoBelongsToCompany: true,
      existing: { companyId: COMPANY, invoiceId: 'inv1', photoId: 'ph_1', status: 'rejected' },
    });
    expect(addressed.ok).toBe(true);
    if (addressed.ok) expect(addressed.nextStatus).toBe('addressed');

    const illegal = evaluateReviewDispatchPhoto({
      caller: reviewer,
      companyId: COMPANY,
      invoiceId: 'inv1',
      photoId: 'ph_1',
      action: 'approve',
      photoBelongsToCompany: true,
      existing: { companyId: COMPANY, invoiceId: 'inv1', photoId: 'ph_1', status: 'addressed' },
    });
    expect(illegal).toEqual({ ok: false, reason: 'illegal_transition' });

    expect(evaluateReviewDispatchPhoto({
      caller: reviewer,
      companyId: COMPANY,
      invoiceId: 'inv1',
      photoId: 'ph_1',
      action: 'approve',
      photoBelongsToCompany: false,
      existing: null,
    })).toEqual({ ok: false, reason: 'photo_not_owned' });
  });

  it('strips signed URLs and rewrites storage URLs the Dispatch way', () => {
    const signed = 'https://storage.googleapis.com/b/photos/c/i/p.jpg?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=abc';
    expect(displayUrlForInvoicePhoto(signed)).toBe('https://storage.googleapis.com/b/photos/c/i/p.jpg');
    expect(displayUrlForInvoicePhoto('gs://wellbuilt-sync.appspot.com/photos/c/i/p.jpg'))
      .toBe('https://storage.googleapis.com/wellbuilt-sync.appspot.com/photos/c/i/p.jpg');
    expect(displayUrlForInvoicePhoto('file:///data/photo.jpg')).toBeNull();
  });

  it('extracts invoice photos and filters without touching invoice contents', () => {
    const photos = extractInvoicePhotos({
      id: 'inv1',
      companyId: COMPANY,
      driverName: 'Mikezfold',
      invoiceNumber: '20205',
      wellName: 'GABRIEL 7-36-25TFH',
      disposalName: 'SWD 1',
      createdAtMs: 1_700_000_000_000,
      photos: [
        { photoId: 'ph_1', type: 'pickup', uri: 'https://storage.googleapis.com/b/photos/c/inv1/ph_1.jpg' },
        { photoId: 'ph_jsa', type: 'jsa', uri: 'https://storage.googleapis.com/b/jsa.pdf' },
        { photoId: 'ph_pending', type: 'dropoff', deliveryPending: true },
      ],
    }, COMPANY);
    expect(photos.map((p) => p.photoId)).toEqual(['ph_1', 'ph_pending']);
    expect(photos[0].displayUrl).toContain('ph_1.jpg');
    expect(photos[1].deliveryPending).toBe(true);
    expect(photoMatchesFilters(photos[0], 'unreviewed', { pickup: 'gabriel', reviewStatus: 'unreviewed' })).toBe(true);
    expect(photoMatchesFilters(photos[0], 'approved', { reviewStatus: 'unreviewed' })).toBe(false);
    expect(extractInvoicePhotos({ id: 'x', companyId: OTHER, photos: [{ photoId: 'ph_1' }] }, COMPANY)).toEqual([]);
  });
});
