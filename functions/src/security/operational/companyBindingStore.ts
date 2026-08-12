/**
 * Firestore adapter for the company-binding attempt journal.
 *
 * Mirrors the accepted provisioning-journal store: `claim` is a
 * transactional get-or-create, so concurrent attempts for one driver
 * converge on whichever target committed first — a different-target racer
 * reads that entry back and refuses instead of interleaving. The entry
 * carries a driver id, a company id and a completion flag — deliberately
 * NO passcode, hash, token, or other credential material.
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  COMPANY_BINDING_JOURNAL_COLLECTION,
  type CompanyBindingJournalDeps,
  type CompanyBindingJournalEntry,
} from './companyBinding';

function readEntry(
  data: Record<string, unknown> | undefined,
): CompanyBindingJournalEntry | null {
  if (!data) return null;
  const { driverId, companyId, completed } = data;
  if (typeof driverId !== 'string' || typeof companyId !== 'string') return null;
  return { driverId, companyId, completed: completed === true };
}

export function firestoreCompanyBindingJournal(db: Firestore): CompanyBindingJournalDeps {
  const ref = (driverId: string) =>
    db.collection(COMPANY_BINDING_JOURNAL_COLLECTION).doc(driverId);

  return {
    async read(driverId) {
      const snap = await ref(driverId).get();
      return snap.exists ? readEntry(snap.data() as Record<string, unknown>) : null;
    },

    async claim(driverId, candidate) {
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref(driverId));
        if (snap.exists) {
          const existing = readEntry(snap.data() as Record<string, unknown>);
          // A malformed entry must not be silently replaced — the attempt
          // it recorded may have written an authority already.
          if (!existing) throw new Error('company_binding_journal_malformed');
          return existing;
        }
        tx.create(ref(driverId), {
          ...candidate,
          createdAt: FieldValue.serverTimestamp(),
        });
        return candidate;
      });
    },

    async markCompleted(driverId) {
      await ref(driverId).set(
        { completed: true, completedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    },
  };
}
