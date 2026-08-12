/**
 * adminBindDriverCompany — governed INITIAL company binding for a canonical
 * secure driver.
 *
 * The client-side Company action patches drivers/approved/{hash} only; a
 * canonical driver bound that way ends up with a profile company and NO
 * driver_shift_authority, so Start Shift is permanently unverifiable. This
 * callable is the server-owned replacement: it validates preconditions,
 * records the target durably, ensures the initialized empty authority under
 * the SAME canonical UUID, binds the profile, and reports success only once
 * both stores agree. All decision logic lives in
 * operational/companyBinding.ts and is exercised by dynamic in-memory tests.
 *
 * NOT deployed by this commit. Future selector:
 *   --only functions:adminBindDriverCompany
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireManageDrivers } from './adminAuth';
import { writeSecurityAudit } from './audit';
import {
  executeCompanyBinding,
  type BindingIo,
  type DriverProfileView,
} from './operational/companyBinding';
import { firestoreCompanyBindingJournal } from './operational/companyBindingStore';
import {
  ensureInitializedEmptyShiftAuthority,
} from './operational/ensureEmptyShiftAuthority';
import {
  shiftAuthorityPath,
  type ShiftAuthorityRecord,
} from './operational/shiftAuthority';

const rtdb = () => admin.database();
const fs = () => admin.firestore();

/** Exact-key payload — anything else is refused before any read. */
const ALLOWED_KEYS = new Set(['driverId', 'companyId']);

function readAuthorityRecord(
  data: Record<string, unknown> | undefined,
): ShiftAuthorityRecord | null {
  if (!data) return null;
  const { driverId, companyId, initialized, openPeriodId, originLocalDate, version } = data;
  if (typeof driverId !== 'string' || typeof companyId !== 'string'
      || typeof initialized !== 'boolean' || typeof version !== 'number') {
    return null;
  }
  return {
    driverId,
    companyId,
    initialized,
    openPeriodId: typeof openPeriodId === 'string' ? openPeriodId : null,
    originLocalDate: typeof originLocalDate === 'string' ? originLocalDate : null,
    lastClosedPeriodId:
      typeof data.lastClosedPeriodId === 'string' ? data.lastClosedPeriodId : null,
    version,
  };
}

function productionIo(actorUid: string): BindingIo {
  return {
    async readProfile(driverId): Promise<DriverProfileView> {
      const snap = await rtdb().ref(`drivers/profiles/${driverId}`).once('value');
      if (!snap.exists()) return { exists: false };
      const v = snap.val() as Record<string, unknown>;
      return {
        exists: true,
        active: v.active !== false,
        companyId: typeof v.companyId === 'string' ? v.companyId : null,
        companyName: typeof v.companyName === 'string' ? v.companyName : null,
        displayName: typeof v.displayName === 'string' ? v.displayName : null,
      };
    },

    async readCompany(companyId) {
      const snap = await fs().collection('companies').doc(companyId).get();
      if (!snap.exists) return { exists: false };
      const v = snap.data() as Record<string, unknown>;
      return {
        exists: true,
        status: typeof v.status === 'string' ? v.status : null,
        name: typeof v.name === 'string' ? v.name : null,
      };
    },

    async readAuthority(driverId) {
      const snap = await fs().doc(shiftAuthorityPath(driverId)).get();
      if (!snap.exists) return { record: null, malformed: false };
      const record = readAuthorityRecord(snap.data() as Record<string, unknown>);
      return { record, malformed: record === null };
    },

    async ensureAuthority(driverId, companyId) {
      const result = await ensureInitializedEmptyShiftAuthority(fs(), {
        driverId,
        companyId,
      });
      return result.decision.action;
    },

    async writeProfileBinding(driverId, companyId, companyName) {
      await rtdb().ref(`drivers/profiles/${driverId}`).update({
        companyId,
        companyName,
        companyBoundAt: Date.now(),
        companyBoundBy: actorUid,
      });
    },

    journal: firestoreCompanyBindingJournal(fs()),
  };
}

/** Refusals that are the caller's precondition to fix, not a server fault. */
const PRECONDITION_REASONS = new Set([
  'not_canonical_driver_id',
  'unknown_driver',
  'inactive_driver',
  'unknown_company',
  'inactive_company',
  'already_bound_elsewhere',
  'open_shift',
  'authority_mismatch',
  'authority_malformed',
  'binding_attempt_conflict',
  'authority_refused',
]);

export const adminBindDriverCompany = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    const caller = await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );

    const raw = (request.data || {}) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_KEYS.has(key)) {
        throw new httpsV2.HttpsError('invalid-argument', `Unexpected field: ${key}`);
      }
    }
    const driverId = String(raw.driverId || '').trim();
    const companyId = String(raw.companyId || '').trim().toLowerCase();
    if (!driverId || !companyId) {
      throw new httpsV2.HttpsError('invalid-argument', 'driverId and companyId are required');
    }

    // Tenant scope: a company-scoped admin may bind drivers only to its OWN
    // company. Platform admins (no companyId) may bind to any.
    if (caller.companyId && caller.companyId !== companyId) {
      throw new httpsV2.HttpsError(
        'permission-denied',
        'Caller may not bind drivers to another company',
      );
    }

    const result = await executeCompanyBinding(productionIo(caller.uid), {
      driverId,
      companyId,
    });

    await writeSecurityAudit({
      action: 'adminBindDriverCompany',
      actorUid: caller.uid,
      driverId,
      detail: {
        companyId,
        outcome: result.ok
          ? `bound:${result.authority}${result.alreadyBound ? ':idempotent' : ''}`
          : `refused:${result.reason}`,
      },
    });

    if (!result.ok) {
      throw new httpsV2.HttpsError(
        PRECONDITION_REASONS.has(result.reason) ? 'failed-precondition' : 'internal',
        result.reason,
      );
    }
    return {
      ok: true,
      companyId: result.companyId,
      companyName: result.companyName,
      alreadyBound: result.alreadyBound,
      authority: result.authority,
    };
  },
);
