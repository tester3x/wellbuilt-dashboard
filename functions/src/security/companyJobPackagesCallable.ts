import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { authorizeAdminCall } from '../admin/authority';
import { requireTrustedCompanyCapability } from './trustedStaffAuthority';
import { writeSecurityAudit } from './audit';
import { nextCompanyJobPackages, type PackageAction } from './operational/companyJobPackages';

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Package changes use trusted identity and a transaction over the current company record. */
export const staffSetCompanyJobPackage = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async request => {
    const input = request.data;
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['companyId', 'packageId', 'action'].includes(key))
      || typeof input.companyId !== 'string' || !ID.test(input.companyId)
      || typeof input.packageId !== 'string' || !ID.test(input.packageId)
      || !['install', 'remove'].includes(input.action)) {
      throw new httpsV2.HttpsError('invalid-argument', 'invalid_package_change');
    }
    if (!request.auth?.uid) throw new httpsV2.HttpsError('unauthenticated', 'sign_in_required');
    const db = admin.firestore();
    let actorUid = request.auth.uid;
    if (request.auth.token.wellbuiltAdmin === true) {
      const actor = await db.collection('platform_admins').doc(actorUid).get();
      const decision = authorizeAdminCall({ uid: actorUid, token: request.auth.token as Record<string, unknown> }, actor.data());
      if (!decision.ok) throw new httpsV2.HttpsError('permission-denied', decision.reason);
      actorUid = decision.actorUid;
    } else {
      const authority = await requireTrustedCompanyCapability(actorUid, 'manageCompany');
      if (authority.companyId !== input.companyId) throw new httpsV2.HttpsError('permission-denied', 'cross_company');
    }
    const companyRef = db.collection('companies').doc(input.companyId);
    const packageRef = db.collection('job_packages').doc(input.packageId);
    const result = await db.runTransaction(async tx => {
      const [company, catalog] = await Promise.all([tx.get(companyRef), tx.get(packageRef)]);
      if (!company.exists) throw new httpsV2.HttpsError('not-found', 'company_not_found');
      if (!catalog.exists) throw new httpsV2.HttpsError('not-found', 'package_not_found');
      const current = company.data()?.activePackages;
      let next: string[];
      try { next = nextCompanyJobPackages(current, input.packageId, input.action as PackageAction); }
      catch (error) { throw new httpsV2.HttpsError('failed-precondition', (error as Error).message); }
      if (next !== current) tx.update(companyRef, { activePackages: next });
      return { changed: next !== current, activePackages: next };
    });
    if (result.changed) await writeSecurityAudit({ action: 'staffSetCompanyJobPackage', actorUid,
      detail: { companyId: input.companyId, packageId: input.packageId, action: input.action } });
    return { ok: true, companyId: input.companyId, ...result };
  },
);
