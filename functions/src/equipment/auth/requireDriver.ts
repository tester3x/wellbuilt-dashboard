import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { DriverActor, DriverProfile } from '../types/actor';

const db = admin.database();

/** Validate driverHash against RTDB drivers/approved (same model as WB-T callables). */
export async function requireDriver(actor: DriverActor): Promise<DriverProfile> {
  if (!actor?.driverHash || typeof actor.driverHash !== 'string') {
    throw new httpsV2.HttpsError('invalid-argument', 'driverHash is required');
  }

  const hash = actor.driverHash.trim().toLowerCase();
  const snap = await db.ref(`drivers/approved/${hash}`).once('value');
  if (!snap.exists()) {
    throw new httpsV2.HttpsError('permission-denied', 'Driver not found in approved drivers');
  }

  const data = snap.val();
  if (data.active === false) {
    throw new httpsV2.HttpsError('permission-denied', 'Driver account is deactivated');
  }

  const displayName = data.displayName || data.legalName || 'Driver';
  return {
    driverHash: hash,
    displayName,
    companyId: data.companyId || undefined,
    companyName: data.companyName || undefined,
  };
}