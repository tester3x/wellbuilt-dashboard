/**
 * Production I/O adapter for approved-row conversion.
 * Ownership checks prevent stale compensation from deleting newer artifacts.
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { Database } from 'firebase-admin/database';
import {
  decideCompensation,
  decideNameIndexClaim,
  readIncumbentCredential,
  readIndexOwner,
  type IncumbentCredentialState,
} from '../nameIndexClaim';
import { firestoreProvisioningJournal } from './provisioningJournalStore';
import { ensureInitializedEmptyShiftAuthority } from './ensureEmptyShiftAuthority';
import { shiftAuthorityPath } from './shiftAuthority';
import type { ConversionStore } from './approvedRowConversion';

export function productionConversionStore(
  db: Firestore,
  rtdb: Database,
): ConversionStore {
  return {
    journal: firestoreProvisioningJournal(db),
    async readApproved(key) {
      const snap = await rtdb.ref(`drivers/approved/${key}`).once('value');
      return snap.exists() ? (snap.val() as Record<string, unknown>) : null;
    },
    async stampLegacyLink(input) {
      const ref = rtdb.ref(`drivers/approved/${input.approvedKey}`);
      let outcome: 'stamped' | 'already_ours' | 'foreign_link' = 'foreign_link';
      const tx = await ref.transaction((current) => {
        if (!current || typeof current !== 'object') return current;
        const row = current as Record<string, unknown>;
        const existing = typeof row.migratedToDriverId === 'string' ? row.migratedToDriverId : '';
        if (existing && existing !== input.driverId) {
          outcome = 'foreign_link';
          return current;
        }
        if (existing === input.driverId) {
          outcome = 'already_ours';
          return current;
        }
        outcome = 'stamped';
        return {
          ...row,
          migratedToDriverId: input.driverId,
          secureProfileLinked: true,
          linkOpId: input.opId,
        };
      });
      if (!tx.committed) return 'foreign_link';
      return outcome;
    },
    async unstampLegacyLinkIfOwned(input) {
      const ref = rtdb.ref(`drivers/approved/${input.approvedKey}`);
      let result: 'removed' | 'left_intact' | 'missing' = 'missing';
      await ref.transaction((current) => {
        if (!current || typeof current !== 'object') {
          result = 'missing';
          return current;
        }
        const row = current as Record<string, unknown>;
        if (row.linkOpId !== input.opId || row.migratedToDriverId !== input.driverId) {
          result = 'left_intact';
          return current;
        }
        result = 'removed';
        const next = { ...row };
        delete next.migratedToDriverId;
        delete next.secureProfileLinked;
        delete next.linkOpId;
        return next;
      });
      return result;
    },
    async writeIdentity(input) {
      const idxRef = db.collection('driver_name_index').doc(input.nameNorm);
      const credRef = db.collection('driver_credentials').doc(input.driverId);
      await db.runTransaction(async (tx) => {
        const [idxSnap, credSnap] = await Promise.all([tx.get(idxRef), tx.get(credRef)]);
        if (credSnap.exists) {
          const existingOp = credSnap.data()?.opId;
          if (typeof existingOp === 'string' && existingOp !== input.opId) {
            throw new Error('credential_foreign');
          }
        }
        const existingDriverId = readIndexOwner(idxSnap.exists, idxSnap.data());
        let incumbentCredential: IncumbentCredentialState = 'absent';
        if (
          existingDriverId
          && existingDriverId !== 'malformed'
          && existingDriverId !== input.driverId
        ) {
          try {
            const otherCred = await tx.get(
              db.collection('driver_credentials').doc(existingDriverId),
            );
            incumbentCredential = readIncumbentCredential(
              otherCred.exists,
              otherCred.data(),
            );
          } catch {
            incumbentCredential = 'unreadable';
          }
        }
        const claim = decideNameIndexClaim({
          existingDriverId,
          targetDriverId: input.driverId,
          incumbentCredential,
        });
        if (!claim.allow) {
          throw new Error(`index_claim:${claim.reason}`);
        }
        tx.set(idxRef, { driverId: input.driverId });
        tx.set(credRef, {
          displayNameNorm: input.nameNorm,
          displayName: input.displayName,
          passcode: input.passcodeRecord,
          active: true,
          mustResetPasscode: input.temporary,
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
          setBy: input.callerUid,
          temporaryAssigned: input.temporary,
          opId: input.opId,
        }, { merge: true });
      });
    },
    async compensateIdentity(input) {
      const credRef = db.collection('driver_credentials').doc(input.driverId);
      const idxRef = db.collection('driver_name_index').doc(input.nameNorm);
      let deletedCredential = false;
      let releasedIndex = false;
      let superseded = false;
      await db.runTransaction(async (tx) => {
        const [credSnap, idxSnap] = await Promise.all([tx.get(credRef), tx.get(idxRef)]);
        const d = decideCompensation({
          credentialExists: credSnap.exists,
          credentialOpId: credSnap.data()?.opId,
          myOpId: input.opId,
          indexExists: idxSnap.exists,
          indexDriverId: idxSnap.data()?.driverId,
          myDriverId: input.driverId,
        });
        superseded = d.superseded;
        if (d.deleteCredential) {
          tx.delete(credRef);
          deletedCredential = true;
        }
        if (d.releaseIndex) {
          tx.delete(idxRef);
          releasedIndex = true;
        }
      });
      return { deletedCredential, releasedIndex, superseded };
    },
    async writeProfile(driverId, profile) {
      const ref = rtdb.ref(`drivers/profiles/${driverId}`);
      await ref.transaction((current) => {
        if (current && typeof current === 'object') {
          const existingOp = (current as Record<string, unknown>).provisioningOpId;
          const nextOp = profile.provisioningOpId;
          if (
            typeof existingOp === 'string'
            && typeof nextOp === 'string'
            && existingOp !== nextOp
          ) {
            return current;
          }
        }
        return profile;
      });
    },
    async removeProfileIfOwned(driverId, opId) {
      const ref = rtdb.ref(`drivers/profiles/${driverId}`);
      let result: 'removed' | 'left_intact' | 'missing' = 'missing';
      await ref.transaction((current) => {
        if (!current || typeof current !== 'object') {
          result = 'missing';
          return current;
        }
        const row = current as Record<string, unknown>;
        if (row.provisioningOpId !== opId) {
          result = 'left_intact';
          return current;
        }
        result = 'removed';
        return null;
      });
      return result;
    },
    async ensureAuthority(input) {
      const ensure = await ensureInitializedEmptyShiftAuthority(db, {
        driverId: input.driverId,
        companyId: input.companyId,
      });
      if (ensure.wrote) {
        const ref = db.doc(shiftAuthorityPath(input.driverId));
        try {
          await ref.update({ provisioningOpId: input.opId });
        } catch {
          const snap = await ref.get();
          const data = snap.data();
          const emptyOurs =
            snap.exists
            && data?.driverId === input.driverId
            && data?.initialized === true
            && (data?.openPeriodId == null)
            && data?.provisioningOpId == null;
          if (emptyOurs) await ref.delete();
          throw new Error('authority_tag_failed');
        }
      }
      return { action: ensure.decision.action, wrote: ensure.wrote };
    },
    async removeAuthorityIfOwned(driverId, opId) {
      const ref = db.doc(shiftAuthorityPath(driverId));
      const snap = await ref.get();
      if (!snap.exists) return 'missing';
      if (snap.data()?.provisioningOpId !== opId) return 'left_intact';
      await ref.delete();
      return 'removed';
    },
    async inspect(driverId, nameNorm, approvedKey) {
      const [cred, idx, prof, auth, approved] = await Promise.all([
        db.collection('driver_credentials').doc(driverId).get(),
        db.collection('driver_name_index').doc(nameNorm).get(),
        rtdb.ref(`drivers/profiles/${driverId}`).once('value'),
        db.doc(shiftAuthorityPath(driverId)).get(),
        rtdb.ref(`drivers/approved/${approvedKey}`).once('value'),
      ]);
      const profile = prof.exists() ? (prof.val() as Record<string, unknown>) : null;
      const row = approved.exists() ? (approved.val() as Record<string, unknown>) : null;
      return {
        credentialOpId: typeof cred.data()?.opId === 'string' ? String(cred.data()?.opId) : null,
        indexDriverId: typeof idx.data()?.driverId === 'string' ? String(idx.data()?.driverId) : null,
        profileOpId: typeof profile?.provisioningOpId === 'string' ? String(profile.provisioningOpId) : null,
        authorityOpId: typeof auth.data()?.provisioningOpId === 'string'
          ? String(auth.data()?.provisioningOpId) : null,
        legacyLinkedDriverId: typeof row?.migratedToDriverId === 'string'
          ? String(row.migratedToDriverId) : null,
        legacyLinkOpId: typeof row?.linkOpId === 'string' ? String(row.linkOpId) : null,
      };
    },
  };
}


