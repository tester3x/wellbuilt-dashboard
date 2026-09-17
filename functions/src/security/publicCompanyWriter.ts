/**
 * Phase 1A server-owned writer: companies/{id} → public_companies/{id}.
 *
 * Full-document `set` (merge: false) so a field removed from the source
 * cannot remain stale on the public projection. Source delete removes
 * the projection. Admin SDK only — clients cannot write public_companies.
 *
 * NOT deployed this packet. Selector when approved:
 *   --only functions:projectPublicCompanyOnWrite
 */
import * as admin from 'firebase-admin';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import {
  PUBLIC_COMPANY_COLLECTION,
  buildPublicCompanyDocument,
} from './publicCompanyProjection';

export type PublicCompanyWriteResult = 'projected' | 'deleted';

export interface PublicCompanyStore {
  set(path: string, data: Record<string, unknown>, opts: { merge: false }): Promise<unknown>;
  delete(path: string): Promise<unknown>;
}

export function firestorePublicCompanyStore(
  db: admin.firestore.Firestore,
): PublicCompanyStore {
  return {
    set(path, data, opts) {
      return db.doc(path).set(data, opts);
    },
    delete(path) {
      return db.doc(path).delete();
    },
  };
}

export function publicCompanyPath(companyId: string): string {
  return `${PUBLIC_COMPANY_COLLECTION}/${companyId}`;
}

/**
 * Apply one source snapshot to the public projection.
 * `exists=false` deletes the public doc (including a missing public doc).
 */
export async function applyPublicCompanyProjection(
  store: PublicCompanyStore,
  companyId: string,
  source: Record<string, unknown> | null | undefined,
  exists: boolean,
  updatedAt: unknown,
): Promise<PublicCompanyWriteResult> {
  const path = publicCompanyPath(companyId);
  if (!exists) {
    await store.delete(path);
    return 'deleted';
  }
  const projected = buildPublicCompanyDocument(source, updatedAt);
  await store.set(path, projected, { merge: false });
  return 'projected';
}

export const projectPublicCompanyOnWrite = onDocumentWritten(
  {
    document: 'companies/{companyId}',
    region: 'us-central1',
  },
  async (event) => {
    const companyId = event.params.companyId;
    if (!companyId) return;
    const after = event.data?.after;
    const exists = Boolean(after?.exists);
    await applyPublicCompanyProjection(
      firestorePublicCompanyStore(admin.firestore()),
      companyId,
      exists ? after?.data() : undefined,
      exists,
      admin.firestore.FieldValue.serverTimestamp(),
    );
  },
);
