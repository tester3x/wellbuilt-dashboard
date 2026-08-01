/**
 * Authenticated reference-data reads for field apps after default-deny.
 * Returns non-secret catalogs: app_registry slice, company public fields, job packages.
 */
import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireSecureDriver } from '../requireDriverAuth';

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

    return {
      driverId: driver.driverId,
      companyId: driver.companyId || null,
      profile: prof.val() || null,
      company,
      appRegistry: apps.docs.map((d) => ({ id: d.id, ...d.data() })),
      jobPackages: packages.docs.map((d) => ({ id: d.id, name: d.data()?.name, ...d.data() })),
    };
  },
);
