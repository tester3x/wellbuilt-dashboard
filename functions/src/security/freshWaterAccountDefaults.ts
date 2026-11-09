import { createHash } from 'node:crypto';
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';

export function freshWaterDefaultsCollection(db: Firestore, companyId: string) {
  return db.collection('companies').doc(companyId).collection('fresh_water_defaults');
}

export function normalizeFreshWaterCustomer(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function freshWaterDefaultRef(db: Firestore, companyId: string, customer: string) {
  return freshWaterDefaultsCollection(db, companyId)
    .doc(createHash('sha256').update(customer).digest('hex'));
}

export function isFreshWaterDispatchJob(jobTypeId: unknown): boolean {
  return jobTypeId === 'fresh-water' || jobTypeId === 'fresh-water-tank-refill' || jobTypeId === 'fw';
}

export async function resolveFreshWaterAccount(
  db: Firestore,
  companyId: string,
  operator: unknown,
  read: (ref: DocumentReference) => ReturnType<DocumentReference['get']>,
): Promise<'customer' | 'company'> {
  const name = normalizeFreshWaterCustomer(operator);
  if (!name) return 'company';
  const { account } = (await read(freshWaterDefaultRef(db, companyId, name))).data() ?? {};
  return account === 'customer' ? 'customer' : 'company';
}
