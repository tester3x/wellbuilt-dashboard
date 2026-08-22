/**
 * Production I/O adapter for approved-row conversion.
 * Ownership checks prevent stale compensation from deleting newer artifacts.
 *
 * Authority create/tag and delete run inside a single Firestore transaction.
 * Profile writes report written / already_exact / foreign so a foreign
 * document cannot be silently treated as ours.
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
import {
  decideEnsureEmptyAuthority,
  shiftAuthorityPath,
} from './shiftAuthority';
import {
  decideAuthorityDelete,
  decideProfileWrite,
  type ConversionStore,
} from './approvedRowConversion';

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
      let outcome: 'written' | 'already_exact' | 'foreign' = 'written';
      const tx = await ref.transaction((current) => {
        const existing = current && typeof current === 'object'
          ? current as Record<string, unknown>
          : null;
        const decision = decideProfileWrite({ existing, incoming: profile });
        if (decision === 'foreign') {
          outcome = 'foreign';
          return current;
        }
        if (decision === 'already_exact') {
          outcome = 'already_exact';
          return current;
        }
        outcome = 'written';
        return profile;
      });
      if (!tx.committed) return 'foreign';
      return outcome;
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
      const pre = decideEnsureEmptyAuthority({
        driverId: input.driverId,
        companyId: input.companyId,
        existing: null,
      });
      if (pre.action === 'skip') return { action: 'skip', wrote: false };

      const ref = db.doc(shiftAuthorityPath(input.driverId.trim()));
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) {
          const d = decideEnsureEmptyAuthority({
            driverId: input.driverId,
            companyId: input.companyId,
            existing: null,
          });
          if (d.action === 'create') {
            tx.create(ref, {
              ...d.record,
              provisioningOpId: input.opId,
              updatedAt: FieldValue.serverTimestamp(),
            });
            return { action: 'create', wrote: true };
          }
          return { action: d.action, wrote: false };
        }

        const data = (snap.data() || {}) as Record<string, unknown>;
        const existingOp = data.provisioningOpId;
        if (typeof existingOp === 'string' && existingOp !== input.opId) {
          // Foreign or previous-attempt ownership: never retag an open or
          // modified pointer as this operation's. A healthy empty pointer
          // is preserved as noop without attaching our marker.
          const d = decideEnsureEmptyAuthority({
            driverId: input.driverId,
            companyId: input.companyId,
            existing: {
              driverId: String(data.driverId || ''),
              companyId: String(data.companyId || ''),
              initialized: data.initialized === true,
              openPeriodId: typeof data.openPeriodId === 'string' ? data.openPeriodId : null,
              originLocalDate: typeof data.originLocalDate === 'string' ? data.originLocalDate : null,
              version: typeof data.version === 'number' ? data.version : 0,
            },
          });
          return { action: d.action, wrote: false };
        }

        const d = decideEnsureEmptyAuthority({
          driverId: input.driverId,
          companyId: input.companyId,
          existing: {
            driverId: String(data.driverId || ''),
            companyId: String(data.companyId || ''),
            initialized: data.initialized === true,
            openPeriodId: typeof data.openPeriodId === 'string' ? data.openPeriodId : null,
            originLocalDate: typeof data.originLocalDate === 'string' ? data.originLocalDate : null,
            version: typeof data.version === 'number' ? data.version : 0,
          },
        });
        if (d.action === 'initialize_uninitialized') {
          if (data.openPeriodId != null) return { action: 'refuse', wrote: false };
          tx.update(ref, {
            driverId: d.record.driverId,
            companyId: d.record.companyId,
            initialized: true,
            openPeriodId: null,
            originLocalDate: null,
            version: d.record.version + 1,
            provisioningOpId: input.opId,
            updatedAt: FieldValue.serverTimestamp(),
          });
          return { action: 'initialize_uninitialized', wrote: true };
        }
        // noop / refuse / skip — never attach ownership to open or healthy
        // pre-existing authority.
        return { action: d.action, wrote: false };
      });
    },
    async removeAuthorityIfOwned(driverId, opId, expectedCompanyId) {
      const ref = db.doc(shiftAuthorityPath(driverId));
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const existing = snap.exists ? (snap.data() as Record<string, unknown>) : null;
        const d = decideAuthorityDelete({
          existing,
          myOpId: opId,
          myDriverId: driverId,
          expectedCompanyId,
        });
        if (d === 'removed') tx.delete(ref);
        return d;
      });
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
      const authData = auth.exists ? (auth.data() as Record<string, unknown>) : null;
      const credData = cred.exists ? cred.data() : undefined;
      return {
        credentialOpId: typeof credData?.opId === 'string' ? String(credData.opId) : null,
        credentialDisplayNameNorm: typeof credData?.displayNameNorm === 'string'
          ? String(credData.displayNameNorm) : null,
        credentialActive: typeof credData?.active === 'boolean' ? credData.active : null,
        indexDriverId: typeof idx.data()?.driverId === 'string' ? String(idx.data()?.driverId) : null,
        profile,
        profileOpId: typeof profile?.provisioningOpId === 'string' ? String(profile.provisioningOpId) : null,
        authority: authData,
        authorityOpId: typeof authData?.provisioningOpId === 'string'
          ? String(authData.provisioningOpId) : null,
        authorityOpenPeriodId: typeof authData?.openPeriodId === 'string'
          ? String(authData.openPeriodId) : null,
        legacyLinkedDriverId: typeof row?.migratedToDriverId === 'string'
          ? String(row.migratedToDriverId) : null,
        legacyLinkOpId: typeof row?.linkOpId === 'string' ? String(row.linkOpId) : null,
        approvedDisplayName: typeof row?.displayName === 'string' ? String(row.displayName) : null,
        approvedSecureProfileLinked: row?.secureProfileLinked === true,
      };
    },
  };
}
