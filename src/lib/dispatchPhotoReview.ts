import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';

export type PhotoReviewListItem = {
  invoiceId: string;
  photoId: string;
  companyId: string;
  driverId: string;
  driverName: string;
  invoiceNumber: string;
  ticketNumber: string;
  pickup: string;
  dropoff: string;
  photoType: string;
  location: string;
  takenAt: string | null;
  createdAtMs: number | null;
  displayUrl: string | null;
  deliveryPending: boolean;
  reviewStatus: 'unreviewed' | 'approved' | 'rejected' | 'addressed';
  rejectReason: string | null;
  supervisorNote: string | null;
  addressedNote: string | null;
  reviewedByLabel: string | null;
  reviewedAtMs: number | null;
  addressedByLabel: string | null;
  addressedAtMs: number | null;
  dispatchHref: string;
};

export async function listDispatchPhotoReviews(filters: Record<string, unknown>) {
  const fn = httpsCallable(getFirebaseFunctions(), 'listDispatchPhotoReviews');
  const res = await fn(filters);
  return res.data as { ok: true; companyId: string; count: number; items: PhotoReviewListItem[] };
}

export async function reviewDispatchPhoto(input: {
  companyId?: string;
  invoiceId: string;
  photoId: string;
  action: 'approve' | 'reject' | 'address';
  rejectReason?: string;
  supervisorNote?: string;
  addressedNote?: string;
}) {
  const fn = httpsCallable(getFirebaseFunctions(), 'reviewDispatchPhoto');
  const res = await fn(input);
  return res.data as { ok: true; invoiceId: string; photoId: string; status: string; reviewedAtMs: number | null; addressedAtMs: number | null };
}
