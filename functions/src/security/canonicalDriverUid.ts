/**
 * Deterministic Firebase Auth UID for a canonical driver UUID.
 * Pure. Handlers may import this without pulling firebase-admin.
 */
export function canonicalDriverAuthUid(driverId: string): string {
  return `driver_${String(driverId).replace(/-/g, '').slice(0, 28)}`;
}

export function isCanonicalDriverAuthUid(uid: string, driverId: string): boolean {
  return typeof uid === 'string' && uid.length > 0 && uid === canonicalDriverAuthUid(driverId);
}
