/**
 * Production I/O adapter for customer-owned upgrade and canonical hydration.
 * Binding documents are Admin-only; they are never written onto profiles.
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { Database } from 'firebase-admin/database';
import {
  decideCompensation,
  decideNameIndexClaim,
  readIncumbentCredential,
  readIndexOwner,
} from '../nameIndexClaim';
import { firestoreProvisioningJournal } from './provisioningJournalStore';
import { decideEnsureEmptyAuthority, shiftAuthorityPath } from './shiftAuthority';
import { decideAuthorityDelete, isServerScryptRecord } from './approvedRowConversion';
import {
  BINDING_BY_APPROVED,
  BINDING_BY_DRIVER,
  BINDING_ROOT,
  parseBinding,
  type IdentityBinding,
} from './identityBinding';
import { profileContainsForbiddenLegacyKey } from './canonicalProfileHydration';
import { commitIdentityBindingWrite } from './bindingApplyTransaction';
import { commitCanonicalHydrationWrite } from './hydrationApplyTransaction';
import type { UpgradeStore } from './customerOwnedUpgrade';

export function productionUpgradeStore(db: Firestore, rtdb: Database): UpgradeStore {
  return {
    journal: firestoreProvisioningJournal(db),
    async readApproved(key) {
      const snap = await rtdb.ref(`drivers/approved/${key}`).once('value');
      return snap.exists() ? (snap.val() as Record<string, unknown>) : null;
    },
    async readProfile(driverId) {
      const snap = await rtdb.ref(`drivers/profiles/${driverId}`).once('value');
      return snap.exists() ? (snap.val() as Record<string, unknown>) : null;
    },
    async readBindingByDriver(driverId) {
      const snap = await rtdb.ref(BINDING_BY_DRIVER(driverId)).once('value');
      return parseBinding(snap.val());
    },
    async readBindingByApproved(approvedKey) {
      const snap = await rtdb.ref(BINDING_BY_APPROVED(approvedKey)).once('value');
      return parseBinding(snap.val());
    },
    async writeBinding(binding: IdentityBinding) {
      const result = await commitIdentityBindingWrite({
        bindingsRef: rtdb.ref(BINDING_ROOT) as never,
        driverId: binding.driverId,
        approvedKey: binding.approvedKey,
        status: binding.status,
        opId: binding.opId,
      });
      if (!result.ok) return 'foreign';
      return result.action;
    },
    async commitProfileHydration(input) {
      const result = await commitCanonicalHydrationWrite({
        profileRef: rtdb.ref(`drivers/profiles/${input.driverId}`) as never,
        driverId: input.driverId,
        approvedKey: input.approvedKey,
        expectedDigest: input.expectedDigest,
        legacyRow: input.legacyRow,
        copy: input.copy,
        preview: input.preview,
        opId: input.opId,
      });
      if (!result.ok) {
        if (result.reason === 'stale_preview') return 'stale_preview';
        return 'foreign';
      }
      return result.action === 'already_exact' ? 'already_exact' : 'written';
    },
    async removeBindingIfOwned(input) {
      const snap = await rtdb.ref(BINDING_BY_DRIVER(input.driverId)).once('value');
      const binding = parseBinding(snap.val());
      if (!binding) return 'missing';
      if (binding.opId !== input.opId || binding.approvedKey !== input.approvedKey) {
        return 'left_intact';
      }
      await rtdb.ref(BINDING_BY_DRIVER(input.driverId)).remove();
      await rtdb.ref(BINDING_BY_APPROVED(input.approvedKey)).remove();
      return 'removed';
    },
    async writeIdentity(input) {
      await db.runTransaction(async (tx) => {
        const idxRef = db.collection('driver_name_index').doc(input.nameNorm);
        const credRef = db.collection('driver_credentials').doc(input.driverId);
        const idxSnap = await tx.get(idxRef);
        const existingDriverId = readIndexOwner(idxSnap.exists, idxSnap.data());
        let incumbentCredential = readIncumbentCredential(false, undefined);
        if (
          existingDriverId
          && existingDriverId !== 'malformed'
          && existingDriverId !== input.driverId
        ) {
          const other = await tx.get(db.collection('driver_credentials').doc(existingDriverId));
          incumbentCredential = readIncumbentCredential(other.exists, other.data());
        }
        const claim = decideNameIndexClaim({
          existingDriverId,
          targetDriverId: input.driverId,
          incumbentCredential,
        });
        if (!claim.allow) throw new Error(`index_claim:${claim.reason}`);
        const credSnap = await tx.get(credRef);
        if (credSnap.exists && credSnap.data()?.opId && credSnap.data()?.opId !== input.opId) {
          throw new Error('credential_foreign');
        }
        tx.set(idxRef, { driverId: input.driverId, updatedAt: FieldValue.serverTimestamp() });
        tx.set(credRef, {
          displayNameNorm: input.nameNorm,
          displayName: input.displayName,
          passcode: input.passcodeRecord,
          active: true,
          opId: input.opId,
          setBy: input.callerUid,
          mustResetPasscode: false,
          createdAt: FieldValue.serverTimestamp(),
        });
      });
    },
    async compensateIdentity(input) {
      const credRef = db.collection('driver_credentials').doc(input.driverId);
      const idxRef = db.collection('driver_name_index').doc(input.nameNorm);
      const credSnap = await credRef.get();
      const idxSnap = await idxRef.get();
      const d = decideCompensation({
        credentialExists: credSnap.exists,
        credentialOpId: credSnap.data()?.opId,
        myOpId: input.opId,
        indexExists: idxSnap.exists,
        indexDriverId: idxSnap.data()?.driverId,
        myDriverId: input.driverId,
      });
      if (d.deleteCredential) await credRef.delete();
      if (d.releaseIndex) await idxRef.delete();
      return {
        deletedCredential: d.deleteCredential,
        releasedIndex: d.releaseIndex,
        superseded: d.superseded,
      };
    },
    async writeProfile(driverId, profile) {
      if (profileContainsForbiddenLegacyKey(profile)) {
        throw new Error('profile_leaks_legacy_key');
      }
      await rtdb.ref(`drivers/profiles/${driverId}`).set(profile);
      return 'written';
    },
    async removeProfileIfOwned(driverId, opId) {
      const ref = rtdb.ref(`drivers/profiles/${driverId}`);
      const snap = await ref.once('value');
      if (!snap.exists()) return 'missing';
      if (snap.val()?.provisioningOpId !== opId) return 'left_intact';
      await ref.remove();
      return 'removed';
    },
    async ensureAuthority(input) {
      const ref = db.doc(shiftAuthorityPath(input.driverId));
      const snap = await ref.get();
      const d = decideEnsureEmptyAuthority({
        driverId: input.driverId,
        companyId: input.companyId,
        existing: snap.exists ? (snap.data() as never) : null,
      });
      if (d.action === 'create') {
        await ref.set({ ...d.record, provisioningOpId: input.opId });
        return { action: 'create', wrote: true };
      }
      return { action: d.action, wrote: false };
    },
    async removeAuthorityIfOwned(driverId, opId, expectedCompanyId) {
      const ref = db.doc(shiftAuthorityPath(driverId));
      const snap = await ref.get();
      const d = decideAuthorityDelete({
        existing: snap.exists ? snap.data() as Record<string, unknown> : null,
        myOpId: opId,
        myDriverId: driverId,
        expectedCompanyId,
      });
      if (d === 'removed') await ref.delete();
      return d;
    },
    async inspect(driverId, nameNorm, approvedKey) {
      const [cred, idx, prof, byDriver, byApproved] = await Promise.all([
        db.collection('driver_credentials').doc(driverId).get(),
        db.collection('driver_name_index').doc(nameNorm).get(),
        rtdb.ref(`drivers/profiles/${driverId}`).once('value'),
        rtdb.ref(BINDING_BY_DRIVER(driverId)).once('value'),
        rtdb.ref(BINDING_BY_APPROVED(approvedKey)).once('value'),
      ]);
      const journal = await firestoreProvisioningJournal(db).read(`legacy:${approvedKey}`);
      const credData = cred.data();
      const bindingByDriver = parseBinding(byDriver.val());
      const bindingByApproved = parseBinding(byApproved.val());
      const termOk = bindingByDriver && bindingByApproved
        && bindingByDriver.driverId === bindingByApproved.driverId
        && bindingByDriver.approvedKey === bindingByApproved.approvedKey
        && bindingByDriver.status === bindingByApproved.status
        && bindingByDriver.opId === bindingByApproved.opId;
      return {
        credentialOpId: typeof credData?.opId === 'string' ? credData.opId : null,
        credentialActive: typeof credData?.active === 'boolean' ? credData.active : cred.exists ? true : null,
        credentialScryptValid: isServerScryptRecord(credData?.passcode),
        indexDriverId: idx.data()?.driverId ?? null,
        profile: prof.exists() ? (prof.val() as Record<string, unknown>) : null,
        bindingByDriver,
        bindingByApproved,
        binding: termOk ? bindingByDriver : null,
        journalCompleted: journal ? journal.completed === true : null,
      };
    },
    async readNameIndex(nameNorm) {
      const snap = await db.collection('driver_name_index').doc(nameNorm).get();
      const id = snap.data()?.driverId;
      return typeof id === 'string' ? id : null;
    },
    async readCredentialActive(driverId) {
      const snap = await db.collection('driver_credentials').doc(driverId).get();
      if (!snap.exists) return false;
      return snap.data()?.active !== false;
    },
  };
}
