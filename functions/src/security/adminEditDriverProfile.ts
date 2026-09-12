import * as https from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { requireManageDrivers } from './adminAuth';
import { writeSecurityAudit } from './audit';

export const EDITABLE_DRIVER_FIELDS = ['legalName', 'phone', 'email', 'truckNumber', 'trailerNumber', 'preferredLanguage'] as const;

export function validateDriverEdits(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new https.HttpsError('invalid-argument', 'Edits required');
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!(EDITABLE_DRIVER_FIELDS as readonly string[]).includes(key) || typeof item !== 'string' || item.length > 250) {
      throw new https.HttpsError('invalid-argument', `Invalid editable field: ${key}`);
    }
    result[key] = item.trim();
  }
  if (!Object.keys(result).length) throw new https.HttpsError('invalid-argument', 'No edits');
  return result;
}

export const adminEditDriverProfile = https.onCall({ timeoutSeconds: 30, memory: '256MiB' }, async request => {
  const caller = await requireManageDrivers(request.auth?.uid, request.auth?.token);
  const { driverId, edits } = request.data || {};
  if (typeof driverId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(driverId)) throw new https.HttpsError('invalid-argument', 'Invalid driver ID');
  const cleaned = validateDriverEdits(edits);
  let refusal = 'Profile no longer exists';
  let editedExistingProfile = false;
  const result = await admin.database().ref(`drivers/profiles/${driverId}`).transaction(current => {
    editedExistingProfile = false;
    // null may be an empty SDK cache, not an absent server record. Propose
    // a null no-op so Firebase compares against the server and retries with
    // its real value. Never create a replacement for a deleted profile.
    if (current === null) return null;
    if (!caller.isPlatformAdmin && (!caller.companyId || current.companyId !== caller.companyId)) {
      refusal = 'Driver is outside your company'; return;
    }
    // Merge at the canonical parent so nested and top-level readers agree,
    // preserving concurrently updated routes, company, credentials and history.
    editedExistingProfile = true;
    return { ...current, ...cleaned, profile: { ...(current.profile || {}), ...cleaned } };
  });
  if (!result.committed || !editedExistingProfile) throw new https.HttpsError('failed-precondition', refusal);
  await writeSecurityAudit({ action: 'adminEditDriverProfile', actorUid: caller.uid, driverId, detail: { fields: Object.keys(cleaned) } });
  return { ok: true };
});
