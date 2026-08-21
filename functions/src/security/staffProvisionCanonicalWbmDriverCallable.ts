/**
 * Admin-governed NEW canonical WB-M tester. Does not search legacy records.
 * Existing consistent accounts must KEEP_CANONICAL and receive assignment
 * repair — not recreation.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { randomUUID } from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { requireManageDrivers } from './adminAuth';
import { writeSecurityAudit } from './audit';
import { hashPasscodeScrypt } from './passcode';
import { evaluateCanonicalProvision } from './operational/staffProvisionCanonicalWbmDriver';
import { parseScopeList } from './operational/assignmentScope';

function normalizeDisplayName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '');
}

export const staffProvisionCanonicalWbmDriver = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const caller = await requireManageDrivers(
      request.auth?.uid,
      request.auth?.token as Record<string, unknown> | undefined,
    );
    const raw = (request.data || {}) as Record<string, unknown>;
    const mode = raw.mode === 'apply' ? 'apply' : 'dry-run';
    const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
    const companyId = typeof raw.companyId === 'string' ? raw.companyId.trim() : '';
    const companyName = typeof raw.companyName === 'string' ? raw.companyName.trim() : '';
    const passcode = typeof raw.passcode === 'string' ? raw.passcode : '';

    const nameNorm = displayName ? normalizeDisplayName(displayName) : '';
    const idx = nameNorm
      ? await admin.firestore().collection('driver_name_index').doc(nameNorm).get()
      : null;
    const owner = idx && idx.exists ? String(idx.data()?.driverId || '') : null;

    const decided = evaluateCanonicalProvision({
      displayName,
      companyId,
      nameIndexOwner: owner,
      assignedRoutes: raw.assignedRoutes,
      assignedWells: raw.assignedWells,
    });
    if (!decided.ok) {
      throw new httpsV2.HttpsError('failed-precondition', decided.reason);
    }

    let routes: string[] | null = null;
    let wells: string[] | null = null;
    if (decided.scopeState === 'configured') {
      const r = parseScopeList(raw.assignedRoutes ?? [], 'assignedRoutes');
      if (!r.ok) throw new httpsV2.HttpsError('invalid-argument', r.reason);
      const w = parseScopeList(raw.assignedWells ?? [], 'assignedWells');
      if (!w.ok) throw new httpsV2.HttpsError('invalid-argument', w.reason);
      routes = r.values;
      wells = w.values;
    }

    const preview = {
      ok: true as const,
      mode,
      displayName,
      companyId,
      scopeState: decided.scopeState,
      assignedRoutes: routes,
      assignedWells: wells,
    };
    if (mode !== 'apply') return preview;
    if (passcode.length < 6) {
      throw new httpsV2.HttpsError('invalid-argument', 'passcode_required');
    }

    const driverId = randomUUID();
    const passcodeRecord = await hashPasscodeScrypt(passcode);
    await admin.firestore().collection('driver_name_index').doc(nameNorm).set({ driverId });
    await admin.firestore().collection('driver_credentials').doc(driverId).set({
      displayNameNorm: nameNorm,
      displayName,
      passcode: passcodeRecord,
      active: true,
      mustResetPasscode: false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      setBy: caller.uid,
      source: 'canonical_wbm',
    });
    await admin.database().ref(`drivers/profiles/${driverId}`).set({
      displayName,
      legalName: typeof raw.legalName === 'string' ? raw.legalName : displayName,
      name: displayName,
      active: true,
      companyId,
      companyName: companyName || null,
      assignedRoutes: routes,
      assignedWells: wells,
      assignmentRevision: 0,
      roles: ['driver'],
      mustUseSecureAuth: true,
      schemaVersion: 1,
      approvedAt: Date.now(),
      approvedBy: caller.uid,
      source: 'canonical_wbm',
    });
    const { ensureDriverAuthUser } = await import('./tokenMint');
    const authUid = await ensureDriverAuthUser(driverId, displayName);
    await writeSecurityAudit({
      action: 'staffProvisionCanonicalWbmDriver',
      actorUid: caller.uid,
      driverId,
      detail: { companyId, scopeState: decided.scopeState, authUid },
    });
    return { ...preview, driverId, authUid };
  },
);
