import * as admin from 'firebase-admin';
import * as crypto from 'crypto';

const db = () => admin.database();

/**
 * Simple fixed-window rate limit stored in RTDB (Admin SDK only).
 * Returns true if allowed; false if limited.
 */
export async function checkRateLimit(opts: {
  bucket: string;
  key: string;
  limit: number;
  windowMs: number;
}): Promise<boolean> {
  const path = `security/rate_limit/${opts.bucket}/${sanitizeKey(opts.key)}`;
  const ref = db().ref(path);
  const now = Date.now();
  const snap = await ref.once('value');
  const cur = snap.val() as { windowStart?: number; count?: number } | null;
  if (!cur || !cur.windowStart || now - cur.windowStart > opts.windowMs) {
    await ref.set({ windowStart: now, count: 1 });
    return true;
  }
  if ((cur.count || 0) >= opts.limit) {
    return false;
  }
  await ref.update({ count: (cur.count || 0) + 1 });
  return true;
}

function sanitizeKey(k: string): string {
  return k.replace(/[.#$\[\]/]/g, '_').slice(0, 120);
}

export function hashIp(ip: string | undefined): string {
  if (!ip) return 'unknown';
  // Privacy-conscious: short sha256 prefix, not raw IP in audit-friendly form
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
}
