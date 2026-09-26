/**
 * Authenticated reference-data reads for field apps after default-deny.
 * Returns non-secret catalogs: app_registry slice, company public fields, job packages.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from '../requireDriverAuth';
import {
  buildGovernedPackageProfile,
  revisionDocIdFromIndex,
  type GovernedPackageProfile,
} from './governedProfileCore';

export const getDriverReferenceBundle = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async (request) => {
    const data = (request.data || {}) as { driverHash?: string };
    const driver = await requireSecureDriver(request, {
      allowLegacyHash: true,
      legacyDriverHash: data.driverHash,
    });

    const fs = admin.firestore();
    const [apps, packages] = await Promise.all([
      fs.collection('app_registry').get(),
      fs.collection('job_packages').limit(50).get(),
    ]);

    let company: Record<string, unknown> | null = null;
    if (driver.companyId) {
      const c = await fs.collection('companies').doc(driver.companyId).get();
      if (c.exists) {
        const d = c.data() || {};
        // Public subset only
        company = {
          id: c.id,
          name: d.name,
          tier: d.tier,
          roleLabels: d.roleLabels,
        };
      }
    }

    // Driver profile (self)
    const prof = await admin.database().ref(`drivers/profiles/${driver.driverId}`).once('value');

    // Governed pre-binding job-type profiles — the CURRENT published packet
    // revision's per-job-type capability matrix, so field apps can gate
    // execution variants (e.g. planned Split Tickets) BEFORE a job exists,
    // on governed authority (never the V9 job_packages catalog). Company-scoped
    // from the trusted identity; unpublished revisions are never exposed; fails
    // closed (omits a package) on any missing/malformed/cross-tenant data.
    // Read-only — never mutates packet/package data or weakens pinning.
    const governedPackageProfiles: GovernedPackageProfile[] = [];
    if (driver.companyId) {
      try {
        const idxSnap = await fs
          .collection('job_packet_package_index')
          .where('companyId', '==', driver.companyId)
          .get();
        for (const idx of idxSnap.docs) {
          const indexData = idx.data() || {};
          const revId = revisionDocIdFromIndex(idx.id, indexData);
          if (!revId) continue;
          const revSnap = await fs.collection('job_packet_revisions').doc(revId).get();
          if (!revSnap.exists) continue;
          const profile = buildGovernedPackageProfile({
            companyId: driver.companyId,
            indexDocId: idx.id,
            indexData,
            revisionData: revSnap.data() || null,
          });
          if (profile) governedPackageProfiles.push(profile);
        }
      } catch {
        // Fail closed — an unavailable governed index yields no profiles, never
        // a catalog fallback. Field apps treat absence as "capability unavailable".
      }
    }

    return {
      driverId: driver.driverId,
      companyId: driver.companyId || null,
      profile: prof.val() || null,
      company,
      appRegistry: apps.docs.map((d) => ({ id: d.id, ...d.data() })),
      jobPackages: packages.docs.map((d) => ({ id: d.id, name: d.data()?.name, ...d.data() })),
      governedPackageProfiles,
    };
  },
);
