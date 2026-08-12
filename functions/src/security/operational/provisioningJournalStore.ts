/**
 * Firestore adapter for the provisioning journal.
 *
 * `claim` is a transactional get-or-create: concurrent retries of the same
 * attempt converge on whichever entry commits first, so a crash mid-attempt
 * can never produce a second canonical identity.
 *
 * The entry carries an attempt id, a UUID, a normalized name and a company
 * binding — deliberately NO passcode, hash, token, or other credential
 * material, so the journal is safe to read in an audit.
 */
import { randomUUID } from 'crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type {
  ProvisioningJournalDeps,
  ProvisioningJournalEntry,
} from './provisioningJournal';

export const PROVISIONING_JOURNAL_COLLECTION = 'driver_provisioning_attempts';

function readEntry(data: Record<string, unknown> | undefined): ProvisioningJournalEntry | null {
  if (!data) return null;
  const { attemptId, driverId, nameNorm, companyId, completed } = data;
  if (typeof attemptId !== 'string' || typeof driverId !== 'string'
      || typeof nameNorm !== 'string') {
    return null;
  }
  return {
    attemptId,
    driverId,
    nameNorm,
    companyId: typeof companyId === 'string' ? companyId : null,
    completed: completed === true,
  };
}

export function firestoreProvisioningJournal(db: Firestore): ProvisioningJournalDeps {
  const ref = (attemptId: string) =>
    db.collection(PROVISIONING_JOURNAL_COLLECTION).doc(attemptId);

  return {
    newUuid: () => randomUUID(),

    async read(attemptId) {
      const snap = await ref(attemptId).get();
      return snap.exists ? readEntry(snap.data() as Record<string, unknown>) : null;
    },

    async claim(attemptId, candidate) {
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref(attemptId));
        if (snap.exists) {
          const existing = readEntry(snap.data() as Record<string, unknown>);
          // A malformed entry must not be silently replaced — that would
          // mint a second identity for an attempt that may have written one.
          if (!existing) throw new Error('provisioning_journal_malformed');
          return existing;
        }
        tx.create(ref(attemptId), {
          ...candidate,
          createdAt: FieldValue.serverTimestamp(),
        });
        return candidate;
      });
    },

    async markCompleted(attemptId) {
      await ref(attemptId).set(
        { completed: true, completedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    },
  };
}
